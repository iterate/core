// sshsig.ts — A STRICT READER OF OPENSSH'S SSHSIG, with WebCrypto alone. `ssh-keygen -Y sign`
// makes the signature, with a key in a file, in an agent or on a FIDO device; a Worker checks it
// here, and stock `ssh-keygen -Y verify` checks the same bytes. The caller names the one key it
// expects, so the reader never learns a key from a signature. Strict means one spelling: the key
// in the blob is byte for byte the expected key, every length is checked, every nested value ends
// where its parent says, and the hash is `sha512`.
//
// A key must be a real key before anything is asked of it (`sshVerifyKeyOf`). WebCrypto's
// runtimes disagree on what they take: for Ed25519, workerd (BoringSSL) takes a second spelling
// of a point, the points of small order, under which a constant "signature" verifies with no
// private key, and a signature whose `R` is of small order; Node (OpenSSL) refuses all three
// (measured 2026-11-18, workerd 1.20261116.1 and Node 26.12). The rule here is the stricter one,
// so that every runtime gives one answer.
//
// The formats:
// - the blob and what a key signs:
//   https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig
// - a FIDO (`sk-`) key and its signature:
//   https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.u2f
// - a string, an mpint and an ECDSA signature: RFC 4251 section 5 and RFC 5656 section 3.1.2

/** The one key a signature must be made with. */
type SshsigKey = {
  algorithm: "Ed25519" | "P-256";
  /** The raw public key: Ed25519's 32 bytes, or P-256's uncompressed point of 65 bytes. */
  publicKey: Uint8Array<ArrayBuffer>;
  /** Present: a FIDO key (an `sk-` type) made for this application, such as `ssh:`. An empty
   *  application is no application and is refused: it must not read as "not a FIDO key". */
  application?: string;
};

/** Whether `blob`, the binary SSHSIG with no armor, is `key`'s signature of `message` under
 *  `namespace`. A FIDO key must report that a person touched the device; whether the device also
 *  verified the person (a PIN or a fingerprint) is answered, never required. A P-256 signature
 *  with a high `s` is taken, as OpenSSH takes it: a FIDO device does not make the low one. */
