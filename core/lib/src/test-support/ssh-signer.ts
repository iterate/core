// A software stand-in for `ssh-keygen -Y sign`, for tests: a key of one of OpenSSH's four types,
// made as the test runs, and its signature packed as OpenSSH packs an SSHSIG. A FIDO type is
// played by a software key that signs the frame a device signs. It is written apart from
// ../sshsig.ts on purpose: the reader and this writer share no code, so they agree only where
// both follow the format (PROTOCOL.sshsig and PROTOCOL.u2f of openssh-portable).

const KEY_TYPES = {
  Ed25519: { plain: "ssh-ed25519", fido: "sk-ssh-ed25519@openssh.com" },
  // allow-high-entropy-next-line: the name of an OpenSSH key type, not a key
  "P-256": { plain: "ecdsa-sha2-nistp256", fido: "sk-ecdsa-sha2-nistp256@openssh.com" },
};

/** A second spelling of an ECDSA scalar: with a leading zero that it does not need, or without
 *  the one that it needs, which reads as a negative number. */
type ScalarSpelling = "spare-zero" | "missing-zero";

/** A new key. With an `application` it is a FIDO (`sk-`) key. */
export async function newSshKey(algorithm: "Ed25519" | "P-256", application?: string) {
  const pair =
    algorithm === "Ed25519"
      ? await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])
      : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
          "sign",
          "verify",
        ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { algorithm, application, publicKey, privateKey: pair.privateKey };
}

/** The binary SSHSIG of `message` under `namespace`. Each option of `spoiled` breaks one rule of
 *  the strict reader and nothing else: the signature under it stays a true one. The blob names
 *  `key.publicKey` as its key, whatever key signs. */
export async function sshsigOf(
  key: Awaited<ReturnType<typeof newSshKey>>,
  message: Uint8Array<ArrayBuffer>,
  namespace: string,
  spoiled: {
    /** The device's flags: 0x01 a touch, 0x04 the person verified. */
    flags?: number;
    hash?: "sha512" | "sha256";
    reserved?: string;
    r?: ScalarSpelling;
    s?: ScalarSpelling;
    /** One more byte at the end of this value. `innermost` is the signature itself: Ed25519's 64
     *  bytes, or the two scalars of ECDSA. */
    longer?: "blob" | "key" | "signature" | "innermost";
  } = {},
) {
  const { flags = 0x01, hash = "sha512", reserved = "", r, s, longer } = spoiled;
  const extra = (value: typeof longer) => new Uint8Array(longer === value ? 1 : 0);
  const type = KEY_TYPES[key.algorithm][key.application ? "fido" : "plain"];
  const hashed = await crypto.subtle.digest(hash === "sha512" ? "SHA-512" : "SHA-256", message);
  let toSign = concat(
    utf8("SSHSIG"),
    string(namespace),
    string(reserved),
    string(hash),
    string(new Uint8Array(hashed)),
  );
  let device = new Uint8Array(0);
  if (key.application) {
    device = new Uint8Array([flags, 0, 0, 0, 7]);
    toSign = concat(await sha256(utf8(key.application)), device, await sha256(toSign));
  }
  const sign = async () =>
    new Uint8Array(
      await crypto.subtle.sign(
        key.algorithm === "Ed25519" ? "Ed25519" : { name: "ECDSA", hash: "SHA-256" },
        key.privateKey,
        toSign,
      ),
    );
  let signature = await sign();
  if (key.algorithm === "P-256") {
    // A zero can be spare only on a scalar that has none, and missing only on one that needs
    // it: a scalar whose first of 32 bytes is 01 to 7f, or 80 and above. ECDSA picks new
    // scalars for every signature, so this signs until both are of the kind asked for.
    const fits = (scalar: Uint8Array, spelling?: ScalarSpelling) => {
      if (!spelling) return true;
      return spelling === "missing-zero" ? scalar[0]! >= 0x80 : scalar[0]! > 0 && scalar[0]! < 0x80;
    };
    while (!fits(signature.subarray(0, 32), r) || !fits(signature.subarray(32), s))
      signature = await sign();
    const mpint = (scalar: Uint8Array, spelling?: ScalarSpelling) => {
      let at = 0;
      while (at < scalar.length - 1 && scalar[at] === 0) at++;
      const canonical = concat(new Uint8Array(scalar[at]! & 0x80 ? 1 : 0), scalar.subarray(at));
      if (spelling === "missing-zero") return string(canonical.subarray(1));
      return string(concat(new Uint8Array(spelling ? 1 : 0), canonical));
    };
    signature = concat(mpint(signature.subarray(0, 32), r), mpint(signature.subarray(32), s));
  }
  return concat(
    utf8("SSHSIG"),
    uint32(1),
    string(
      concat(
        string(type),
        key.algorithm === "P-256" ? string("nistp256") : new Uint8Array(0),
        string(key.publicKey),
        key.application ? string(key.application) : new Uint8Array(0),
        extra("key"),
      ),
    ),
    string(namespace),
    string(reserved),
    string(hash),
    string(
      concat(
        string(type),
        string(concat(signature, extra("innermost"))),
        device,
        extra("signature"),
      ),
    ),
    extra("blob"),
  );
}

const encoder = new TextEncoder();
const utf8 = (text: string) => encoder.encode(text);

function uint32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

/** SSH's `string`: a four-byte length, then the bytes. */
function string(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? utf8(value) : value;
  return concat(uint32(bytes.length), bytes);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
