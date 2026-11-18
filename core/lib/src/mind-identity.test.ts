import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
  canVerifyMlDsa65,
  type IdentityRecord,
  identityHashOf,
  identityKeyIdOf,
  identityRecordText,
  type IdentityState,
  nextIdentity,
  signIdentityRecord,
} from "./mind-identity.ts";
import { base64url, signedBytes } from "./signed.ts";
import { newSshKey, sshsigOf } from "./test-support/ssh-signer.ts";

const encoder = new TextEncoder();
/** 16 signatures, a key id of 43 characters and a signature of 4412 are the most a record has. */
const KEY_ID = "A".repeat(43);

test("a genesis is accepted, and its hash is the mind id", async () => {
  const laptop = await newRawKey("laptop");
  const text = genesisText([laptop]);
  const mind = createHash("sha256").update(text).digest("hex");
  expect(await identityHashOf(text)).toBe(mind);
  // `toEqual`: the answer is exactly the new state and the one signer.
  expect(await nextIdentity(unborn(mind), await signed(text, [laptop]))).toEqual({
    state: { expected: mind, head: mind, position: 1, current: JSON.parse(text) },
    signedBy: [{ key: laptop.id, label: "laptop", algorithm: "ML-DSA-65", signs: "raw" }],
  });
});

test("a record signed with no constant of the library's is accepted: the bytes are pinned here", async () => {
  // Every constant of the format is written out here: the namespace, the payload type, the DSSE
  // framing, the key id and the hash. A change to one of them in the library fails this test.
  const laptop = await newRawKey("laptop");
  const agent = await newSshKey("P-256");
  const device = await newSshKey("Ed25519", "ssh:iterate-mind-root");
  const idOf = (publicKey: Uint8Array) =>
    createHash("sha256").update(publicKey).digest("base64url");
  const text = JSON.stringify({
    version: 1,
    prev: null,
    nonce: "AAECAwQFBgcICQoLDA0ODw",
    rootKeys: [
      { ...laptop.entry, attestation: "AAEC" },
      {
        signs: "sshsig",
        algorithm: "P-256",
        publicKey: base64url(agent.publicKey),
        label: "agent",
      },
      {
        signs: "sshsig",
        algorithm: "Ed25519",
        publicKey: base64url(device.publicKey),
        application: "ssh:iterate-mind-root",
        label: "YubiKey 5C",
      },
    ],
    threshold: 3,
    workingKeys: [],
    hostnames: ["mind.example.com", "example.org"],
    alsoKnownAs: ["did:plc:example", "nostr:npub1example"],
  });
  const textBytes = encoder.encode(text);
  const type = "application/vnd.iterate.mind-identity+json";
  const dsse = encoder.encode(`DSSEv1 ${type.length} ${type} ${textBytes.length} ${text}`);
  const signatures = [
    {
      key: idOf(Buffer.from(laptop.entry.publicKey, "base64url")),
      sig: base64url(
        new Uint8Array(await crypto.subtle.sign({ name: "ML-DSA-65" }, laptop.privateKey, dsse)),
      ),
    },
    {
      key: idOf(agent.publicKey),
      sig: base64url(await sshsigOf(agent, textBytes, "iterate-mind-identity")),
    },
    {
      key: idOf(device.publicKey),
      sig: base64url(await sshsigOf(device, textBytes, "iterate-mind-identity", { flags: 0x05 })),
    },
  ];
  const mind = createHash("sha256").update(textBytes).digest("hex");
  // `toEqual`: the state and the three signers, with nothing more and nothing less.
  expect(await nextIdentity(unborn(mind), { record: text, signatures })).toEqual({
    state: { expected: mind, head: mind, position: 1, current: JSON.parse(text) },
    signedBy: [
      { key: signatures[0]!.key, label: "laptop", algorithm: "ML-DSA-65", signs: "raw" },
      { key: signatures[1]!.key, label: "agent", algorithm: "P-256", signs: "sshsig" },
      {
        key: signatures[2]!.key,
        label: "YubiKey 5C",
        algorithm: "Ed25519",
        signs: "sshsig",
        userVerified: true,
      },
    ],
  });
});

test("a genesis that hashes to another id is refused", async () => {
  const laptop = await newRawKey("laptop");
  const text = genesisText([laptop]);
  const other = await identityHashOf(genesisText([laptop]));
  expect(await nextIdentity(unborn(other), await signed(text, [laptop]))).toEqual({
    reason: "wrong-genesis",
    message: "The genesis does not hash to the expected mind id.",
    signedByCurrentRoot: false,
  });
});

