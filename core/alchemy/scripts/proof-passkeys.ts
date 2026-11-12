// What the browser proofs share: a passkey added on /keys, and a software passkey lent to the
// browser's virtual authenticator.
import { readFileSync } from "node:fs";
import type { CDPSession, Page } from "playwright";
import { base64url, challengeOf, type Envelope, keyIdOf } from "iterate/signed";
import { z } from "zod";

/** Adds a passkey on /keys. A member who holds one confirms the new one with it, in a second press
 *  (core/auth-worker/src/signed-change.ts), and no device makes a second passkey for a person: so the new
 *  one and the old one are on two authenticators, and `touch` says which one answers a press.
 *  Answers how it was added. */
export async function addPasskey(
  page: Page,
  issuer: string,
  label: string,
  touch: { theNew?: () => Promise<unknown>; theOld?: () => Promise<unknown> } = {},
): Promise<string> {
  await page.goto(`${issuer}/keys`);
  await page.getByLabel("Name").fill(label);
  await touch.theNew?.();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const listed = page.locator("li", { hasText: label });
  const confirm = page.getByRole("button", { name: "Confirm with a passkey you have" });
  const said = async () => `the page says: ${await page.locator("#status").textContent()}`;
  await listed
    .or(confirm)
    .first()
    .waitFor()
    .catch(async () => {
      throw new Error(`the new passkey was not made; ${await said()}`);
    });
  const signed = await confirm.isVisible();
  if (signed) {
    await touch.theOld?.();
    await confirm.click();
    // The virtual authenticator at times answers a press with nothing ("No passkey was used"):
    // a person presses again, and so does this, once.
    const unanswered = page.locator("#status", { hasText: "No passkey was used" });
    await listed.or(unanswered).first().waitFor();
    if (await unanswered.isVisible()) await confirm.click();
  }
  await listed.waitFor().catch(async () => {
    throw new Error(`not listed; ${await said()}`);
  });
  return signed
    ? "a passkey the member holds signed it"
    : "the member's first, so nothing signs it";
}

/** A virtual authenticator that checks its user. `touched`: it answers each request by itself. */
export async function authenticator(
  cdp: CDPSession,
  transport: "internal" | "usb",
  touched: boolean,
) {
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: touched,
    },
  });
  return authenticatorId;
}

/** Whether a virtual authenticator answers: a person touches one key at a time. */
export const touched = (cdp: CDPSession, authenticatorId: string, enabled: boolean) =>
  cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled });

const PasskeyFile = z.object({
  credentialId: z.string(),
  privateKey: z.record(z.string(), z.unknown()),
});
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The id of the software passkey in `file`, as a page names it to the browser. */
export const credentialIdOf = (file: string) =>
  PasskeyFile.parse(JSON.parse(readFileSync(file, "utf8"))).credentialId;

/** A PRESS WITH NO BROWSER: the envelope that the software passkey in `file` makes for
 *  `statement`, as an authenticator that checked its user answers a page at `site`. A browser
 *  says by itself where a press was made, and refuses a relying party that is not its page's
 *  host; a proof that makes the press itself can say another origin or another relying party, to
 *  show that the server refuses it. `pressedFor`: the statement whose hash the press carries,
 *  when it is not the one that is sent. Prints nothing of the file. */
export async function pressedAt(
  file: string,
  statement: string,
  site: { origin: string; rpId: string },
  pressedFor = statement,
): Promise<Envelope> {
  const { privateKey } = PasskeyFile.parse(JSON.parse(readFileSync(file, "utf8")));
  const key = await crypto.subtle.importKey("jwk", privateKey, P256, false, ["sign"]);
  // the public half of the same key, whose hash is the key's id
  const half = z
    .object({ kty: z.string(), crv: z.string(), x: z.string(), y: z.string() })
    .parse(privateKey);
  const publicKey = await crypto.subtle.importKey("jwk", half, P256, true, ["verify"]);
  const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: await challengeOf(pressedFor),
      origin: site.origin,
      crossOrigin: false,
    }),
  );
  // rpIdHash, the flags (user present and verified), signCount
  const authenticatorData = Uint8Array.from([
    ...(await sha256(new TextEncoder().encode(site.rpId))),
    0x05,
    ...[0, 0, 0, 2],
  ]);
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Uint8Array.from([...authenticatorData, ...(await sha256(clientData))]),
    ),
  );
  // WebAuthn's signature is DER: two integers, each with no leading zeros and never negative
  const integer = (bytes: Uint8Array) => {
    const from = bytes.findIndex((byte) => byte !== 0);
    const digits = [...bytes.subarray(from === -1 ? bytes.length - 1 : from)];
    const body = digits[0]! & 0x80 ? [0, ...digits] : digits;
    return [0x02, body.length, ...body];
  };
  const [r, s] = [integer(raw.subarray(0, 32)), integer(raw.subarray(32))];
  return {
    statement,
    signature: {
      format: "webauthn",
      key: await keyIdOf(
        base64url(new Uint8Array(await crypto.subtle.exportKey("spki", publicKey))),
      ),
      sig: base64url(Uint8Array.from([0x30, r.length + s.length, ...r, ...s])),
      authenticatorData: base64url(authenticatorData),
      clientDataJSON: base64url(clientData),
    },
  };
}

/** Lends a virtual authenticator a software passkey from `file`, `{ credentialId, privateKey }`
 *  with the key as a JWK, so the browser signs as the member whose session a script opened with
 *  it. The browser never offers it by itself: a page must name it. Prints nothing of the file. */
export async function lendPasskey(
  cdp: CDPSession,
  authenticatorId: string,
  issuer: string,
  file: string,
) {
  const { credentialId, privateKey } = PasskeyFile.parse(JSON.parse(readFileSync(file, "utf8")));
  const key = await crypto.subtle.importKey("jwk", privateKey, P256, true, ["sign"]);
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: Buffer.from(credentialId, "base64url").toString("base64"),
      isResidentCredential: false,
      rpId: new URL(issuer).hostname,
      privateKey: Buffer.from(await crypto.subtle.exportKey("pkcs8", key)).toString("base64"),
      signCount: 1,
    },
  });
}
