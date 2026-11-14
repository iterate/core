// Operations on a secret's stored private keys that never return the key: only a shared secret, a
// public key or a signature leaves, and none of them reveals the private.
import * as curve25519 from "curve25519-js";
import type { SecretMaterial } from "iterate/api";
import { codedError } from "iterate/lib";
import {
  base64url,
  type Envelope,
  fromBase64url,
  keyIdOf,
  signedP256,
  statementText,
} from "iterate/signed";
import { z } from "zod";
import { SecretKeyDerivationInput, secretMaterialStringOf } from "../secrets.ts";

// RFC 8410: `crypto.subtle` imports a raw X25519 private only wrapped in this PKCS8 DER prefix.
// allow-high-entropy-next-line: the fixed RFC 8410 PKCS8 DER prefix for X25519, a public constant, not a secret
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

// libsignal prefixes a public key with a 0x05 type byte that `crypto.subtle` does not accept.
function rawPublic(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length === 33 && bytes[0] === 0x05) return bytes.subarray(1);
  throw new Error(`key-ops: an X25519 public key is 32 bytes (or 0x05 + 32), got ${bytes.length}`);
}

export async function x25519SharedSecret(
  privateRaw: Uint8Array,
  peerPublic: Uint8Array,
): Promise<Uint8Array> {
  if (privateRaw.length !== 32)
    throw new Error(`key-ops: an X25519 private key is 32 bytes, got ${privateRaw.length}`);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(privateRaw)]),
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  const peer = await crypto.subtle.importKey(
    "raw",
    rawPublic(peerPublic),
    { name: "X25519" },
    false,
    [],
  );
  // workerd's generated deriveBits type names the peer key `$public`, but the runtime reads `public`;
  // the cast only renames that one field, and `peer` is a valid CryptoKey.
  const algorithm = { name: "X25519", public: peer } as unknown as Parameters<
    SubtleCrypto["deriveBits"]
  >[0];
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, 256));
}

export function x25519PublicKey(privateRaw: Uint8Array): Promise<Uint8Array> {
  const base = new Uint8Array(32);
  base[0] = 9;
  return x25519SharedSecret(privateRaw, base);
}

// XEdDSA with libsignal's own primitive (`Curve.sign`), deterministic like libsignal-node, so
// WhatsApp's check accepts the signature.
export function x25519Sign(privateRaw: Uint8Array, message: Uint8Array): Uint8Array {
  if (privateRaw.length !== 32)
    throw new Error(`key-ops: an X25519 private key is 32 bytes, got ${privateRaw.length}`);
  return curve25519.sign(privateRaw, message, undefined);
}

// Validated: these arrive on an untrusted expression.
const Hex = z.string().regex(/^([0-9a-fA-F]{2})*$/, "even-length hex");
// `field` is a dotted path into the secret's material, such as "noiseKey.private".
export const SecretKeyField = z.object({ field: z.string().min(1) });
export const SecretKeyAgreement = z.object({ field: z.string().min(1), peerPublicHex: Hex });
export const SecretKeySignature = z.object({ field: z.string().min(1), messageHex: Hex });

// A P-256 signing key's material and public fields: `generateSigningKey` in core/lib api.ts.
const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SigningMaterial = z.object({ privateKey: z.string() });
const PrivateJwk = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  d: z.string().min(1),
});

/** The P-256 JWK at `privateKey` of a signing secret's material, or undefined. */
function privateJwkOf(material: unknown) {
  const held = SigningMaterial.safeParse(material);
  try {
    return PrivateJwk.safeParse(held.success ? JSON.parse(held.data.privateKey) : undefined).data;
  } catch {
    return undefined;
  }
}

/** The key at `privateKey` of a signing secret's material, or a refusal that quotes none of it. */
export async function signingKeyOf(material: unknown) {
  const jwk = privateJwkOf(material);
  if (!jwk)
    throw new Error(
      'key-ops: a signing secret\'s material is { privateKey: "<a P-256 private JWK, as JSON>" }',
    );
  const { kty, crv, x, y, d } = jwk;
  const privateKey = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, P256, false, [
    "sign",
  ]);
  const spki = await crypto.subtle.exportKey(
    "spki",
    await crypto.subtle.importKey("jwk", { kty, crv, x, y }, P256, true, ["verify"]),
  );
  if (!(spki instanceof ArrayBuffer)) throw new Error("key-ops: an spki export answers bytes");
  const publicKey = base64url(new Uint8Array(spki));
  const keyId = await keyIdOf(publicKey);
  // `material`: what the secret keeps, the JWK's key fields alone beside its public half and id
  const text = JSON.stringify({ kty, crv, x, y, d });
  return { privateKey, publicKey, keyId, material: { privateKey: text, publicKey, keyId } };
}