export async function verifySshsig({
  blob,
  message,
  namespace,
  key,
}: {
  blob: Uint8Array<ArrayBuffer>;
  message: Uint8Array<ArrayBuffer>;
  namespace: string;
  key: SshsigKey;
}): Promise<{ userVerified?: boolean } | { refused: string }> {
  const { publicKey, application } = key;
  const ed25519 = key.algorithm === "Ed25519";
  const verifyKey = await sshVerifyKeyOf(key.algorithm, publicKey);
  if (!verifyKey || application === "") return { refused: "the expected key is not a real key" };
  const type = utf8(KEY_TYPES[key.algorithm][application ? "fido" : "plain"]);
  const expectedKey = concat(
    sshString(type),
    ...(ed25519 ? [] : [sshString(utf8("nistp256"))]),
    sshString(publicKey),
    ...(application ? [sshString(utf8(application))] : []),
  );
  try {
    const outer = reader(blob);
    const magic = outer.take(6);
    if (!equal(magic, utf8("SSHSIG")) || outer.uint32() !== 1)
      return { refused: "not an SSHSIG of version 1" };
    const embeddedKey = outer.string();
    const embeddedNamespace = outer.string();
    const reserved = outer.string();
    const hash = outer.string();
    const inner = reader(outer.string());
    if (!outer.done()) return { refused: "bytes follow the signature" };
    if (!equal(embeddedKey, expectedKey)) return { refused: "the signature is another key's" };
    if (!equal(embeddedNamespace, utf8(namespace)))
      return { refused: "the signature is for another namespace" };
    if (reserved.length > 0) return { refused: "the reserved field is not empty" };
    if (!equal(hash, utf8("sha512"))) return { refused: "the hash is not sha512" };

    if (!equal(inner.string(), type)) return { refused: "the signature's type is not the key's" };
    const encoded = inner.string();
    let signed = concat(
      magic,
      sshString(embeddedNamespace),
      sshString(reserved),
      sshString(hash),
      sshString(await digest("SHA-512", message)),
    );
    let answer: { userVerified?: boolean } = {};
    if (application) {
      // The device signs its own frame around the hash of what OpenSSH asked it to sign. The
      // flags and the counter are in that frame, so the device vouches for them.
      const flags = inner.take(1);
      const counter = inner.take(4);
      if (!(flags[0]! & 0x01)) return { refused: "the device reports no touch" };
      answer = { userVerified: Boolean(flags[0]! & 0x04) };
      signed = concat(
        await digest("SHA-256", utf8(application)),
        flags,
        counter,
        await digest("SHA-256", signed),
      );
    }
    if (!inner.done()) return { refused: "bytes follow the signature" };

    let signature = encoded;
    if (!ed25519) {
      const scalars = reader(encoded);
      const r = scalarOf(scalars.string());
      const s = scalarOf(scalars.string());
      if (!r || !s || !scalars.done()) return { refused: "malformed ECDSA signature" };
      signature = concat(r, s);
    }
    if (signature.length !== 64) return { refused: "the signature has a wrong length" };
    if (ed25519 && !isEd25519Point(signature.subarray(0, 32)))
      return { refused: "the signature's R is not a point that a signature may have" };
    const valid = await crypto.subtle.verify(
      ed25519 ? "Ed25519" : { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      signature,
      signed,
    );
    if (!valid) return { refused: "the signature is not this key's" };
    return answer;
  } catch {
    // A length that runs past the end of its parent.
    return { refused: "malformed signature" };
  }
}

/** A REAL KEY, ready to verify with, or null: what a record may list and a signature may be
 *  checked under. P-256: the uncompressed point of 65 bytes, on the curve. WebCrypto's `raw`
 *  import also takes a compressed and a hybrid point, so the form is checked here. Ed25519: 32
 *  bytes that are the one spelling of a point of the curve that is not of small order
 *  (`isEd25519Point`). */
export async function sshVerifyKeyOf(
  algorithm: SshsigKey["algorithm"],
  publicKey: Uint8Array<ArrayBuffer>,
) {
  const ed25519 = algorithm === "Ed25519";
  const sound = ed25519
    ? publicKey.length === 32 && isEd25519Point(publicKey)
    : publicKey.length === 65 && publicKey[0] === 4;
  if (!sound) return null;
  // The import refuses a P-256 point that is not on the curve.
  return crypto.subtle
    .importKey(
      "raw",
      publicKey,
      ed25519 ? "Ed25519" : { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    .catch(() => null);
}

/** Whether 32 bytes are the ONE spelling of a point of Curve25519 that is not of small order.
 *  RFC 8032, 5.1.3: the bytes are `y`, little-endian, with the sign of `x` in the top bit.
 *  - `y` is below the prime: `y + p` is a second spelling of `y`.
 *  - The point is none of the eight of small order. They are `y` = 1 (the identity), -1, 0, and
 *    the four with `d y^4 + 2 y^2 = 1`: those double to a point with `y` = 0. A key of small
 *    order signs for everyone: `[k]A` is the identity for a share of all messages. This also
 *    refuses "negative zero", `x` = 0 with the sign set, since `x` = 0 only where `y` = 1 or -1.
 *  - An `x` exists: `(y^2 - 1) / (d y^2 + 1)` is a square, by Euler's criterion. */
function isEd25519Point(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let at = 31; at >= 0; at--)
    y = (y << 8n) | BigInt(at === 31 ? bytes[at]! & 0x7f : bytes[at]!);
  if (y >= ED25519_PRIME) return false;
  const yy = (y * y) % ED25519_PRIME;
  if (yy <= 1n) return false;
  if ((ED25519_D * yy * yy + 2n * yy - 1n) % ED25519_PRIME === 0n) return false;
  const xx = (yy - 1n) * (ED25519_D * yy + 1n);
  return powModPrime(xx, (ED25519_PRIME - 1n) / 2n) === 1n;
}

/** 2^255 - 19. */
const ED25519_PRIME = 2n ** 255n - 19n;
/** The curve's `d`, -121665/121666 (RFC 8032, 5.1). The inverse is by Fermat's little theorem. */
const ED25519_D =
  ((ED25519_PRIME - 121665n) * powModPrime(121666n, ED25519_PRIME - 2n)) % ED25519_PRIME;

function powModPrime(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let square = base % ED25519_PRIME;
  for (let bits = exponent; bits > 0n; bits >>= 1n) {
    if (bits & 1n) result = (result * square) % ED25519_PRIME;
    square = (square * square) % ED25519_PRIME;
  }
  return result;
}

const KEY_TYPES = {
  Ed25519: { plain: "ssh-ed25519", fido: "sk-ssh-ed25519@openssh.com" },
  // allow-high-entropy-next-line: the name of an OpenSSH key type, not a key
  "P-256": { plain: "ecdsa-sha2-nistp256", fido: "sk-ecdsa-sha2-nistp256@openssh.com" },
};

const encoder = new TextEncoder();
/** In an array over a buffer of its own: Cloudflare's types give `TextEncoder` a wider buffer
 *  type than WebCrypto's take, and a new array has the narrow one. */
const utf8 = (text: string) => new Uint8Array(encoder.encode(text));

/** SSH's `string`: a four-byte big-endian length, then that many bytes. */
function sshString(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length);
  return concat(length, bytes);
}

/** A cursor over SSH's wire form. A read that runs past the end throws, and `done` says whether
 *  the value ends exactly where the cursor stands. */
function reader(bytes: Uint8Array<ArrayBuffer>) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let at = 0;
  const take = (length: number) => {
    if (length > bytes.length - at) throw new Error("a length runs past the end");
    at += length;
    return bytes.subarray(at - length, at);
  };
  const uint32 = () => {
    take(4);
    return view.getUint32(at - 4);
  };
  return { take, uint32, string: () => take(uint32()), done: () => at === bytes.length };
}

/** An SSH `mpint` as a P-256 scalar of 32 bytes, or null. An mpint has one spelling: big-endian
 *  two's complement with no spare leading byte, so a positive number has a leading zero only when
 *  its next byte's top bit is set. A signature's scalar is positive and at most 32 bytes long. */
function scalarOf(mpint: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  if (mpint.length === 0 || mpint[0]! & 0x80) return null;
  const padded = mpint[0] === 0;
  if (padded && (mpint.length < 2 || !(mpint[1]! & 0x80))) return null;
  const magnitude = padded ? mpint.subarray(1) : mpint;
  if (magnitude.length > 32) return null;
  return concat(new Uint8Array(32 - magnitude.length), magnitude);
}

async function digest(algorithm: "SHA-256" | "SHA-512", bytes: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
