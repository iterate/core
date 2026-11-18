// The signed statement: JSON text kept exactly as signed. The signature is over DSSE's
// pre-authentication encoding of that text, so nothing is canonicalized and nothing parses the text
// before the signature checks. A page's script cannot import this module, so it copies `signedBytes`.

export type Statement = {
  /** The mind it is for, by its control-plane hostname. */
  mind: string;
  /** The mind that signed it, by its control-plane hostname, with a working key that its identity
   *  log lists (./mind-identity-log.ts). Absent for a person's key or a service's. */
  from?: string;
  path: string;
  type: string;
  payload?: Record<string, unknown>;
  about?: string[];
  /** Ms since the epoch, by the signer's clock. */
  at: number;
  expires: number;
  nonce: string;
};

/** `key` is the key's id. A `p256` sig is r‖s; a `webauthn` sig is DER over
 *  `authenticatorData ‖ SHA-256(clientDataJSON)`, and its challenge is `challengeOf(statement)`.
 *  An `ML-DSA-65` sig is pure ML-DSA-65 (FIPS 204) with the empty context: a mind's working key,
 *  which its identity log lists (./mind-identity.ts). The format names the check, and a key is
 *  checked only under its own format. */
export type Signature =
  | { format: "p256"; key: string; sig: string }
  | { format: "ML-DSA-65"; key: string; sig: string }
  | {
      format: "webauthn";
      key: string;
      sig: string;
      authenticatorData: string;
      clientDataJSON: string;
    };

export type Envelope = { statement: string; signature: Signature };

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;
/** Node 24.7 and workerd with the flag `webcrypto_modern_algorithms` have it. */
const ML_DSA_65 = { name: "ML-DSA-65" } as const;
const encoder = new TextEncoder();

/** `"DSSEv1" SP len(type) SP type SP len(body) SP body`, lengths in bytes. The type is part of
 *  what is signed, so a signature over one type of text never passes as one over another: a
 *  mind's identity record has its own (./mind-identity.ts). */
export function signedBytes(
  statement: string,
  payloadType = "application/vnd.iterate.statement+json",
): Uint8Array<ArrayBuffer> {
  const body = encoder.encode(statement);
  const head = encoder.encode(
    `DSSEv1 ${encoder.encode(payloadType).length} ${payloadType} ${body.length} `,
  );
  return concat(head, body);
}

/** A KEY'S TOKEN (core/auth-worker/src/key-tokens.ts): a key that a member allowed to lend a
 *  capability posts a statement of this type at `/`, ending within five minutes, to this path of
 *  the mind's platform origin, and gets a token for the mind's API that lives an hour. */
export const KEY_TOKEN_STATEMENT_TYPE = "events.iterate.com/account/key-token-requested";
export const KEY_TOKEN_PATH = "/keys/token";
/** Where a key adds an event under its paths: the body is the envelope, the answer the event's key. */
export const STATEMENTS_PATH = "/statements";
/** THE PLATFORM'S OWN EVENT NAMESPACES, which no key adds through a statement: readers trust
 *  these types by type alone. The intake refuses them (core/auth-worker/src/statements.ts), and a
 *  mind's send leaves them out (core/mind-worker/src/context/minds.ts). */
export const PLATFORM_NAMESPACES = [
  "itx",
  "mind",
  "email",
  "webhook",
  "mcp",
  "account",
  "secret",
  "approval",
];

/** Where a mind publishes its stack's key, at its control-plane hostname: who gets a statement that the
 *  stack signed, iterate Cloud for one, reads the key there. core/auth-worker answers it. */
export const STACK_KEY_PATH = "/keys/stack.json";

/** What `STACK_KEY_PATH` answers. `publicKey` is the raw ML-DSA-65 public key, base64url, and
 *  `key` its id (iterate/mind-identity `identityKeyIdOf`). `listed`: whether the last accepted
 *  record of the mind's identity lists it as its working key for statements. Until then the key
 *  is a candidate: the stack signs nothing with it, and the owner's command lists it with a root
 *  key. */
