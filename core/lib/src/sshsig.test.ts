import { expect, test } from "vitest";
import { sshVerifyKeyOf, verifySshsig } from "./sshsig.ts";
import { newSshKey, sshsigOf } from "./test-support/ssh-signer.ts";

const NAMESPACE = "iterate-mind-identity";
const APPLICATION = "ssh:iterate-mind-root";
const NOT_A_KEY = { refused: "the expected key is not a real key" };
const encoder = new TextEncoder();
const message = encoder.encode("a record of the mind identity log");

test.for([
  { name: "an Ed25519 key", algorithm: "Ed25519", application: undefined, answer: {} },
  { name: "a P-256 key", algorithm: "P-256", application: undefined, answer: {} },
  {
    name: "an Ed25519 key on a FIDO device",
    algorithm: "Ed25519",
    application: APPLICATION,
    answer: { userVerified: false },
  },
  {
    name: "a P-256 key on a FIDO device",
    algorithm: "P-256",
    application: APPLICATION,
    answer: { userVerified: false },
  },
] as const)(
  "$name signs, and a changed message, another namespace and another key fail",
  async ({ algorithm, application, answer }) => {
    const key = await newSshKey(algorithm, application);
    const blob = await sshsigOf(key, message, NAMESPACE);
    expect(await verifySshsig({ blob, message, namespace: NAMESPACE, key })).toEqual(answer);
    expect(
      await verifySshsig({ blob, message: encoder.encode("another"), namespace: NAMESPACE, key }),
    ).toEqual({ refused: "the signature is not this key's" });
    expect(await verifySshsig({ blob, message, namespace: "file", key })).toEqual({
      refused: "the signature is for another namespace",
    });
    const other = await newSshKey(algorithm, application);
    expect(await verifySshsig({ blob, message, namespace: NAMESPACE, key: other })).toEqual({
      refused: "the signature is another key's",
    });
  },
);

test("a FIDO key says whether the device verified its person, and must report a touch", async () => {
  const key = await newSshKey("Ed25519", APPLICATION);
  const verified = await sshsigOf(key, message, NAMESPACE, { flags: 0x05 });
  expect(await verifySshsig({ blob: verified, message, namespace: NAMESPACE, key })).toEqual({
    userVerified: true,
  });
  const untouched = await sshsigOf(key, message, NAMESPACE, { flags: 0x04 });
  expect(await verifySshsig({ blob: untouched, message, namespace: NAMESPACE, key })).toEqual({
    refused: "the device reports no touch",
  });
});

test("a key signs only as the kind that is expected: its application, and FIDO or not", async () => {
  const key = await newSshKey("P-256", APPLICATION);
  const blob = await sshsigOf(key, message, NAMESPACE);
  const refused = { refused: "the signature is another key's" };
  const withApplication = (application?: string) =>
    verifySshsig({ blob, message, namespace: NAMESPACE, key: { ...key, application } });
  expect(await withApplication("ssh:")).toEqual(refused);
  // The same public key with no device around it: a signature made with no touch.
  expect(await withApplication(undefined)).toEqual(refused);
  const plain = await sshsigOf({ ...key, application: undefined }, message, NAMESPACE);
  expect(await verifySshsig({ blob: plain, message, namespace: NAMESPACE, key })).toEqual(refused);
  // An empty application is no application: it does not turn a FIDO key into a plain one.
  expect(
    await verifySshsig({
      blob: plain,
      message,
      namespace: NAMESPACE,
      key: { ...key, application: "" },
    }),
  ).toEqual(NOT_A_KEY);
});

