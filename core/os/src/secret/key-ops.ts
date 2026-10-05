// src/secret/key-ops.ts — operations on a secret's stored PRIVATE KEYS that never return the key.
// A long-term key (a WhatsApp device's Noise static key, its Signal identity key, a prekey) is only
// ever used in Diffie-Hellman and signing, and neither reveals the private, so the secret's facet
// can offer those operations and let userspace run the whole protocol (Noise, Signal) on the
// results. This is the macOS Secure Enclave model (`SecKeyCopyKeyExchangeResult` hands the app the
// shared secret; the private stays in the enclave) — the facet knows no protocol.
//
// A shared secret DOES leave: it is X25519(ourPrivate, theirPublic), from which userspace derives a
// session's keys. That lets the holder ACT as the device while it may use the secret, but never to
// take the key elsewhere or to act after access ends — X25519 does not leak the scalar, and a fresh
// session always needs another call here.
import * as curve25519 from "curve25519-js";
import { z } from "zod";

/** The 16-byte PKCS8 DER prefix for a raw X25519 private key (RFC 8410): `crypto.subtle` imports a
 *  raw private only wrapped this way. */
// allow-high-entropy-next-line: the fixed RFC 8410 PKCS8 DER prefix for X25519, a public constant, not a secret
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** A WhatsApp public key as the wire carries it — 32 raw bytes, or libsignal's 33 with a leading
 *  0x05 type byte that `crypto.subtle` does not accept. */
function rawPublic(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length === 33 && bytes[0] === 0x05) return bytes.subarray(1);
  throw new Error(`key-ops: an X25519 public key is 32 bytes (or 0x05 + 32), got ${bytes.length}`);
}

/** X25519 Diffie-Hellman: the shared secret of a stored private and a public on the wire. The
 *  private is imported, used, and dropped within this call; only the shared secret is returned. */
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

/** The X25519 public key of a stored private — X25519(private, base point 9) — so a caller never has
 *  to supply (and cannot mismatch) the public of a key the facet holds. */
export function x25519PublicKey(privateRaw: Uint8Array): Promise<Uint8Array> {
  const base = new Uint8Array(32);
  base[0] = 9;
  return x25519SharedSecret(privateRaw, base);
}

/** XEdDSA: a WhatsApp device signature with a stored private key — the account signature at pairing,
 *  and a signed-prekey signature. The private signs and is dropped; only the 64-byte signature is
 *  returned, and a signature does not reveal the key. This is `curve25519-js` — the exact primitive
 *  libsignal's `Curve.sign` uses — so a facet signature verifies under WhatsApp's own check by
 *  construction. The sign is deterministic (no random nonce), matching libsignal-node. */
export function x25519Sign(privateRaw: Uint8Array, message: Uint8Array): Uint8Array {
  if (privateRaw.length !== 32)
    throw new Error(`key-ops: an X25519 private key is 32 bytes, got ${privateRaw.length}`);
  return curve25519.sign(privateRaw, message, undefined); // no random nonce → deterministic, as libsignal-node
}

// ── the facet's input shapes (validated because they arrive on an untrusted expression) ──
const Hex = z.string().regex(/^([0-9a-fA-F]{2})*$/, "even-length hex");
/** Names one private key in the secret's object material, by a dotted field (e.g. "noiseKey.private"). */
export const SecretKeyField = z.object({ field: z.string().min(1) });
/** A Diffie-Hellman request: which stored private, and the peer public (hex) to agree with. */
export const SecretKeyAgreement = z.object({ field: z.string().min(1), peerPublicHex: Hex });
/** A signing request: which stored private, and the message (hex) to sign with XEdDSA. */
export const SecretKeySignature = z.object({ field: z.string().min(1), messageHex: Hex });
