// mind-identity.ts — THE IDENTITY OF A MIND (`iterate/mind-identity`): a list of signed records.
// The first, the genesis, names the root keys and how many must sign; the mind id is the SHA-256
// of its text. Every later record holds the whole new truth and the hash of the record before it.
// Root keys are held by people and sign on their machines; a working key is held by the stack, and
// a record says which one counts. A domain, a Cloudflare account and every key can change, and the
// id stays.
//
// This file is the record's schema, its one writer, its hash, and `nextIdentity`: the ONE check
// that decides whether a signed record continues a log. The check reads nothing but its
// arguments, so the auth Worker runs it at the intake, the command runs it before it posts, and a
// mind runs it again on another mind's log, all with the same answer.
import { z } from "zod";
import { base64url, fromBase64url, signedBytes } from "./signed.ts";
import { sshVerifyKeyOf, verifySshsig } from "./sshsig.ts";

/** SHA-256, lowercase hex: a record's hash, and so a mind's id. */
export const IdentityHash = z.string().regex(/^[0-9a-f]{64}$/);
/** Bytes as base64url with no padding, in their one spelling: the text encodes back to itself,
 *  so no spare bit and no impossible length passes. The length is checked first and ends the
 *  reading, so nothing longer than `maxLength` characters is ever decoded. */
const bytes = (maxLength: number) =>
  z
    .string()
    .max(maxLength, { abort: true })
    .regex(/^[A-Za-z0-9_-]+$/, { abort: true })
    .refine((text) => text.length % 4 !== 1 && base64url(fromBase64url(text)) === text);
/** A text for people. It is well-formed Unicode: JSON can spell a lone surrogate as an escape,
 *  which JavaScript reads and writes back, and which other readers refuse or replace. */
const Label = z
  .string()
  .min(1)
  .max(80)
  .refine((label) => label.isWellFormed());
/** A DNS hostname as `Hostname` of ./mind-config.ts spells it. That schema lowercases what it
 *  reads; a record has one spelling, so this one refuses a capital. It has no port, path or
 *  credentials, and its last label is letters, so it is no IP address. */
export const IdentityHostname = z
  .string()
  .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

/** A key that signs the bytes itself: a file, recovery words, 1Password, a Secure Enclave, an HSM. */
const RawKey = z.strictObject({
  signs: z.literal("raw"),
  algorithm: z.enum(["ML-DSA-65"]),
  /** The raw public key: 1952 bytes, which are 2603 characters. */
  publicKey: bytes(2603),
  /** "laptop", "recovery words". */
  label: Label,
  /** Kept and never checked. */
  attestation: bytes(22_000).optional(),
});
/** A key that signs through `ssh-keygen -Y sign`: on a FIDO device or in an ssh agent. */
const SshKey = z.strictObject({
  signs: z.literal("sshsig"),
  algorithm: z.enum(["Ed25519", "P-256"]),
  /** The raw key: Ed25519's 32 bytes, or P-256's point of 65 bytes, which are 87 characters. */
  publicKey: bytes(87),
  /** Present: a FIDO key, made for this application. */
  application: z
    .string()
    .regex(/^ssh:[!-~]{0,60}$/)
    .optional(),
  /** "YubiKey 5C". */
  label: Label,
  /** Kept and never checked. */
  attestation: bytes(22_000).optional(),
});
const RootKey = z.discriminatedUnion("signs", [RawKey, SshKey]);
/** A key the stack holds. A reader uses one only for a `purpose` it knows ("statements"), so a
 *  purpose it does not know is passed over, never refused. */
const WorkingKey = RawKey.extend({ purpose: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) });

/** THE RECORD: the text that is signed. Every record holds the whole truth. An unknown version,
 *  field, `signs` or algorithm refuses the record: an old reader must not take half of a record
 *  that a newer writer made. */