export type StackKeyDocument = {
  mind: string;
  key: string;
  publicKey: string;
  algorithm: "ML-DSA-65";
  listed: boolean;
};

/** A mind's name as another mind writes it: its control-plane hostname, a lowercase DNS name. */
export const isMindControlPlaneHostname = (hostname: string) =>
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname);

export function statementText(fields: Omit<Statement, "nonce">): string {
  return JSON.stringify({
    ...fields,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
  });
}

export async function signedP256(
  statement: string,
  privateKey: Parameters<typeof crypto.subtle.sign>[1],
  key: string,
): Promise<Envelope> {
  const sig = await crypto.subtle.sign(ECDSA_SHA256, privateKey, signedBytes(statement));
  return { statement, signature: { format: "p256", key, sig: base64url(new Uint8Array(sig)) } };
}

/** `privateKey` is an ML-DSA-65 key. */
export async function signedMlDsa65(
  statement: string,
  privateKey: Parameters<typeof crypto.subtle.sign>[1],
  key: string,
): Promise<Envelope> {
  const sig = await crypto.subtle.sign(ML_DSA_65, privateKey, signedBytes(statement));
  return {
    statement,
    signature: { format: "ML-DSA-65", key, sig: base64url(new Uint8Array(sig)) },
  };
}

export async function challengeOf(statement: string): Promise<string> {
  return base64url(await sha256(signedBytes(statement)));
}

/** `publicKey` is SubjectPublicKeyInfo DER, base64url, as WebAuthn's `getPublicKey()` answers. */
export async function keyIdOf(publicKey: string): Promise<string> {
  return base64url(await sha256(fromBase64url(publicKey)));
}

export async function statementHashOf(statement: string): Promise<string> {
  return base64url(await sha256(statement));
}

/** Where a WebAuthn assertion must have been made. */
type Site = { origin: string; rpId: string };

/** `publicKey` is in the format's own form: for `p256` and `webauthn` SubjectPublicKeyInfo DER,
 *  for `ML-DSA-65` the raw public key, both base64url. A key of another algorithm does not import
 *  and is refused. `userVerified` is reported, never required: a security key with no PIN cannot
 *  say it. */
export async function verifySignature(
  envelope: Envelope,
  publicKey: string,
  site: Site,
): Promise<{ userVerified?: boolean } | { refused: string }> {
  try {
    if (envelope.signature.format === "ML-DSA-65") {
      const key = await crypto.subtle.importKey(
        // The format of an ML-DSA public key is `raw-public`, which Node and workerd take and
        // which TypeScript's DOM library does not list yet: the cast names a format that the
        // library knows, and the runtime gets the string as written.
        "raw-public" as "raw",
        fromBase64url(publicKey),
        ML_DSA_65,
        false,
        ["verify"],
      );
      const valid = await crypto.subtle.verify(
        ML_DSA_65,
        key,
        fromBase64url(envelope.signature.sig),
        signedBytes(envelope.statement),
      );
      return valid ? {} : { refused: "the signature is not this key's" };
    }
    const key = await crypto.subtle.importKey("spki", fromBase64url(publicKey), P256, false, [
      "verify",
    ]);
    const bytes = signedBytes(envelope.statement);
    const { signature } = envelope;
    if (signature.format === "p256") {
      const valid = await crypto.subtle.verify(
        ECDSA_SHA256,
        key,
        fromBase64url(signature.sig),
        bytes,
      );
      return valid ? {} : { refused: "the signature is not this key's" };
    }
    if (signature.format !== "webauthn") return { refused: "unknown signature format" };
    const clientDataBytes = fromBase64url(signature.clientDataJSON);
    const clientData: unknown = JSON.parse(new TextDecoder().decode(clientDataBytes));
    if (typeof clientData !== "object" || !clientData) return { refused: "malformed client data" };
    const { type, challenge, origin } = clientData as Record<string, unknown>;
    if (type !== "webauthn.get") return { refused: "the client data is not an assertion" };
    if (challenge !== (await challengeOf(envelope.statement)))
      return { refused: "the assertion is for another statement" };
    if (origin !== site.origin) return { refused: "the assertion was made on another origin" };
    const authenticatorData = fromBase64url(signature.authenticatorData);
    // rpIdHash (32 bytes), flags (1), signCount (4)
    if (authenticatorData.length < 37) return { refused: "malformed authenticator data" };
    const rpIdHash = base64url(authenticatorData.subarray(0, 32));
    if (rpIdHash !== base64url(await sha256(site.rpId)))
      return { refused: "the assertion is for another relying party" };
    const flags = authenticatorData[32]!;
    if (!(flags & 0x01)) return { refused: "the person was not present" };
    const raw = rawOfDer(fromBase64url(signature.sig));
    if (!raw) return { refused: "malformed DER signature" };
    const valid = await crypto.subtle.verify(
      ECDSA_SHA256,
      key,
      raw,
      concat(authenticatorData, await sha256(clientDataBytes)),
    );
    return valid
      ? { userVerified: Boolean(flags & 0x04) }
      : { refused: "the signature is not this key's" };
  } catch {
    return { refused: "malformed key or signature" };
  }
}

