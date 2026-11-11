// What the browser proofs share: a passkey added on /keys, and a software passkey lent to the
// browser's virtual authenticator.
import { readFileSync } from "node:fs";
import type { CDPSession, Page } from "playwright";
import { z } from "zod";

/** Adds a passkey on /keys. A member who holds one confirms the new one with it, in a second press
 *  (core/auth/src/signed-change.ts), and no device makes a second passkey for a person: so the new
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

/** Lends a virtual authenticator a software passkey from `file`, `{ credentialId, privateKey }`
 *  with the key as a JWK, so the browser signs as the member whose session a script opened with
 *  it. The browser never offers it by itself: a page must name it. Prints nothing of the file. */
export async function lendPasskey(
  cdp: CDPSession,
  authenticatorId: string,
  issuer: string,
  file: string,
) {
  const { credentialId, privateKey } = z
    .object({ credentialId: z.string(), privateKey: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(readFileSync(file, "utf8")));
  const curve = { name: "ECDSA", namedCurve: "P-256" } as const;
  const key = await crypto.subtle.importKey("jwk", privateKey, curve, true, ["sign"]);
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