export const IdentityRecord = z.strictObject({
  version: z.literal(1),
  /** The hash of the record before this one. Null in the genesis alone. */
  prev: IdentityHash.nullable(),
  /** The genesis alone: 16 random bytes (22 characters), so that two minds born with the same
   *  keys differ. */
  nonce: bytes(22).optional(),
  rootKeys: z.array(RootKey).min(1).max(8),
  /** How many root keys must sign. Nothing but a record signed by this many lowers it. */
  threshold: z.number().int().min(1).max(8),
  /** Empty in the genesis: the stack makes its key after the genesis is signed. */
  workingKeys: z.array(WorkingKey).max(8),
  /** Where the control plane answers; the first is preferred. */
  hostnames: z.array(IdentityHostname).min(1).max(8),
  /** Links to the mind's other names, as URIs. Published, never verified. */
  alsoKnownAs: z.array(z.string().regex(/^[a-z][a-z0-9+.-]*:[!-~]{1,500}$/)).max(16),
});
export type IdentityRecord = z.infer<typeof IdentityRecord>;

/** A record's text is at most this many UTF-8 bytes. */
export const RECORD_MAX_BYTES = 64 * 1024;

/** A record with its signatures, in any order, at most one for each key. `key` is a root key's
 *  id (`identityKeyIdOf`): 43 characters. How a key signs is in its entry in the record
 *  (`signs`), so a signature carries no format: a `raw` key's `sig` is its signature, an `sshsig`
 *  key's the binary SSHSIG blob. The longest is ML-DSA-65's, 3309 bytes, which are 4412
 *  characters. No hash covers a signature, so a record may gain signatures later, and a
 *  half-signed record is this same value passed from signer to signer.
 *
 *  Every bound is read before anything is decoded: the number of signatures before any one of
 *  them, and a string's length before its bytes. `record` is bounded here in UTF-16 units, which
 *  is never less than its bytes allow; `nextIdentity` bounds the bytes when it encodes the text. */
export const SignedRecord = z.strictObject({
  /** The exact JSON text. */
  record: z.string().max(RECORD_MAX_BYTES),
  signatures: z
    .array(z.unknown())
    .min(1)
    .max(16)
    .pipe(
      z.array(z.strictObject({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/), sig: bytes(4412) })),
    ),
});
export type SignedRecord = z.infer<typeof SignedRecord>;

/** The namespace of an `sshsig` key's signature: `ssh-keygen -Y sign -n iterate-mind-identity`.
 *  The message is the UTF-8 bytes of the record's text, and the hash is `sha512`. */
export const IDENTITY_SSHSIG_NAMESPACE = "iterate-mind-identity";

/** What a `raw` key signs: `signedBytes(text, this type)`, the DSSE bytes of ./signed.ts under a
 *  type of their own, so a root key's signature never passes as a statement's. */
const IDENTITY_PAYLOAD_TYPE = "application/vnd.iterate.mind-identity+json";

/** Pure ML-DSA-65 (FIPS 204) with the empty context, which is what WebCrypto signs when no
 *  `context` is given: a hardware interface often cannot set one. Node 24.7 and workerd with the
 *  flag `webcrypto_modern_algorithms` have it. https://wicg.github.io/webcrypto-modern-algos/ */
const ML_DSA_65 = { name: "ML-DSA-65" } as const;

/** WHERE A LOG STANDS: what `nextIdentity` checks a record against, and what it answers. Before
 *  the genesis there is no head; after it there is always the last accepted record, whose root
 *  keys are the ones that must agree to the next. The genesis is the head exactly at position 1.
 *  `nextIdentity` reads its `before` through this schema, so a state that is not one of these
 *  is refused and never checked against. */
const IdentityState = z.union([
  z.strictObject({
    expected: IdentityHash,
    head: z.null(),
    position: z.literal(0),
    current: z.null(),
  }),
  z.strictObject({
    /** The mind id: the hash that the genesis must have. */
    expected: IdentityHash,
    /** The hash of the last accepted record. */
    head: IdentityHash,
    /** How many records are accepted: 1 is the genesis. */
    position: z.number().int().min(1),
    /** The last accepted record: the whole identity. Its text is not here: the accepted text is
     *  what a log stores and serves, and it is never written again from this value, because
     *  another order of the same fields is another text with another hash. */
    current: IdentityRecord,
  }),
]);
export type IdentityState = z.infer<typeof IdentityState>;

/** A root key whose signature of a record verified. `userVerified` is a FIDO device's word on
 *  whether it checked its person (a PIN or a fingerprint): reported, never required. */
export type IdentitySigner = Pick<z.infer<typeof RootKey>, "label" | "algorithm" | "signs"> & {
  key: string;
  userVerified?: boolean;
};

