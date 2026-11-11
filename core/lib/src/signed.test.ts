import { expect, test } from "vitest";
import {
  base64url,
  challengeOf,
  type Envelope,
  keyIdOf,
  signedP256,
  statementOf,
  statementText,
  verifySignature,
} from "./signed.ts";

const SITE = { origin: "https://iterate.example.com", rpId: "iterate.example.com" };
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

test("a p256 statement verifies under its key, and a changed byte fails", async () => {
  const key = await newKey();
  const envelope = await signedP256(statement(), key.privateKey, key.id);
  expect(await verifySignature(envelope, key.publicKey, SITE)).toEqual({});
  const changed = { ...envelope, statement: envelope.statement.replace("opened", "closed") };
  expect(await verifySignature(changed, key.publicKey, SITE)).toHaveProperty("refused");
  expect(await verifySignature(envelope, (await newKey()).publicKey, SITE)).toHaveProperty(
    "refused",
  );
});

test("a WebAuthn assertion verifies, and says whether the person was verified", async () => {
  const key = await newKey();
  const text = statement();
  expect(await verifySignature(await signWebAuthn(key, text), key.publicKey, SITE)).toEqual({
    userVerified: false,
  });
  expect(
    await verifySignature(await signWebAuthn(key, text, { flags: 0x05 }), key.publicKey, SITE),
  ).toEqual({ userVerified: true });
});

test.each([
  ["another origin", { origin: "https://evil.example" }],
  ["another relying party", { rpId: "evil.example" }],
  ["no user present", { flags: 0x04 }],
  ["a wrong challenge", { challenge: base64url(new Uint8Array(32)) }],
  ["a registration's client data", { type: "webauthn.create" }],
])("a WebAuthn assertion with %s fails", async (_, spoiled) => {
  const key = await newKey();
  const envelope = await signWebAuthn(key, statement(), spoiled);
  expect(await verifySignature(envelope, key.publicKey, SITE)).toHaveProperty("refused");
});

test("a malformed DER signature is refused, not guessed at", async () => {
  const key = await newKey();
  const envelope = await signWebAuthn(key, statement());
  if (envelope.signature.format !== "webauthn") throw new Error("unreachable");
  const sig = base64url(new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x02, 0x00, 0x01]));
  expect(
    await verifySignature(
      { ...envelope, signature: { ...envelope.signature, sig } },
      key.publicKey,
      SITE,
    ),
  ).toEqual({ refused: "malformed DER signature" });
});

test("a statement parses only with every field", () => {
  const text = statement();
  expect(statementOf(text)).toMatchObject({ project: "example.com", path: "/integrations/github" });
  const { nonce: _, ...withoutNonce } = JSON.parse(text);
  expect(statementOf(JSON.stringify(withoutNonce))).toHaveProperty("refused");
  expect(statementOf(JSON.stringify({ ...withoutNonce, nonce: "n", path: "x" }))).toHaveProperty(
    "refused",
  );
  expect(statementOf("not json")).toHaveProperty("refused");
});

async function newKey() {
  const pair = await crypto.subtle.generateKey(P256, true, ["sign", "verify"]);
  const publicKey = base64url(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
  return { privateKey: pair.privateKey, publicKey, id: await keyIdOf(publicKey) };
}

const statement = () =>
  statementText({
    project: "example.com",
    path: "/integrations/github",
    type: "events.iterate.com/github/webhook-received",
    payload: { action: "opened" },
    at: Date.now(),
    expires: Date.now() + 60_000,
  });

/** A virtual authenticator. Each option spoils one binding. */
async function signWebAuthn(
  key: Awaited<ReturnType<typeof newKey>>,
  text: string,
  {
    flags = 0x01,
    origin = SITE.origin,
    rpId = SITE.rpId,
    type = "webauthn.get",
    challenge,
  }: { flags?: number; origin?: string; rpId?: string; type?: string; challenge?: string } = {},
): Promise<Envelope> {
  const clientDataJSON = encoder.encode(
    JSON.stringify({ type, challenge: challenge || (await challengeOf(text)), origin }),
  );
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
  const authenticatorData = new Uint8Array([...rpIdHash, flags, 0, 0, 0, 1]);
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      ECDSA_SHA256,
      key.privateKey,
      new Uint8Array([...authenticatorData, ...clientDataHash]),
    ),
  );
  return {
    statement: text,
    signature: {
      format: "webauthn",
      key: key.id,
      sig: base64url(derOf(raw)),
      authenticatorData: base64url(authenticatorData),
      clientDataJSON: base64url(clientDataJSON),
    },
  };
}

function derOf(raw: Uint8Array): Uint8Array {
  const integer = (half: Uint8Array) => {
    let at = 0;
    while (at < half.length - 1 && half[at] === 0) at++;
    const bytes = half.subarray(at);
    const positive = bytes[0]! & 0x80 ? [0, ...bytes] : [...bytes];
    return [0x02, positive.length, ...positive];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}