test.for([
  {
    name: "a spare space",
    spoil: (text: string) => text.replace("{", "{ "),
    reason: "text-not-canonical",
  },
  {
    name: "a duplicate name",
    spoil: (text: string) => text.replace('"version":1,', '"version":1,"version":1,'),
    reason: "text-not-canonical",
  },
  {
    name: "an escape that JSON does not need",
    spoil: (text: string) => text.replace("laptop", "lap\\/top"),
    reason: "text-not-canonical",
  },
  {
    name: "an unknown field",
    spoil: (text: string) => JSON.stringify({ ...JSON.parse(text), extra: 1 }),
    reason: "record-not-valid",
  },
  {
    name: "a hostname with a capital",
    spoil: (text: string) => text.replace("mind.example.com", "Mind.example.com"),
    reason: "record-not-valid",
  },
  {
    name: "bytes in a second spelling",
    // A nonce of 16 bytes ends in a character that holds two bits; `Z` sets the four spare ones.
    spoil: (text: string) => text.replace(/("nonce":"[\w-]{21})[\w-]/, "$1Z"),
    reason: "record-not-valid",
  },
  {
    name: "a label that is a lone surrogate, spelled as JSON's escape",
    // The text is ASCII and JavaScript writes the same escape back, so only the schema sees it.
    spoil: (text: string) => text.replace("laptop", `${String.fromCharCode(92)}ud800`),
    reason: "record-not-valid",
  },
  {
    name: "an application that is no ssh application",
    spoil: (text: string) => text.replace('"application":"ssh:', '"application":"web:'),
    reason: "record-not-valid",
  },
  {
    name: "a working key's purpose with a capital",
    spoil: (text: string) => text.replace('"purpose":"statements"', '"purpose":"Statements"'),
    reason: "record-not-valid",
  },
  {
    name: "an attestation of more than 22000 characters",
    spoil: (text: string) =>
      text.replace('"attestation":"AAEC"', `"attestation":"${"A".repeat(22_004)}"`),
    reason: "record-not-valid",
  },
  {
    name: "a link that is no URI",
    spoil: (text: string) => text.replace("did:plc:example", "no scheme"),
    reason: "record-not-valid",
  },
])("a text with $name is refused, though truly signed", async ({ spoil, reason }) => {
  const laptop = await newRawKey("laptop");
  const yubikey = await newFidoKey("YubiKey");
  const working = { ...(await newRawKey("stack")).entry, purpose: "statements" };
  // A record that has one of every field, so that each row has its field to spoil.
  const whole = identityRecordText({
    ...JSON.parse(genesisText([laptop, yubikey])),
    rootKeys: [{ ...laptop.entry, attestation: "AAEC" }, yubikey.entry],
    workingKeys: [working],
    alsoKnownAs: ["did:plc:example"],
  });
  const text = spoil(whole);
  expect(text).not.toBe(whole);
  const before = unborn(await identityHashOf(text));
  expect(await nextIdentity(before, await signed(text, [laptop]))).toMatchObject({ reason });
});

test.for([
  {
    name: "a threshold above the number of root keys",
    change: (): Partial<IdentityRecord> => ({ threshold: 2 }),
    reason: "threshold-unreachable",
  },
  {
    name: "no ML-DSA-65 root key",
    change: ({ yubikey }: GenesisKeys): Partial<IdentityRecord> => ({ rootKeys: [yubikey.entry] }),
    reason: "no-ml-dsa-root-key",
  },
  {
    name: "a key listed twice",
    change: ({ laptop }: GenesisKeys): Partial<IdentityRecord> => ({
      rootKeys: [laptop.entry, { ...laptop.entry, label: "again" }],
    }),
    reason: "key-twice",
  },
  {
    name: "a public key of a wrong length",
    change: ({ laptop, yubikey }: GenesisKeys): Partial<IdentityRecord> => ({
      rootKeys: [laptop.entry, { ...yubikey.entry, publicKey: base64url(new Uint8Array(33)) }],
    }),
    reason: "key-length",
  },
  {
    name: "a P-256 key that is no point of the curve",
    change: ({ laptop }: GenesisKeys): Partial<IdentityRecord> => ({
      rootKeys: [
        laptop.entry,
        {
          signs: "sshsig",
          algorithm: "P-256",
          publicKey: base64url(new Uint8Array(65)),
          label: "dead",
        },
      ],
    }),
    reason: "key-not-valid",
  },
  {
    name: "an Ed25519 key that is the identity point",
    change: ({ laptop, yubikey }: GenesisKeys): Partial<IdentityRecord> => ({
      rootKeys: [
        laptop.entry,
        { ...yubikey.entry, publicKey: base64url(new Uint8Array([1, ...new Uint8Array(31)])) },
      ],
    }),
    reason: "key-not-valid",
  },
  {
    name: "a working key",
    change: ({ working }: GenesisKeys): Partial<IdentityRecord> => ({ workingKeys: [working] }),
    reason: "genesis-working-key",
  },
  {
    name: "no nonce",
    change: (): Partial<IdentityRecord> => ({ nonce: undefined }),
    reason: "nonce",
  },
  {
    name: "a nonce of 15 bytes",
    change: (): Partial<IdentityRecord> => ({ nonce: base64url(new Uint8Array(15)) }),
    reason: "nonce",
  },
])("a genesis with $name is refused", async ({ change, reason }) => {
  const keys = {
    laptop: await newRawKey("laptop"),
    yubikey: await newFidoKey("YubiKey"),
    working: { ...(await newRawKey("stack")).entry, purpose: "statements" },
  };
  const record: IdentityRecord = { ...JSON.parse(genesisText([keys.laptop])), ...change(keys) };
  const text = identityRecordText(record);
  const before = unborn(await identityHashOf(text));
  // Every root key that the record lists signs it, so only the rule under test refuses it.
  const signers = [keys.laptop, keys.yubikey].filter((key) =>
    record.rootKeys.some((listed) => listed.publicKey === key.entry.publicKey),
  );
  expect(await nextIdentity(before, await signed(text, signers))).toMatchObject({ reason });
});

test.for([
  {
    name: "a root key as a working key",
    change: ({ laptop }: LaterKeys): Partial<IdentityRecord> => ({
      workingKeys: [{ ...laptop.entry, purpose: "statements" }],
    }),
    reason: "key-twice",
  },
  {
    name: "a working key of a wrong length",
    change: ({ laptop }: LaterKeys): Partial<IdentityRecord> => ({
      workingKeys: [{ ...laptop.entry, publicKey: base64url(new Uint8Array(1951)), purpose: "x" }],
    }),
    reason: "key-length",
  },
  {
    name: "a nonce",
    change: (): Partial<IdentityRecord> => ({ nonce: base64url(new Uint8Array(16)) }),
    reason: "nonce",
  },
  {
    name: "a FIDO key that stays, listed for another application",
    change: ({ laptop, yubikey }: LaterKeys): Partial<IdentityRecord> => ({
      rootKeys: [laptop.entry, { ...yubikey.entry, application: "ssh:" }],
    }),
    reason: "key-changed",
  },
  {
    name: "a FIDO key that stays, listed as a key in an agent",
    change: ({ laptop, yubikey }: LaterKeys): Partial<IdentityRecord> => ({
      rootKeys: [laptop.entry, { ...yubikey.entry, application: undefined }],
    }),
    reason: "key-changed",
  },
])("a later record with $name is refused", async ({ change, reason }) => {
  const keys = { laptop: await newRawKey("laptop"), yubikey: await newFidoKey("YubiKey") };
  const state = await born([keys.laptop, keys.yubikey]);
  const text = laterText(state, change(keys));
  expect(await nextIdentity(state, await signed(text, [keys.laptop, keys.yubikey]))).toMatchObject({
    reason,
    signedByCurrentRoot: true,
  });
});

test("a key that stays may get a new label and a new attestation", async () => {
  const laptop = await newRawKey("laptop");
  const yubikey = await newFidoKey("YubiKey");
  const state = await born([laptop, yubikey]);
  const text = laterText(state, {
    rootKeys: [
      { ...laptop.entry, label: "old laptop", attestation: "AAEC" },
      { ...yubikey.entry, label: "desk key" },
    ],
  });
  expect(await nextIdentity(state, await signed(text, [laptop, yubikey]))).toMatchObject({
    signedBy: [{ label: "old laptop" }, { label: "desk key", userVerified: false }],
  });
});

test("a later record with too few signatures of the old keys is refused", async () => {
  const [laptop, words, fresh] = await Promise.all(["laptop", "words", "fresh"].map(newRawKey));
  const state = await born([laptop!, words!], 2);
  const text = laterText(state, { rootKeys: [laptop!.entry, fresh!.entry], threshold: 1 });
  expect(await nextIdentity(state, await signed(text, [laptop!, fresh!]))).toEqual({
    reason: "too-few-old-signatures",
    message: "Too few root keys of the last accepted record signed.",
    signedByCurrentRoot: true,
  });
});

test("a later record with too few signatures of its own keys is refused", async () => {
  const [laptop, fresh] = await Promise.all(["laptop", "fresh"].map(newRawKey));
  const state = await born([laptop!]);
  const text = laterText(state, { rootKeys: [laptop!.entry, fresh!.entry], threshold: 2 });
  expect(await nextIdentity(state, await signed(text, [laptop!]))).toMatchObject({
    reason: "too-few-new-signatures",
  });
});

test("a later record needs an ML-DSA-65 signature on the old side and on the new side", async () => {
  const [laptop, fresh] = await Promise.all(["laptop", "fresh"].map(newRawKey));
  const yubikey = await newFidoKey("YubiKey");
  const state = await born([laptop!, yubikey]);
  const text = laterText(state, { rootKeys: [yubikey.entry, fresh!.entry] });
  // The device counts on both sides; the ML-DSA-65 key that signs is on one side only.
  expect(await nextIdentity(state, await signed(text, [yubikey, fresh!]))).toMatchObject({
    reason: "no-ml-dsa-old-signature",
  });
  expect(await nextIdentity(state, await signed(text, [yubikey, laptop!]))).toMatchObject({
    reason: "no-ml-dsa-new-signature",
  });
  expect(await nextIdentity(state, await signed(text, [yubikey, laptop!, fresh!]))).toMatchObject({
    state: { position: 2 },
    signedBy: [
      { label: "laptop", signs: "raw" },
      { label: "YubiKey", algorithm: "Ed25519", signs: "sshsig", userVerified: false },
      { label: "fresh", signs: "raw" },
    ],
  });
});

test("one signature of a key that stays counts on both sides", async () => {
  const [laptop, fresh] = await Promise.all(["laptop", "fresh"].map(newRawKey));
  const state = await born([laptop!]);
  const text = laterText(state, {
    rootKeys: [{ ...laptop!.entry, label: "old laptop" }, fresh!.entry],
  });
  // `toEqual`: one signer, named once, with the label that this record gives it.
  expect(await nextIdentity(state, await signed(text, [laptop!]))).toEqual({
    state: {
      expected: state.expected,
      head: await identityHashOf(text),
      position: 2,
      current: JSON.parse(text),
    },
    signedBy: [{ key: laptop!.id, label: "old laptop", algorithm: "ML-DSA-65", signs: "raw" }],
  });
});

test.for([
  {
    name: "a new key's signature of another text",
    extra: ({ fresh, text }: ExtraSigners) => fresh.sign(`${text} `),
    reason: "bad-signature",
  },
  {
    name: "a new key's signature of the text as a statement",
    // A statement's signature is over the same text under another payload type.
    extra: async ({ fresh, text }: ExtraSigners) => ({
      key: fresh.id,
      sig: base64url(
        new Uint8Array(
          await crypto.subtle.sign({ name: "ML-DSA-65" }, fresh.privateKey, signedBytes(text)),
        ),
      ),
    }),
    reason: "bad-signature",
  },
  {
    name: "a signature of another text by a key that leaves",
    extra: ({ words, text }: ExtraSigners) => words.sign(`${text} `),
    reason: "bad-signature",
  },
  {
    name: "a true signature by a key of neither record",
    extra: ({ stranger, text }: ExtraSigners) => stranger.sign(text),
    reason: "unknown-signer",
  },
  {
    name: "a second signature by a key that already signed",
    extra: ({ laptop, text }: ExtraSigners) => laptop.sign(text),
    reason: "signer-twice",
  },
])("a record with enough signatures is refused for one more: $name", async ({ extra, reason }) => {
  const [laptop, words, fresh, stranger] = await Promise.all(
    ["laptop", "words", "fresh", "stranger"].map(newRawKey),
  );
  const state = await born([laptop!, words!]);
  const text = laterText(state, { rootKeys: [laptop!.entry, fresh!.entry] });
  const enough = await signed(text, [laptop!]);
  expect(await nextIdentity(state, enough)).toMatchObject({ state: { position: 2 } });
  const one = await extra({
    laptop: laptop!,
    words: words!,
    fresh: fresh!,
    stranger: stranger!,
    text,
  });
  expect(
    await nextIdentity(state, { record: text, signatures: [...enough.signatures, one] }),
  ).toMatchObject({ reason });
});

test("one key's signature twice does not reach a threshold of two", async () => {
  const [laptop, words] = await Promise.all(["laptop", "words"].map(newRawKey));
  const state = await born([laptop!, words!], 2);
  const text = laterText(state, { hostnames: ["mind.example.org"] });
  const once = await laptop!.sign(text);
  expect(await nextIdentity(state, { record: text, signatures: [once, once] })).toMatchObject({
    reason: "signer-twice",
    signedByCurrentRoot: false,
  });
  expect(await nextIdentity(state, { record: text, signatures: [once] })).toMatchObject({
    reason: "too-few-old-signatures",
    signedByCurrentRoot: true,
  });
});

test("a FIDO key's signature says whether the person was verified, and needs a touch", async () => {
  const laptop = await newRawKey("laptop");
  const yubikey = await newFidoKey("YubiKey");
  const state = await born([laptop, yubikey]);
  const text = laterText(state, { hostnames: ["mind.example.org"] });
  const signaturesWith = async (flags: number) => ({
    record: text,
    signatures: [await laptop.sign(text), await yubikey.sign(text, { flags })],
  });
  expect(await nextIdentity(state, await signaturesWith(0x05))).toMatchObject({
    signedBy: [{ label: "laptop" }, { label: "YubiKey", userVerified: true }],
  });
  expect(await nextIdentity(state, await signaturesWith(0x04))).toMatchObject({
    reason: "bad-signature",
  });
});

test("the threshold falls only by a record that the old threshold signed", async () => {
  const [laptop, words] = await Promise.all(["laptop", "words"].map(newRawKey));
  const state = await born([laptop!, words!], 2);
  const lower = laterText(state, { threshold: 1 });
  expect(await nextIdentity(state, await signed(lower, [laptop!]))).toMatchObject({
    reason: "too-few-old-signatures",
  });
  const lowered = await accepted(state, await signed(lower, [laptop!, words!]));
  const alone = laterText(lowered, { hostnames: ["mind.example.org"] });
  expect(await nextIdentity(lowered, await signed(alone, [words!]))).toMatchObject({
    state: { position: 3, current: { threshold: 1, hostnames: ["mind.example.org"] } },
  });
});

test("the log's last record is known by its hash alone; an older one is for the caller to know", async () => {
  const laptop = await newRawKey("laptop");
  const genesis = genesisText([laptop]);
  const first = await accepted(
    unborn(await identityHashOf(genesis)),
    await signed(genesis, [laptop]),
  );
  const working = { ...(await newRawKey("stack")).entry, purpose: "statements" };
  const second = laterText(first, { workingKeys: [working] });
  const third = laterText(await accepted(first, await signed(second, [laptop])), {
    // A purpose that this reader does not know is passed over.
    workingKeys: [working, { ...(await newRawKey("relay")).entry, purpose: "nostr" }],
  });
  const state = await accepted(
    await accepted(first, await signed(second, [laptop])),
    await signed(third, [laptop]),
  );
  expect(state).toMatchObject({ position: 3 });
  // The signature that comes with a known record is not read: the caller holds the true ones.
  expect(
    await nextIdentity(state, { record: third, signatures: [{ key: KEY_ID, sig: "AA" }] }),
  ).toEqual({ known: state.head });
  // The check knows no history. An older record of the log, the genesis too, is not the next
  // one, and a current root key did sign it: the caller looks its hash up before it writes.
  const notNext = { reason: "not-next", signedByCurrentRoot: true };
  expect(await nextIdentity(state, await signed(second, [laptop]))).toMatchObject(notNext);
  expect(await nextIdentity(state, await signed(genesis, [laptop]))).toMatchObject(notNext);
});

test.for([
  {
    name: "a fork that a current root key signed",
    post: ({ laptop, fork }: Posters) => signed(fork, [laptop]),
    answer: { reason: "not-next", signedByCurrentRoot: true },
  },
  {
    name: "a fork that a stranger signed",
    post: ({ stranger, fork }: Posters) => signed(fork, [stranger]),
    answer: { reason: "not-next", signedByCurrentRoot: false },
  },
  {
    name: "a fork with a stranger's signature under a current root key's id",
    post: async ({ laptop, stranger, fork }: Posters) => ({
      record: fork,
      signatures: [{ ...(await stranger.sign(fork)), key: laptop.id }],
    }),
    answer: { reason: "not-next", signedByCurrentRoot: false },
  },
  {
    name: "a text that is not JSON, signed by a current root key",
    post: ({ laptop }: Posters) => signed("not a record", [laptop]),
    answer: { reason: "text-not-canonical", signedByCurrentRoot: true },
  },
  {
    name: "30000 nested arrays, signed by a current root key",
    post: ({ laptop }: Posters) => signed("[".repeat(30_000) + "]".repeat(30_000), [laptop]),
    answer: { reason: "record-not-valid", signedByCurrentRoot: true },
  },
])("a refusal says whether a current root key signed the text: $name", async ({ post, answer }) => {
  const [laptop, stranger] = await Promise.all(["laptop", "stranger"].map(newRawKey));
  const state = await born([laptop!]);
  const fork = laterText(state, { prev: "0".repeat(64) });
  expect(
    await nextIdentity(state, await post({ laptop: laptop!, stranger: stranger!, fork })),
  ).toMatchObject(answer);
});

test.for([
  { name: "null", value: () => null },
  { name: "the text alone", value: ({ record }: Envelope) => record },
  { name: "no signatures", value: ({ record }: Envelope) => ({ record }) },
  {
    name: "an empty list of signatures",
    value: ({ record }: Envelope) => ({ record, signatures: [] }),
  },
  { name: "one more field", value: (envelope: Envelope) => ({ ...envelope, extra: 1 }) },
  {
    name: "17 signatures",
    value: ({ record, signatures }: Envelope) => ({
      record,
      signatures: new Array(17).fill(signatures[0]),
    }),
  },
  {
    name: "a signature with padding",
    value: ({ record, signatures }: Envelope) => ({
      record,
      signatures: [{ ...signatures[0], sig: `${signatures[0]!.sig.slice(0, -4)}AA==` }],
    }),
  },
  {
    name: "a signature that is not base64url",
    value: ({ record }: Envelope) => ({
      record,
      signatures: [{ key: KEY_ID, sig: "not base64url!" }],
    }),
  },
  {
    name: "a signature of an impossible length",
    value: ({ record }: Envelope) => ({ record, signatures: [{ key: KEY_ID, sig: "AAAAA" }] }),
  },
  {
    name: "a signature of 4414 characters, two more than the longest",
    value: ({ record }: Envelope) => ({
      record,
      signatures: [{ key: KEY_ID, sig: "A".repeat(4414) }],
    }),
  },
  {
    name: "a key id of 44 characters",
    value: ({ record, signatures }: Envelope) => ({
      record,
      signatures: [{ ...signatures[0], key: `${KEY_ID}A` }],
    }),
  },
  {
    name: "a text of more than 65536 UTF-16 units",
    value: ({ record, signatures }: Envelope) => ({
      record: record.padEnd(64 * 1024 + 1),
      signatures,
    }),
  },
  {
    name: "a text of 40000 units that is 80000 UTF-8 bytes",
    value: ({ signatures }: Envelope) => ({ record: "é".repeat(40_000), signatures }),
  },
  {
    name: "a text with a lone surrogate",
    value: ({ record, signatures }: Envelope) => ({
      record: record + String.fromCharCode(0xd800),
      signatures,
    }),
  },
  {
    name: "a value that throws when it is read",
    value: ({ signatures }: Envelope) => ({
      get record(): string {
        throw new Error("a getter");
      },
      signatures,
    }),
  },
])(
  "$name is no signed record, and is refused before any hash or key is made",
  async ({ value }) => {
    const laptop = await newRawKey("laptop");
    const state = await born([laptop]);
    const envelope = await signed(laterText(state, {}), [laptop]);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    expect(await nextIdentity(state, value(envelope))).toMatchObject({
      reason: "not-a-signed-record",
      signedByCurrentRoot: false,
    });
    expect({ digests: digest.mock.calls, imports: importKey.mock.calls }).toEqual({
      digests: [],
      imports: [],
    });
  },
);

test.for([
  {
    name: "a head with no last record",
    spoil: (state: IdentityState) => ({ ...state, current: null }),
  },
  {
    name: "a last record with no head",
    spoil: (state: IdentityState) => ({ ...state, head: null, position: 0 }),
  },
  {
    name: "a genesis as the head at position 2",
    spoil: (state: IdentityState) => ({ ...state, position: 2 }),
  },
  {
    name: "a head at position 1 that is not the expected id",
    spoil: (state: IdentityState) => ({ ...state, head: "0".repeat(64) }),
  },
  {
    name: "a later record as the head at position 1",
    spoil: (state: IdentityState) => ({
      ...state,
      current: { ...state.current, prev: "0".repeat(64), nonce: undefined },
    }),
  },
  {
    name: "a last record with a field of no record",
    spoil: (state: IdentityState) => ({ ...state, current: { ...state.current, extra: 1 } }),
  },
  {
    name: "one more field",
    spoil: (state: IdentityState) => ({ ...state, refused: null }),
  },
  {
    name: "a last record that throws when it is read",
    spoil: (state: IdentityState) => ({
      ...state,
      get current(): IdentityRecord {
        throw new Error("a getter");
      },
    }),
  },
])("a state with $name is refused, and nothing is checked against it", async ({ spoil }) => {
  const [laptop, stranger] = await Promise.all(["laptop", "stranger"].map(newRawKey));
  const state = await born([laptop!]);
  // A stranger's record that would pass if no old key had to agree to it.
  const text = laterText(state, { rootKeys: [stranger!.entry] });
  expect(
    await nextIdentity(unchecked<IdentityState>(spoil(state)), await signed(text, [stranger!])),
  ).toMatchObject({ reason: "state-not-valid", signedByCurrentRoot: false });
});

test("the check reads the state once: a state that changes while it waits changes nothing", async () => {
  const [laptop, stranger] = await Promise.all(["laptop", "stranger"].map(newRawKey));
  const state = await born([laptop!]);
  const text = laterText(state, { rootKeys: [stranger!.entry] });
  const answer = nextIdentity(state, await signed(text, [stranger!]));
  // By now the check waits. The caller's state loses its root keys and moves its head.
  state.current!.rootKeys.length = 0;
  Object.assign(state, { head: "0".repeat(64), position: 7 });
  expect(await answer).toMatchObject({
    reason: "too-few-old-signatures",
    signedByCurrentRoot: false,
  });
});

test("a runtime that cannot verify ML-DSA-65 says so, and calls no record bad", async () => {
  const laptop = await newRawKey("laptop");
  const state = await born([laptop]);
  const envelope = await signed(laterText(state, { hostnames: ["mind.example.org"] }), [laptop]);
  expect(await canVerifyMlDsa65()).toBe(true);
  vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(
    new DOMException("Unrecognized algorithm name", "NotSupportedError"),
  );
  expect(await canVerifyMlDsa65()).toBe(false);
  expect(await nextIdentity(state, envelope)).toEqual({
    reason: "no-ml-dsa-runtime",
    message: "This runtime cannot verify ML-DSA-65, so it can check no record.",
    signedByCurrentRoot: false,
  });
});

test("a fault inside the check is an answer, and keeps what the old signatures showed", async () => {
  const laptop = await newRawKey("laptop");
  const state = await born([laptop]);
  const envelope = await signed(laterText(state, { hostnames: ["mind.example.org"] }), [laptop]);
  // A runtime's writer may give up on a value; the schema keeps such values from it, so the
  // fault is made here.
  vi.spyOn(JSON, "stringify").mockImplementation(() => {
    throw new RangeError("Maximum call stack size exceeded");
  });
  expect(await nextIdentity(state, envelope)).toEqual({
    reason: "check-failed",
    message: "The check itself failed, which says nothing about the record.",
    signedByCurrentRoot: true,
  });
});

test("the writer puts the fields in the schema's order, and refuses a record that does not fit", async () => {
  const laptop = await newRawKey("laptop");
  const record: IdentityRecord = JSON.parse(genesisText([laptop]));
  const shuffled: IdentityRecord = JSON.parse(
    JSON.stringify(Object.fromEntries(Object.entries(record).reverse())),
  );
  expect(identityRecordText(shuffled)).toBe(identityRecordText(record));
  expect(() => identityRecordText(unchecked<IdentityRecord>({ ...record, version: 2 }))).toThrow();
});

test("the reader takes another order of the fields: it is another text with another id", async () => {
  const laptop = await newRawKey("laptop");
  const written = genesisText([laptop]);
  const shuffled = JSON.stringify(
    Object.fromEntries(Object.entries(JSON.parse(written)).reverse()),
  );
  const mind = await identityHashOf(shuffled);
  expect(mind).not.toBe(await identityHashOf(written));
  expect(await nextIdentity(unborn(mind), await signed(shuffled, [laptop]))).toMatchObject({
    state: { head: mind, position: 1 },
  });
});

test("a text with a lone surrogate has no hash and no signature", async () => {
  const laptop = await newRawKey("laptop");
  const text = genesisText([laptop]) + String.fromCharCode(0xd800);
  await expect(identityHashOf(text)).rejects.toThrow("lone surrogate");
  await expect(laptop.sign(text)).rejects.toThrow("lone surrogate");
});

type RawKey = Awaited<ReturnType<typeof newRawKey>>;
type FidoKey = Awaited<ReturnType<typeof newFidoKey>>;
type GenesisKeys = {
  laptop: RawKey;
  yubikey: FidoKey;
  working: IdentityRecord["workingKeys"][number];
};
type LaterKeys = { laptop: RawKey; yubikey: FidoKey };
type ExtraSigners = {
  laptop: RawKey;
  words: RawKey;
  fresh: RawKey;
  stranger: RawKey;
  text: string;
};
type Posters = { laptop: RawKey; stranger: RawKey; fork: string };
type Envelope = Awaited<ReturnType<typeof signed>>;

/** A value as a type that it does not have: what a caller with no types can pass. The one cast
 *  of this file's tests. */
const unchecked = <Type>(value: unknown) => value as Type;

/** A log with no record yet, which must start with the genesis that hashes to `expected`. */
const unborn = (expected: string) =>
  ({ expected, head: null, position: 0, current: null }) as const;

const genesisText = (keys: { entry: IdentityRecord["rootKeys"][number] }[], threshold = 1) =>
  identityRecordText({
    version: 1,
    prev: null,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
    rootKeys: keys.map((key) => key.entry),
    threshold,
    workingKeys: [],
    hostnames: ["mind.example.com"],
    alsoKnownAs: [],
  });

/** The text of the record after `state`'s last one: that record, with `change`. */
const laterText = (state: IdentityState, change: Partial<IdentityRecord>) =>
  identityRecordText({ ...state.current!, nonce: undefined, prev: state.head, ...change });

type Signer = { sign: (text: string) => Promise<{ key: string; sig: string }> };

const signed = async (record: string, keys: Signer[]) => ({
  record,
  signatures: await Promise.all(keys.map((key) => key.sign(record))),
});

async function accepted(before: IdentityState, value: unknown) {
  const next = await nextIdentity(before, value);
  if (!("state" in next)) throw new Error(`not accepted: ${JSON.stringify(next)}`);
  return next.state;
}

/** The state after a genesis that every one of `keys` signed. */
async function born(
  keys: (Signer & { entry: IdentityRecord["rootKeys"][number] })[],
  threshold = 1,
) {
  const text = genesisText(keys, threshold);
  return accepted(unborn(await identityHashOf(text)), await signed(text, keys));
}

/** A person's ML-DSA-65 key, made as the test runs. */
async function newRawKey(label: string) {
  // WebCrypto's types answer a key or a pair for an algorithm they do not know by name, and
  // list no `raw-public` format yet; a signature algorithm makes a pair.
  const pair = (await crypto.subtle.generateKey({ name: "ML-DSA-65" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = base64url(
    new Uint8Array(await crypto.subtle.exportKey("raw-public" as "raw", pair.publicKey)),
  );
  const id = await identityKeyIdOf(publicKey);
  return {
    entry: { signs: "raw", algorithm: "ML-DSA-65", publicKey, label } as const,
    id,
    privateKey: pair.privateKey,
    sign: (text: string) => signIdentityRecord(text, pair.privateKey, id),
  };
}

/** A software key that signs as a FIDO device does through `ssh-keygen -Y sign`. */
async function newFidoKey(label: string) {
  const key = await newSshKey("Ed25519", "ssh:iterate-mind-root");
  const publicKey = base64url(key.publicKey);
  const id = await identityKeyIdOf(publicKey);
  return {
    entry: {
      signs: "sshsig",
      algorithm: "Ed25519",
      publicKey,
      application: key.application,
      label,
    } as const,
    id,
    sign: async (text: string, spoiled?: Parameters<typeof sshsigOf>[3]) => ({
      key: id,
      sig: base64url(await sshsigOf(key, encoder.encode(text), "iterate-mind-identity", spoiled)),
    }),
  };
}
