// src/secret/key-ops.test.ts — the three key operations are correct and reject malformed public keys.
// The XEdDSA test checks the signature verifies under the key's X25519 public, the same check a
// Signal/WhatsApp peer makes, so a signature from here is byte-compatible with libsignal by construction.
import * as curve25519 from "curve25519-js";
import { expect, test } from "vitest";
import { x25519PublicKey, x25519SharedSecret, x25519Sign } from "./key-ops.ts";

test("X25519 agreement is symmetric: each side's shared secret matches", async () => {
  const aPriv = random32();
  const bPriv = random32();
  const aPub = await x25519PublicKey(aPriv);
  const bPub = await x25519PublicKey(bPriv);
  const ab = await x25519SharedSecret(aPriv, bPub);
  const ba = await x25519SharedSecret(bPriv, aPub);
  expect(Buffer.from(ab).toString("hex")).toBe(Buffer.from(ba).toString("hex"));
  expect(ab.length).toBe(32);
});

test("a public key is accepted raw (32) or libsignal-typed (0x05 + 32), and nothing else", async () => {
  const priv = random32();
  const raw = await x25519PublicKey(priv);
  const typed = Buffer.concat([Buffer.from([0x05]), raw]);
  // raw and typed name the same peer, so they agree to the same secret
  const peerPriv = random32();
  const viaRaw = await x25519SharedSecret(peerPriv, raw);
  const viaTyped = await x25519SharedSecret(peerPriv, typed);
  expect(Buffer.from(viaRaw).toString("hex")).toBe(Buffer.from(viaTyped).toString("hex"));
  await expect(x25519SharedSecret(peerPriv, new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  await expect(x25519SharedSecret(new Uint8Array(31), raw)).rejects.toThrow(
    /private key is 32 bytes/,
  );
});

test("XEdDSA: a signature from x25519Sign verifies under the key's X25519 public (what WhatsApp checks)", async () => {
  const priv = random32();
  const pub = await x25519PublicKey(priv);
  const message = crypto.getRandomValues(new Uint8Array(48));
  const sig = x25519Sign(priv, message);
  expect(sig.length).toBe(64);
  expect(curve25519.verify(pub, message, sig)).toBe(true);
  const tampered = Uint8Array.from(message);
  tampered[0] ^= 1;
  expect(curve25519.verify(pub, tampered, sig)).toBe(false);
});

const random32 = () => crypto.getRandomValues(new Uint8Array(32));