test.for([
  {
    name: "a byte after the blob",
    algorithm: "P-256",
    spoiled: { longer: "blob" },
    refused: "bytes follow the signature",
  },
  {
    name: "a byte after the key",
    algorithm: "P-256",
    spoiled: { longer: "key" },
    refused: "the signature is another key's",
  },
  {
    name: "a byte after the signature's fields",
    algorithm: "P-256",
    spoiled: { longer: "signature" },
    refused: "bytes follow the signature",
  },
  {
    name: "a byte after the two ECDSA scalars",
    algorithm: "P-256",
    spoiled: { longer: "innermost" },
    refused: "malformed ECDSA signature",
  },
  {
    name: "an Ed25519 signature of 65 bytes",
    algorithm: "Ed25519",
    spoiled: { longer: "innermost" },
    refused: "the signature has a wrong length",
  },
  {
    name: "a spare zero on r",
    algorithm: "P-256",
    spoiled: { r: "spare-zero" },
    refused: "malformed ECDSA signature",
  },
  {
    name: "a spare zero on s",
    algorithm: "P-256",
    spoiled: { s: "spare-zero" },
    refused: "malformed ECDSA signature",
  },
  {
    name: "no sign zero on r",
    algorithm: "P-256",
    spoiled: { r: "missing-zero" },
    refused: "malformed ECDSA signature",
  },
  {
    name: "no sign zero on s",
    algorithm: "P-256",
    spoiled: { s: "missing-zero" },
    refused: "malformed ECDSA signature",
  },
  {
    name: "the hash sha256",
    algorithm: "P-256",
    spoiled: { hash: "sha256" },
    refused: "the hash is not sha512",
  },
  {
    name: "a reserved field that is not empty",
    algorithm: "P-256",
    spoiled: { reserved: "tag" },
    refused: "the reserved field is not empty",
  },
] as const)(
  "a true signature in a second spelling is refused: $name",
  async ({ algorithm, spoiled, refused }) => {
    for (const application of [undefined, APPLICATION]) {
      const key = await newSshKey(algorithm, application);
      const blob = await sshsigOf(key, message, NAMESPACE, spoiled);
      expect(await verifySshsig({ blob, message, namespace: NAMESPACE, key })).toEqual({ refused });
    }
  },
);

test("a blob that ends early is refused wherever it ends", async () => {
  const key = await newSshKey("Ed25519", APPLICATION);
  const blob = await sshsigOf(key, message, NAMESPACE);
  for (let length = 0; length < blob.length; length++) {
    const cut = await verifySshsig({
      blob: blob.slice(0, length),
      message,
      namespace: NAMESPACE,
      key,
    });
    expect(cut, `cut to ${length} bytes`).toHaveProperty("refused");
  }
});

// The eight points of small order, and other bytes that are no Ed25519 key. workerd verifies a
// constant signature under the first six with no private key; Node refuses them at the verify.
// The rule here answers before any runtime is asked, so the two agree.
test.for([
  { name: "the identity point", publicKey: ed25519Bytes(1, 0, 0) },
  {
    name: "the identity point with the sign set (negative zero)",
    publicKey: ed25519Bytes(1, 0, 0x80),
  },
  { name: "the identity point spelled y + p", publicKey: ed25519Bytes(0xee, 0xff, 0x7f) },
  { name: "the identity point spelled y + p, sign set", publicKey: ed25519Bytes(0xee, 0xff, 0xff) },
  { name: "the point of order 2", publicKey: ed25519Bytes(0xec, 0xff, 0x7f) },
  { name: "the point of order 2 with the sign set", publicKey: ed25519Bytes(0xec, 0xff, 0xff) },
  { name: "a point of order 4", publicKey: ed25519Bytes(0, 0, 0) },
  { name: "the other point of order 4", publicKey: ed25519Bytes(0, 0, 0x80) },
  {
    name: "a point of order 8",
    // allow-high-entropy-next-line: a public constant, a point of order 8 on Curve25519
    publicKey: fromHex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
  },
  {
    name: "a second point of order 8",
    // allow-high-entropy-next-line: a public constant, a point of order 8 on Curve25519
    publicKey: fromHex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85"),
  },
  {
    name: "a third point of order 8",
    // allow-high-entropy-next-line: a public constant, a point of order 8 on Curve25519
    publicKey: fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
  },
  {
    name: "a fourth point of order 8",
    // allow-high-entropy-next-line: a public constant, a point of order 8 on Curve25519
    publicKey: fromHex("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"),
  },
  { name: "the point with y = 3, spelled y + p", publicKey: ed25519Bytes(0xf0, 0xff, 0x7f) },
  { name: "y = 2, which is on no point of the curve", publicKey: ed25519Bytes(2, 0, 0) },
  { name: "31 bytes", publicKey: new Uint8Array(31).fill(3) },
])("$name is no Ed25519 key", async ({ publicKey }) => {
  expect(await sshVerifyKeyOf("Ed25519", publicKey)).toBeNull();
  // The reader asks the same before it reads the signature: the blob here names these bytes as
  // its key, and a true key signed it.
  const key = { ...(await newSshKey("Ed25519", APPLICATION)), publicKey };
  const blob = await sshsigOf(key, message, NAMESPACE);
  expect(await verifySshsig({ blob, message, namespace: NAMESPACE, key })).toEqual(NOT_A_KEY);
});

