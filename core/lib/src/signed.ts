// The signed statement: JSON text kept exactly as signed. The signature is over DSSE's
// pre-authentication encoding of that text, so nothing is canonicalized and nothing parses the text
// before the signature checks. A page's script cannot import this module, so it copies `signedBytes`.

export type Statement = {
  /** The project's domain. */
  project: string;
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
 *  `authenticatorData ‖ SHA-256(clientDataJSON)`, and its challenge is `challengeOf(statement)`. */
export type Signature =
  | { format: "p256"; key: string; sig: string }
  | {
      format: "webauthn";
      key: string;
      sig: string;
      authenticatorData: string;
      clientDataJSON: string;
    };

export type Envelope = { statement: string; signature: Signature };

const STATEMENT_PAYLOAD_TYPE = "application/vnd.iterate.statement+json";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;
const encoder = new TextEncoder();

/** `"DSSEv1" SP len(type) SP type SP len(body) SP body`, lengths in bytes. */
export function signedBytes(statement: string): Uint8Array<ArrayBuffer> {
  const body = encoder.encode(statement);
  const head = encoder.encode(
    `DSSEv1 ${encoder.encode(STATEMENT_PAYLOAD_TYPE).length} ${STATEMENT_PAYLOAD_TYPE} ${body.length} `,
  );
  return concat(head, body);
}

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

/** `userVerified` is reported, never required: a security key with no PIN cannot say it. */
export async function verifySignature(
  envelope: Envelope,
  publicKey: string,
  site: Site,
): Promise<{ userVerified?: boolean } | { refused: string }> {
  try {
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
  if (format === "p256") return { statement, signature: { format, key, sig } };
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
    string(s.project) &&
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