/** WHY A RECORD IS REFUSED: the fixed list of reasons, each with its one sentence. The sentence
 *  is a constant, so a refusal never carries text that a stranger wrote into a record. The first
 *  three say nothing about the record: they are a fault of the caller or of the runtime, and an
 *  intake answers them as its own error. */
const REFUSALS = {
  "state-not-valid": "The state of the log that the check was given is not a consistent state.",
  "no-ml-dsa-runtime": "This runtime cannot verify ML-DSA-65, so it can check no record.",
  "check-failed": "The check itself failed, which says nothing about the record.",
  "not-a-signed-record": "The value is not a record with its signatures, or it is too large.",
  "signer-twice": "Two signatures name the same key.",
  "text-not-canonical": "The record's text is not what JSON.stringify writes for its value.",
  "record-not-valid": "The record has a missing, an unknown or a wrong field.",
  "not-next": "The record's `prev` is not the hash of the last accepted record.",
  "wrong-genesis": "The genesis does not hash to the expected mind id.",
  nonce: "A genesis has a nonce of 16 bytes, and no later record has a nonce.",
  "genesis-working-key": "A genesis lists no working key.",
  "threshold-unreachable": "The threshold is higher than the number of root keys.",
  "no-ml-dsa-root-key": "No root key is an ML-DSA-65 key.",
  "key-length": "A public key has the wrong length for its algorithm.",
  "key-not-valid": "A public key is not a real key of its algorithm.",
  "key-twice": "A key is listed twice.",
  "key-changed": "A root key that stays is listed with another way to sign than before.",
  "unknown-signer": "A signature names no root key of the last accepted record or of this one.",
  "bad-signature": "A signature does not verify under the key that it names.",
  "too-few-old-signatures": "Too few root keys of the last accepted record signed.",
  "no-ml-dsa-old-signature": "No ML-DSA-65 root key of the last accepted record signed.",
  "too-few-new-signatures": "Too few of the record's own root keys signed.",
  "no-ml-dsa-new-signature": "No ML-DSA-65 root key of the record's own signed.",
} as const;

/** WHAT THE CHECK ANSWERS, AND WHAT IS LEFT TO ITS CALLER. The check knows one state and one
 *  record; it knows no history. An intake that stores a log therefore does three things itself:
 *
 *  1. BEFORE THE CHECK it looks up the record's hash (`identityHashOf`) in its own rows of every
 *     record it ever accepted, for this mind id and for an id the mind had before. A record it
 *     finds is known: every accepted record is public, so anyone can post one again.
 *  2. It answers a known record from the STORED text and signatures, never from the request: a
 *     known hash says nothing about the signatures that came with it.
 *  3. AT THE APPEND of an accepted record it compares the stored head with the head that the
 *     check read: `state.current.prev`, and no head at all for a genesis. The check reads
 *     `before` once, before it waits for anything, so its answer is about that one state.
 *
 *  It also bounds the body of a request before it parses it: the bounds of `SignedRecord` are on
 *  a value that is already in memory. */
export type NextIdentity =
  /** Accepted: the log's new state, and the root keys that signed. */
  | { state: IdentityState; signedBy: IdentitySigner[] }
  /** The text is the log's last record, by its hash. Its signatures were not read. */
  | { known: string }
  /** Refused. `signedByCurrentRoot` says that a root key of the last accepted record validly
   *  signed this text, whatever the text says. It is a fact about the text, not about who sent
   *  it: an older record of the log has it too, and so has every copy of one refused record.
   *  So an intake writes a refused event only when this is true AND the hash is no record that
   *  it accepted (1. above), and at most once for each hash. */
  | { reason: keyof typeof REFUSALS; message: string; signedByCurrentRoot: boolean };

/** THE CHECK: whether `signed` is the next record of the log that stands at `before`. It reads
 *  nothing but its arguments, and it answers every value: it never throws. In order: the state;
 *  every size and count, before anything is decoded or hashed; the hash; the log's last record,
 *  which is known; the signatures of the last record's root keys; the schema and the text's
 *  spelling; the record's place; its content; the other signatures; and enough of them on both
 *  sides.
 *
 *  ENOUGH means, for a set of root keys and its threshold: the keys of the set that validly
 *  signed number at least the threshold, and one of them is an ML-DSA-65 key. A genesis needs
 *  enough of its own set. Every later record needs enough of the last record's set AND enough
 *  of its own, so the keys that leave agree and the keys that arrive prove they can sign. A key
 *  in both sets signs the same way in both, so its one signature counts on both sides. */