test("the point with y = 3 is an Ed25519 key, though nobody holds it", async () => {
  expect(await sshVerifyKeyOf("Ed25519", ed25519Bytes(3, 0, 0))).not.toBeNull();
});

test("a signature whose R is of small order is refused before the runtime is asked", async () => {
  const key = await newSshKey("Ed25519");
  const blob = await sshsigOf(key, message, NAMESPACE);
  // An Ed25519 signature is R, then S, and it ends the blob. A key's holder can make a true
  // signature with R the identity; workerd takes it and Node does not.
  blob.set(ed25519Bytes(1, 0, 0), blob.length - 64);
  expect(await verifySshsig({ blob, message, namespace: NAMESPACE, key })).toEqual({
    refused: "the signature's R is not a point that a signature may have",
  });
});

test.for([
  { name: "the compressed form", form: "compressed" },
  { name: "the hybrid form", form: "hybrid" },
  { name: "the uncompressed form of a point that is not on the curve", form: "off-curve" },
] as const)("a P-256 key in $name is no key", async ({ form }) => {
  const key = await newSshKey("P-256");
  const odd = key.publicKey[64]! & 1;
  const publicKey = {
    compressed: new Uint8Array([2 + odd, ...key.publicKey.subarray(1, 33)]),
    // WebCrypto's `raw` import takes this one, and verifies under it.
    hybrid: new Uint8Array([6 + odd, ...key.publicKey.subarray(1)]),
    "off-curve": new Uint8Array([...key.publicKey.subarray(0, 64), key.publicKey[64]! ^ 1]),
  }[form];
  expect(await sshVerifyKeyOf("P-256", publicKey)).toBeNull();
  const blob = await sshsigOf({ ...key, publicKey }, message, NAMESPACE);
  expect(
    await verifySshsig({ blob, message, namespace: NAMESPACE, key: { ...key, publicKey } }),
  ).toEqual(NOT_A_KEY);
});