/** A new key's material: made here, so its private half is never anywhere else. */
export async function generatedSigningMaterial(): Promise<{ privateKey: string }> {
  // the casts: ECDSA makes a pair, and a "jwk" export answers a JsonWebKey; the generated types
  // answer every algorithm's and every format's
  const pair = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
  const { kty, crv, x, y, d } = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as JsonWebKey;
  return { privateKey: JSON.stringify({ kty, crv, x, y, d }) };
}

const DAY_SECONDS = 24 * 3600;
export const SecretStatementInput = z.object({
  mind: z.string().min(1),
  path: z.string().startsWith("/"),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  about: z.array(z.string().min(1)).optional(),
  // a mind takes a statement that ends within a day (core/auth-worker keys.ts)
  expiresInSeconds: z.number().int().min(1).max(DAY_SECONDS).optional(),
});

/** The statement `input` asks for, signed by the key at `privateKey` of `material`: `at` is now. */
export async function signedStatement(
  material: unknown,
  input: z.infer<typeof SecretStatementInput>,
): Promise<Envelope> {
  const { expiresInSeconds = 300, ...fields } = input;
  const { privateKey, keyId } = await signingKeyOf(material);
  const at = Date.now();
  return signedP256(
    statementText({ ...fields, at, expires: at + expiresInSeconds * 1000 }),
    privateKey,
    keyId,
  );
}

/** A statement's path is inside one of `paths`, by whole segments, as a mind reads a key's paths
 *  (core/auth-worker key-rules.ts), and has no empty, `.` or `..` segment: the mind resolves those,
 *  so `/integrations/../secrets/x` would land outside. */
export function underStatementPaths(path: string, paths: readonly string[]): boolean {
  const segments = path.split("/").slice(1);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  return paths.some((prefix) => {
    const root = prefix.replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`);
  });
}

// ── keys derived from a secret's: `derive` of the HMAC operations, `seal` and `unseal`, as core/lib
// api.ts `SecretKeyDerivation` says ──

/** The 32-byte key HKDF-SHA256 derives for `info`, or null where the material holds no key. */
async function derivedKey(material: SecretMaterial, field: string | undefined, info: string) {
  const d = privateJwkOf(material)?.d;
  const text = secretMaterialStringOf(material, field);
  const bytes = d ? fromBase64url(d) : text && new TextEncoder().encode(text);
  if (!bytes) return null;
  const root = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]);
  const salt = new Uint8Array();
  const infoBytes = new TextEncoder().encode(info);
  const bits = { name: "HKDF", hash: "SHA-256", salt, info: infoBytes };
  return new Uint8Array(await crypto.subtle.deriveBits(bits, root, 256));
}

/** The HMAC key `signHmac` and `verifyHmac` take: the string at `field`, or the key derived from it. */
export async function hmacKeyOf(
  material: SecretMaterial,
  input: { field?: string; derive?: { info: string } },
): Promise<string | Uint8Array | null> {
  return input.derive
    ? derivedKey(material, input.field, input.derive.info)
    : secretMaterialStringOf(material, input.field);
}

export const SecretSealInput = SecretKeyDerivationInput.extend({
  plaintext: z.string(),
  field: z.string().min(1).optional(),
});
export const SecretUnsealInput = SecretKeyDerivationInput.extend({
  sealed: z.string(),
  field: z.string().min(1).optional(),
});

async function sealKeyOf(material: SecretMaterial, field: string | undefined, info: string) {
  const bytes = await derivedKey(material, field, info);
  if (!bytes) throw codedError("SECRET_NOT_SET", "seal: this secret holds no key at that field");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `sealed.<iv>.<ciphertext>`, each base64url: AES-256-GCM, a random 12-byte IV, no additional
 *  data. The iterate Cloud's sealed values have this form. */
export async function sealedText(
  material: SecretMaterial,
  { info, plaintext, field }: z.infer<typeof SecretSealInput>,
): Promise<string> {
  const key = await sealKeyOf(material, field, info);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const text = new TextEncoder().encode(plaintext);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, text);
  return `sealed.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

export async function unsealedText(
  material: SecretMaterial,
  { info, sealed, field }: z.infer<typeof SecretUnsealInput>,
): Promise<string> {
  const key = await sealKeyOf(material, field, info);
  const [, iv = "", text = ""] = sealed.split(".");
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv) },
      key,
      fromBase64url(text),
    );
    // ignoreBOM: a plaintext that starts with U+FEFF keeps it
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(opened);
  } catch {
    throw codedError("INVALID_INPUT", "unseal: the value does not open under this secret and info");
  }
}