export async function nextIdentity(before: IdentityState, signed: unknown): Promise<NextIdentity> {
  let signedByCurrentRoot = false;
  const refused = (reason: keyof typeof REFUSALS) => ({
    reason,
    message: REFUSALS[reason],
    signedByCurrentRoot,
  });
  try {
    // Down to the first `await`, the two arguments are read once into values that no caller
    // holds: a state that moves on while the check waits cannot lend its head to another
    // record's root keys.
    const state = identityStateFrom(before);
    if (!state) return refused("state-not-valid");
    const envelope = readAs(SignedRecord, signed);
    // A lone surrogate has no UTF-8 bytes, so such a text has no hash of its own.
    if (!envelope || !envelope.record.isWellFormed()) return refused("not-a-signed-record");
    const { record: text, signatures } = envelope;
    const textBytes = utf8(text);
    if (textBytes.length > RECORD_MAX_BYTES) return refused("not-a-signed-record");
    if (new Set(signatures.map(({ key }) => key)).size !== signatures.length)
      return refused("signer-twice");

    if (!(await canVerifyMlDsa65())) return refused("no-ml-dsa-runtime");
    const hash = hexOf(await sha256(textBytes));
    if (hash === state.head) return { known: hash };

    // The last record's side is counted before the text is read: a signature is over the text's
    // bytes whatever they say, and every refusal from here on says whether a current root signed.
    const message = { sshsig: textBytes, raw: signedBytes(text, IDENTITY_PAYLOAD_TYPE) };
    const verified = new Map<string, { userVerified?: boolean } | false>();
    const old = await votesOf(state.current?.rootKeys || [], signatures, message, verified);
    signedByCurrentRoot = old.signers.length > 0;

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return refused("text-not-canonical");
    }
    // The schema comes first: it refuses a value nested deeper than a record is, so the writer
    // below never meets one.
    const record = readAs(IdentityRecord, value);
    if (!record) return refused("record-not-valid");
    // `JSON.stringify(JSON.parse(text))` is the text: a duplicate name, a spare space and an
    // escape that JSON does not need all change under it.
    if (JSON.stringify(value) !== text) return refused("text-not-canonical");

    // Before the genesis the head is null, and so is a genesis's `prev`.
    if (record.prev !== state.head) return refused("not-next");
    if (!state.head && hash !== state.expected) return refused("wrong-genesis");

    const nonceBytes = record.nonce ? fromBase64url(record.nonce).length : 0;
    if (nonceBytes !== (state.head ? 0 : 16)) return refused("nonce");
    if (!state.head && record.workingKeys.length > 0) return refused("genesis-working-key");
    if (record.threshold > record.rootKeys.length) return refused("threshold-unreachable");
    if (!record.rootKeys.some((key) => key.algorithm === "ML-DSA-65"))
      return refused("no-ml-dsa-root-key");
    const keys = [...record.rootKeys, ...record.workingKeys];
    const lengths = { "ML-DSA-65": 1952, Ed25519: 32, "P-256": 65 };
    if (keys.some((key) => fromBase64url(key.publicKey).length !== lengths[key.algorithm]))
      return refused("key-length");
    // A key is real when the record lists it, not when it first signs: a recovery key that
    // turns out to be no key on the day it is needed is found too late. Any 1952 bytes are an
    // ML-DSA-65 key, so only an ssh key can fail here.
    for (const key of record.rootKeys) {
      if (key.signs !== "sshsig") continue;
      if (!(await sshVerifyKeyOf(key.algorithm, fromBase64url(key.publicKey))))
        return refused("key-not-valid");
    }
    // `bytes` has one spelling, so two entries hold one key exactly when their texts are equal.
    if (new Set(keys.map((key) => key.publicKey)).size !== keys.length) return refused("key-twice");
    // A key that stays keeps how it signs; its label and its attestation may change. So one
    // signature of it is checked once and counts for the last record and for this one.
    const waysBefore = new Map(
      (state.current?.rootKeys || []).map((key) => [key.publicKey, wayOf(key)]),
    );
    if (record.rootKeys.some((key) => (waysBefore.get(key.publicKey) || wayOf(key)) !== wayOf(key)))
      return refused("key-changed");

    const own = await votesOf(record.rootKeys, signatures, message, verified);
    if (signatures.some(({ key }) => !old.keyIds.has(key) && !own.keyIds.has(key)))
      return refused("unknown-signer");
    if (old.bad || own.bad) return refused("bad-signature");

    if (state.current) {
      if (old.signers.length < state.current.threshold) return refused("too-few-old-signatures");
      if (!old.signers.some((signer) => signer.algorithm === "ML-DSA-65"))
        return refused("no-ml-dsa-old-signature");
    }
    if (own.signers.length < record.threshold) return refused("too-few-new-signatures");
    if (!own.signers.some((signer) => signer.algorithm === "ML-DSA-65"))
      return refused("no-ml-dsa-new-signature");

    // A key in both sets is named once, as this record labels it.
    const signedBy = new Map(
      [...old.signers, ...own.signers].map((signer) => [signer.key, signer]),
    );
    return {
      state: {
        expected: state.expected,
        head: hash,
        position: state.position + 1,
        current: record,
      },
      signedBy: [...signedBy.values()],
    };
  } catch {
    // Nothing above is expected to throw. A caller of a check that decides who owns a mind must
    // get an answer all the same, and this one says that it is not about the record.
    return refused("check-failed");
  }
}