// Two signatures that a YubiKey 5 made through `ssh-keygen -Y sign -n iterate-mind-identity`
// (OpenSSH 10.6) on 18 Nov 2026, with keys made on the device for that test alone: the base64
// field of each `.pub` line and the body of each `.sig` file. They are public test vectors.
test.for([
  {
    name: "Ed25519",
    algorithm: "Ed25519",
    publicKeyLine:
      // allow-high-entropy-next-line: a public key made for this test vector
      "AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIDWsJXRU50EPiavAytqfBuKGXxGAtd/E8DR7KI0MW3E1AAAAFXNzaDppdGVyYXRlLW1pbmQtcm9vdA==",
    signature:
      // allow-high-entropy-next-line: a signature by that key, a public test vector
      "U1NIU0lHAAAAAQAAAFsAAAAac2stc3NoLWVkMjU1MTlAb3BlbnNzaC5jb20AAAAgNawldFTnQQ+Jq8DK2p8G4oZfEYC138TwNHsojQxbcTUAAAAVc3NoOml0ZXJhdGUtbWluZC1yb290AAAAFWl0ZXJhdGUtbWluZC1pZGVudGl0eQAAAAAAAAAGc2hhNTEyAAAAZwAAABpzay1zc2gtZWQyNTUxOUBvcGVuc3NoLmNvbQAAAECq5J8cOeoJE7zh9PAvtL1YSZ+9XlfHaHUxam9YmzpHgpMr9eekmL3qQXK30BO7JUIOBpSnET+RL1CLKYkyjtoMAQAAAAU=",
  },
  {
    name: "P-256",
    algorithm: "P-256",
    publicKeyLine:
      // allow-high-entropy-next-line: a public key made for this test vector
      "AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBL2tTeN21n49NBkj0LP04HgDEtM1U5K2Dd3pd1FPxCqyVzmcRFzLUWXISxga52RXucrUyC5bwn/zEbMmh4JBwHwAAAAVc3NoOml0ZXJhdGUtbWluZC1yb290",
    signature:
      // allow-high-entropy-next-line: a signature by that key, a public test vector
      "U1NIU0lHAAAAAQAAAJAAAAAic2stZWNkc2Etc2hhMi1uaXN0cDI1NkBvcGVuc3NoLmNvbQAAAAhuaXN0cDI1NgAAAEEEva1N43bWfj00GSPQs/TgeAMS0zVTkrYN3el3UU/EKrJXOZxEXMtRZchLGBrnZFe5ytTILlvCf/MRsyaHgkHAfAAAABVzc2g6aXRlcmF0ZS1taW5kLXJvb3QAAAAVaXRlcmF0ZS1taW5kLWlkZW50aXR5AAAAAAAAAAZzaGE1MTIAAAB5AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAABKAAAAIQDTMBIKI8U43EkH47KSajL5dZyzDivSgXZn+16wQPgX8AAAACEAm70LDPc8hcR8aohi+baP00apf3J7QZ5nQjSnLxjrs24BAAAACQ==",
  },
] as const)(
  "a real YubiKey's $name signature verifies, and fails with one bit changed in any one byte",
  async ({ algorithm, publicKeyLine, signature }) => {
    const signedMessage = encoder.encode(
      "a record of the mind identity log, signed on 2026-11-18T13:34:01Z\n",
    );
    // The line holds the type, for P-256 the curve, the raw key and the application, in that order.
    const fields = sshStringsOf(bytesOf(publicKeyLine));
    const key = { algorithm, publicKey: fields.at(-2)!, application: APPLICATION };
    expect(new TextDecoder().decode(fields.at(-1))).toBe(APPLICATION);
    const blob = bytesOf(signature);
    const verify = (changed: Uint8Array<ArrayBuffer>) =>
      verifySshsig({ blob: changed, message: signedMessage, namespace: NAMESPACE, key });
    expect(await verify(blob)).toEqual({ userVerified: false });
    for (let at = 0; at < blob.length; at++) {
      const changed = blob.slice();
      changed[at]! ^= 0x01;
      expect(await verify(changed), `byte ${at} changed`).toHaveProperty("refused");
    }
  },
);

const bytesOf = (base64: string) =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

function fromHex(hex: string) {
  return Uint8Array.from(hex.match(/../g) || [], (byte) => Number.parseInt(byte, 16));
}

/** 32 bytes: `first`, then 30 of `middle`, then `last`. An Ed25519 point is `y`, little-endian,
 *  with the sign of `x` in the top bit of the last byte. */
function ed25519Bytes(first: number, middle: number, last: number) {
  return new Uint8Array([first, ...new Array<number>(30).fill(middle), last]);
}

/** The SSH strings that fill `bytes`: each a four-byte length, then that many bytes. */
function sshStringsOf(bytes: Uint8Array<ArrayBuffer>) {
  const strings = [];
  for (let at = 0; at < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
    strings.push(bytes.slice(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return strings;
}