/** `value` as an envelope with no field but the envelope's, or null. */
export function envelopeOf(value: unknown): Envelope | null {
  const fields = (object: unknown) =>
    typeof object === "object" && !!object ? (object as Record<string, unknown>) : {};
  const { statement, signature } = fields(value);
  const { format, key, sig, authenticatorData, clientDataJSON } = fields(signature);
  if (typeof statement !== "string" || typeof key !== "string" || typeof sig !== "string")
    return null;
  if (format === "p256" || format === "ML-DSA-65")
    return { statement, signature: { format, key, sig } };
  if (
    format === "webauthn" &&
    typeof authenticatorData === "string" &&
    typeof clientDataJSON === "string"
  )
    return { statement, signature: { format, key, sig, authenticatorData, clientDataJSON } };
  return null;
}

/** Call it only after the signature checked. */
export function statementOf(text: string): Statement | { refused: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { refused: "the statement is not JSON" };
  }
  if (typeof parsed !== "object" || !parsed || Array.isArray(parsed))
    return { refused: "the statement is not an object" };
  const s = parsed as Record<string, unknown>;
  const string = (value: unknown) => typeof value === "string" && value.length > 0;
  const valid =
    string(s.mind) &&
    (!("from" in s) || string(s.from)) &&
    string(s.path) &&
    (s.path as string).startsWith("/") &&
    string(s.type) &&
    (!("payload" in s) ||
      (typeof s.payload === "object" && !!s.payload && !Array.isArray(s.payload))) &&
    (!("about" in s) || (Array.isArray(s.about) && s.about.every(string))) &&
    Number.isSafeInteger(s.at) &&
    Number.isSafeInteger(s.expires) &&
    string(s.nonce);
  return valid
    ? (parsed as Statement)
    : { refused: "the statement lacks a field, or has a wrong one" };
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` as WebCrypto's r‖s, or null. P-256's are at most 72
 *  bytes, so every length is one byte. */
function rawOfDer(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const raw = new Uint8Array(64);
  let at = 2;
  for (const offset of [0, 32]) {
    const length = der[at + 1];
    if (der[at] !== 0x02 || length === undefined || length < 1 || length > 33) return null;
    let integer = der.subarray(at + 2, at + 2 + length);
    if (integer.length !== length) return null;
    // a leading zero only when the next byte's top bit is set: DER's one spelling of a positive
    if (integer[0] === 0 && length > 1) {
      if (!(integer[1]! & 0x80)) return null;
      integer = integer.subarray(1);
    }
    if (integer.length > 32) return null;
    raw.set(integer, offset + 32 - integer.length);
    at += 2 + length;
  }
  return at === der.length ? raw : null;
}

async function sha256(data: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Unpadded. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Padded or not; throws on anything else. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error("not base64url");
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (character) =>
    character.charCodeAt(0),
  );
}