/** `value` as a state that a log can stand at, in a copy of its own, or null. Beyond the schema:
 *  the genesis is the head exactly at position 1, and exactly the genesis has no `prev`. The
 *  check refuses every other value (`state-not-valid`), so a caller that holds a state in
 *  another form narrows it through this. */
export function identityStateFrom(value: unknown): IdentityState | null {
  const state = readAs(IdentityState, value);
  if (!state?.current) return state;
  const genesisIsHead = state.head === state.expected;
  if (genesisIsHead !== (state.position === 1) || genesisIsHead !== !state.current.prev)
    return null;
  return state;
}

/** Whether this runtime can verify an ML-DSA-65 signature at all. Without it a true record
 *  looks like one with a bad signature, so `nextIdentity` asks first and answers
 *  `no-ml-dsa-runtime`. A server asks once when it starts to take records. */
export async function canVerifyMlDsa65(): Promise<boolean> {
  return mlDsa65VerifyKeyOf(new Uint8Array(1952)).then(
    () => true,
    () => false,
  );
}

/** A WRITER of a record's text: `JSON.stringify` of the record, with the fields in the schema's
 *  order. The reader does not ask for that order: it takes every text that is
 *  `JSON.stringify(JSON.parse(text))` and fits the schema, and each such text has its own hash.
 *  So the text that was signed and accepted is the one to store and to serve. Writing a text
 *  again from a parsed record can give another text. Throws on a record that does not fit the
 *  schema. */
export function identityRecordText(record: IdentityRecord): string {
  return JSON.stringify(IdentityRecord.parse(record));
}

/** A record's hash: SHA-256 of the UTF-8 bytes of its text, lowercase hex, as `sha256sum` prints
 *  it. It is the next record's `prev`, and for the genesis the mind id. Throws on a text with a
 *  lone surrogate: it has no UTF-8 bytes, and encoding it would hash another text. */
export async function identityHashOf(text: string): Promise<string> {
  return hexOf(await sha256(wellFormedBytesOf(text)));
}

/** A key's id: SHA-256 of its raw public key bytes, base64url. `publicKey` is a key entry's. */
export async function identityKeyIdOf(publicKey: string): Promise<string> {
  return base64url(await sha256(fromBase64url(publicKey)));
}

/** A `raw` key's signature of a record's text, as an entry of `SignedRecord.signatures`. `key`
 *  is the key's id. An `sshsig` key signs through `ssh-keygen -Y sign`, never here. Throws on a
 *  text with a lone surrogate, as `identityHashOf` does. */
export async function signIdentityRecord(
  record: string,
  privateKey: Parameters<typeof crypto.subtle.sign>[1],
  key: string,
): Promise<SignedRecord["signatures"][number]> {
  wellFormedBytesOf(record);
  const sig = await crypto.subtle.sign(
    ML_DSA_65,
    privateKey,
    signedBytes(record, IDENTITY_PAYLOAD_TYPE),
  );
  return { key, sig: base64url(new Uint8Array(sig)) };
}

