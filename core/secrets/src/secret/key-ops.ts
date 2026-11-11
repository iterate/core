// Operations on a secret's stored private keys that never return the key: only a shared secret, a
// public key or a signature leaves, and none of them reveals the private.
import * as curve25519 from "curve25519-js";
import { z } from "zod";

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