/** WHAT THE SIGNATURES SAY FOR ONE SET OF ROOT KEYS: the ids of the set's keys, the keys that
 *  validly signed, and whether the signature that names a key of the set does not verify.
 *  `verified` holds what is already known of a key's signature, by key id, so a key in both
 *  sets is verified once. */
async function votesOf(
  rootKeys: IdentityRecord["rootKeys"],
  signatures: SignedRecord["signatures"],
  message: SignedMessage,
  verified: Map<string, { userVerified?: boolean } | false>,
) {
  const keyIds = new Set<string>();
  const signers: IdentitySigner[] = [];
  let bad = false;
  for (const rootKey of rootKeys) {
    const key = await identityKeyIdOf(rootKey.publicKey);
    keyIds.add(key);
    const signature = signatures.find((candidate) => candidate.key === key);
    if (!signature) continue;
    if (!verified.has(key)) verified.set(key, await verifiedBy(rootKey, signature.sig, message));
    const vote = verified.get(key);
    if (!vote) {
      bad = true;
      continue;
    }
    const { label, algorithm, signs } = rootKey;
    signers.push({ key, label, algorithm, signs, ...vote });
  }
  return { keyIds, signers, bad };
}

/** What each kind of key signs of one record's text: an `sshsig` key the text's UTF-8 bytes, a
 *  `raw` key the DSSE bytes around them. Both are made once for a check. */
type SignedMessage = { sshsig: Uint8Array<ArrayBuffer>; raw: Uint8Array<ArrayBuffer> };

/** Whether `sig` is `rootKey`'s signature of the text, made the one way that the key signs:
 *  false when it is not, else what the signature says beyond that. */
async function verifiedBy(
  rootKey: IdentityRecord["rootKeys"][number],
  sig: string,
  message: SignedMessage,
): Promise<{ userVerified?: boolean } | false> {
  if (rootKey.signs === "sshsig") {
    const answer = await verifySshsig({
      blob: fromBase64url(sig),
      message: message.sshsig,
      namespace: IDENTITY_SSHSIG_NAMESPACE,
      key: {
        algorithm: rootKey.algorithm,
        publicKey: fromBase64url(rootKey.publicKey),
        application: rootKey.application,
      },
    });
    if ("refused" in answer) return false;
    return answer;
  }
  // A key that the runtime does not take is a key that signed nothing.
  const verifyKey = await mlDsa65VerifyKeyOf(fromBase64url(rootKey.publicKey)).catch(() => null);
  if (!verifyKey) return false;
  const valid = await crypto.subtle.verify(ML_DSA_65, verifyKey, fromBase64url(sig), message.raw);
  if (!valid) return false;
  return {};
}

function mlDsa65VerifyKeyOf(publicKey: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey(
    // The format of an ML-DSA public key is `raw-public`, which Node and workerd take and
    // which TypeScript 7.0's DOM library does not list yet. The cast names a format that the
    // library knows, so the call types; the runtime gets the string as written.
    "raw-public" as "raw",
    publicKey,
    ML_DSA_65,
    false,
    ["verify"],
  );
}

/** How a root key signs: all of its entry but what is for people (`label`, `attestation`). */
const wayOf = (key: IdentityRecord["rootKeys"][number]) =>
  [key.signs, key.algorithm, key.signs === "sshsig" ? key.application : undefined].join(" ");

/** `value` as `schema` reads it, in a copy of its own, or null. A value from JavaScript may
 *  throw when it is read (a getter, a proxy); that is no value either. */
function readAs<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> | null {
  try {
    const read = schema.safeParse(value);
    if (!read.success) return null;
    return read.data;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();
/** The UTF-8 bytes of `text`, in an array over a buffer of its own: Cloudflare's types give
 *  `TextEncoder` a wider buffer type than WebCrypto's take, and a new array has the narrow one. */
const utf8 = (text: string) => new Uint8Array(encoder.encode(text));

function wellFormedBytesOf(text: string): Uint8Array<ArrayBuffer> {
  if (!text.isWellFormed()) throw new Error("the text has a lone surrogate: it has no UTF-8 bytes");
  return utf8(text);
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const hexOf = (data: Uint8Array) =>
  [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
