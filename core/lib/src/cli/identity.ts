// identity.ts — A MIND'S IDENTITY ON ITS PERSON'S COMPUTER (iterate/mind-identity). A mind's id is
// the hash of its first signed record, the genesis, and a root key that signed the genesis proves
// whose the mind is. `iterate deploy` makes that key for a new mind with no question. This file
// is all of it: the key, the genesis, the two files, and the post of the records to the mind.
//
// TWO FILES FOR EACH MIND, in the CLI's config folder under `identities/`, each mode 600 in a
// folder of mode 700, and each written whole to a temporary name, flushed to the disk, renamed,
// and its folder flushed too:
//
//   <mind id>.key.json   the root key. Whoever has this file can change the mind's root keys.
//   <mind id>.json       the signed records, oldest first: a root key cannot continue a log
//                        that it does not have. The first is the genesis; the second lists
//                        the stack's working key, which the stack makes in the deploy.
//
// THE KEY FILE HOLDS THE SEED: the 32 bytes that an ML-DSA-65 key is made from (FIPS 204), as
// WebCrypto's `raw-seed` format gives and takes them
// (https://wicg.github.io/webcrypto-modern-algos/). Node 26 and Bun 1.4 export and import it, and
// workerd imports it to the same public key (measured 2026-11-18). PKCS#8 has three forms for
// this key (the seed, the expanded key, or both), so one runtime's file may be no file to
// another; the seed has one spelling.
//
// The key is never printed and never sent: a signature leaves this computer, the key does not.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  canVerifyMlDsa65,
  IdentityHash,
  identityHashOf,
  identityKeyIdOf,
  type IdentityRecord,
  identityRecordText,
  type IdentityState,
  nextIdentity,
  SignedRecord,
  signIdentityRecord,
} from "../mind-identity.ts";
import {
  deadlineIn,
  jsonOf,
  LOG_PAGE_BYTES,
  MIND_IDENTITY_PATH,
  SIGNED_RECORD_MAX_BYTES,
  textWithin,
} from "../mind-identity-log.ts";
import { base64url, fromBase64url, STACK_KEY_PATH } from "../signed.ts";
import { CONFIG_DIR } from "./config.ts";

/** Where the identities of this computer's minds are. */
export const IDENTITIES = join(CONFIG_DIR, "identities");

const ML_DSA_65 = { name: "ML-DSA-65" } as const;

const KeyFile = z.object({
  version: z.literal(1),
  mind: IdentityHash,
  algorithm: z.literal("ML-DSA-65"),
  /** The raw public key, and the seed that the key is made from, each as base64url. */
  publicKey: z.string(),
  seed: z.string(),
});
const RecordsFile = z.object({
  version: z.literal(1),
  mind: IdentityHash,
  records: z.array(SignedRecord).min(1),
});

/** The file of the mind's root key in the folder `dir`. */
export const keyFileOf = (dir: string, mindId: string) => join(dir, `${mindId}.key.json`);
const recordsFileOf = (dir: string, mindId: string) => join(dir, `${mindId}.json`);

/** Stops with a clear suggestion to upgrade Node when this runtime has no ML-DSA-65 (`has`, the
 *  runtime's own answer except in a test): it cannot create or verify a mind's identity key.
 *  Checked only at key-creation or record-verification time. */
export async function mlDsaRequired(has = canVerifyMlDsa65) {
  if (!(await has()))
    throw new Error(
      `Node ${process.versions.node} does not support ML-DSA-65, which is needed to create or verify a mind's identity key. Upgrade to Node 24.7 or newer (e.g. via nvm, fnm, or https://nodejs.org) and run the command again.`,
    );
}

/** WRITES `value` AS JSON TO `path`, WHOLE AND DURABLE, or not at all: every byte to a temporary
 *  name, the file flushed to the disk, renamed, and then the folder flushed, which holds the new
 *  name. A folder that this makes is flushed into its own parent too. So when this returns, a
 *  loss of power does not lose the file: a deploy that follows must find the key. A temporary
 *  file of a write that failed is removed. */
export function writeWhole(path: string, value: unknown) {
  const folder = dirname(path);
  const made = mkdirSync(folder, { recursive: true, mode: 0o700 });
  // a folder that was there keeps its mode through `mkdirSync`
  chmodSync(folder, 0o700);
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const file = openSync(temporary, "wx", 0o600);
  try {
    try {
      // `writeFileSync` on a descriptor writes until every byte is written
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  flushFolder(folder);
  // `made` is the first folder that `mkdirSync` made: each from there down gained a name
  if (made) for (let at = folder; at !== dirname(made); at = dirname(at)) flushFolder(dirname(at));
}

function flushFolder(folder: string) {
  const handle = openSync(folder, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/** The root key of the mind `mindId` from its file in `dir`: its public key, and a key that
 *  signs. A file that cannot be read, parsed or imported gives one fixed sentence: a parser's own
 *  words may quote the file, and so the seed. */
async function rootKeyOf(dir: string, mindId: string) {
  const path = keyFileOf(dir, mindId);
  try {
    const { publicKey, seed } = KeyFile.parse(JSON.parse(readFileSync(path, "utf8")));
    // The cast: `raw-seed` is the format of an ML-DSA seed, which Node, Bun and workerd take and
    // TypeScript's library does not list yet. The runtime gets the string as written.
    const format = "raw-seed" as "raw";
    const signer = await crypto.subtle.importKey(format, fromBase64url(seed), ML_DSA_65, false, [
      "sign",
    ]);
    return { publicKey, signer };
  } catch {
    throw new Error(`The identity key file ${path} cannot be read as an identity key.`);
  }
}

/** The root key of the mind `mindId` as a key that signs (`rootKeyOf`). */
export const signingKeyOf = async (dir: string, mindId: string) =>
  (await rootKeyOf(dir, mindId)).signer;

/** A NEW MIND'S IDENTITY: one ML-DSA-65 root key and the genesis that it signed, both in `dir`
 *  when this answers. The genesis names that key alone, with threshold 1, and `hostnames`: where
 *  the mind's control plane answers. The mind id is the genesis's hash.
 *
 *  The key file is written first, and the signature is made with the key READ FROM THAT FILE: an
 *  id that this answers has its key on the disk. The genesis passes the intake's own check
 *  (`nextIdentity`) here, so no Worker is given an id whose genesis the mind would refuse. */
export async function newIdentity(hostnames: string[], dir: string) {
  await mlDsaRequired();
  // The cast: WebCrypto's types answer a key or a pair for an algorithm that they do not know by
  // name. A signature algorithm makes a pair.
  const pair = (await crypto.subtle.generateKey(ML_DSA_65, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // The cast: TypeScript's library lists neither format yet. The runtime gets the string as
  // written, and answers bytes for both.
  const exported = async (format: "raw-public" | "raw-seed", key: CryptoKey) =>
    base64url(new Uint8Array(await crypto.subtle.exportKey(format as "raw", key)));
  const publicKey = await exported("raw-public", pair.publicKey);
  const record = identityRecordText({
    version: 1,
    prev: null,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
    rootKeys: [{ signs: "raw", algorithm: "ML-DSA-65", publicKey, label: "key file" }],
    threshold: 1,
    workingKeys: [],
    hostnames,
    alsoKnownAs: [],
  });
  const mindId = await identityHashOf(record);
  const keyFile = keyFileOf(dir, mindId);
  const seed = await exported("raw-seed", pair.privateKey);
  writeWhole(keyFile, { version: 1, mind: mindId, algorithm: "ML-DSA-65", publicKey, seed });
  const signature = await signIdentityRecord(
    record,
    await signingKeyOf(dir, mindId),
    await identityKeyIdOf(publicKey),
  );
  const signed = { record, signatures: [signature] };
  const checked = await nextIdentity(unborn(mindId), signed);
  if (!("state" in checked))
    throw new Error(
      `The new mind's first identity record did not pass its own check (${"reason" in checked ? checked.message : "known"}). Nothing was deployed.`,
    );
  writeWhole(recordsFileOf(dir, mindId), { version: 1, mind: mindId, records: [signed] });
  return { mindId, keyFile };
}

/** THE IDENTITY THAT AN EARLIER RUN ON THIS COMPUTER MADE FOR A MIND AT `controlPlaneHostname`:
 *  the newest records file here whose genesis lists that hostname and whose key file is here,
 *  with the time its key was made; undefined when there is none. A first deploy that stopped half
 *  way, before any Worker answered with the id, so goes on with the same id. A file that its own
 *  check refuses is passed over. */
export async function identityMadeFor(controlPlaneHostname: string, dir: string) {
  if (!existsSync(dir)) return undefined;
  const found: { mindId: string; keyFile: string; madeAt: Date }[] = [];
  for (const name of readdirSync(dir)) {
    const mindId = /^([0-9a-f]{64})\.json$/.exec(name)?.[1];
    if (!mindId) continue;
    const keyFile = keyFileOf(dir, mindId);
    if (!existsSync(keyFile)) continue;
    const held = await heldIdentity(dir, mindId).catch(() => undefined);
    if (!held?.genesis.hostnames.includes(controlPlaneHostname)) continue;
    found.push({ mindId, keyFile, madeAt: statSync(keyFile).mtime });
  }
  return found.toSorted((one, other) => other.madeAt.getTime() - one.madeAt.getTime())[0];
}

const unborn = (mindId: string): IdentityState => ({
  expected: mindId,
  head: null,
  position: 0,
  current: null,
});

/** THE RECORDS THAT THIS COMPUTER HOLDS OF THE MIND `mindId`, oldest first, each one's hash, and
 *  the genesis and the last record; undefined when it holds none: another computer has the
 *  mind's key. The whole file is checked with `nextIdentity` from the genesis, as the mind's
 *  intake checks it, so nothing is sent that is not one log of that mind; a file that the check
 *  refuses throws. */
async function heldIdentity(dir: string, mindId: string) {
  const file = recordsFileOf(dir, mindId);
  if (!existsSync(file)) return undefined;
  const refused = (why: string) =>
    new Error(`${file} is no identity log of the mind ${mindId} that its own check takes: ${why}`);
  const read = RecordsFile.safeParse(jsonOf(readFileSync(file, "utf8")));
  if (!read.success) throw refused("it is not a file of signed records.");
  await mlDsaRequired();
  let state = unborn(mindId);
  const hashes: string[] = [];
  const held: IdentityRecord[] = [];
  for (const signed of read.data.records) {
    const next = await nextIdentity(state, signed);
    if (!("state" in next) || !next.state.current)
      throw refused("reason" in next ? next.message : "a record is there twice.");
    state = next.state;
    held.push(next.state.current);
    hashes.push(await identityHashOf(signed.record));
  }
  const [genesis] = held;
  const last = held.at(-1);
  if (!genesis || !last) throw refused("it holds no record.");
  return { records: read.data.records, hashes, genesis, last };
}

/** Whether the records here name `hostname`: their genesis or their last record lists it. Only
 *  such a hostname gets them: a host that says it is a mind whose id it knows must not get that
 *  mind's records from this computer, to send them on. */
const namesHostname = (held: { genesis: IdentityRecord; last: IdentityRecord }, hostname: string) =>
  held.genesis.hostnames.includes(hostname) || held.last.hostnames.includes(hostname);

/** How many of the held records the published log has, counted from the genesis; undefined when
 *  the log's last record is not held here: another computer went on from these records. */
function publishedOf(hashes: string[], head: string | null) {
  if (!head) return 0;
  const at = hashes.indexOf(head);
  if (at < 0) return undefined;
  return at + 1;
}

/** What a talk with the mind needs of the world. The command gives the real ones, and a test
 *  its own. */
export type IdentityIo = {
  /** the folder of the identities */
  dir: string;
  /** asks the mind */
  fetcher: (request: Request) => Promise<Response>;
  /** waits this many milliseconds */
  pause: (ms: number) => Promise<unknown>;
  /** a line for the person before a wait */
  say: (line: string) => void;
};

const PublishedHead = z.object({
  version: z.literal(1),
  mind: IdentityHash,
  head: IdentityHash.nullable(),
});
const IntakeAnswer = z.object({
  answer: z.string(),
  mind: z.string().optional(),
  hash: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
});

/** How many bytes of the published log's answer are read: one page. A body beyond it is no
 *  answer. */
const LOG_ANSWER_BYTES = LOG_PAGE_BYTES + SIGNED_RECORD_MAX_BYTES;

/** How long the command waits before it asks the mind again: 31 seconds in all. */
const RETRY_WAITS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/** A host's words as a line of this terminal: no control or format character, so they cannot
 *  move the cursor or pass for the command's own lines, and 200 characters at most. */
const hostWords = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 200);

/** ONE QUESTION TO THE MIND, with its answer's body read whole within ten seconds and `limit`
 *  bytes; an Error for a fault of the network, and for a body that was cut off, too large or too
 *  slow. A body that is not read is cancelled. */
async function askedOnce(
  url: string,
  init: RequestInit,
  limit: number,
  fetcher: IdentityIo["fetcher"],
) {
  const deadline = deadlineIn(10_000);
  try {
    const answer = await fetcher(
      new Request(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) }),
    );
    const text = await textWithin(answer, limit, deadline.expiry);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty body is an answer that `textWithin` read whole; null is a body that it did not
    if (text === null) return new Error("its answer was cut off, too large or too slow");
    return { status: answer.status, text };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    deadline.clear();
  }
}

/** ASKS THE MIND AT `url`, AND ASKS AGAIN after a 5xx answer or a fault of the network or of the
 *  answer's body: after each wait of `RETRY_WAITS_MS`, with a line for the person. Nothing else
 *  is asked again: a 4xx is the mind's last word. Answers the status and the text, which after
 *  the last wait may still be a 5xx's. Throws when the fault stays. */
async function answerOf(url: string, init: RequestInit, limit: number, io: IdentityIo) {
  for (let tries = 0; ; tries++) {
    const answer = await askedOnce(url, init, limit, io.fetcher);
    if (!(answer instanceof Error) && answer.status < 500) return answer;
    const wait = RETRY_WAITS_MS[tries];
    if (!wait) {
      if (answer instanceof Error) throw new Error(`${url} did not answer: ${answer.message}`);
      return answer;
    }
    const fault = answer instanceof Error ? answer.message : answer.status;
    io.say(`The mind's identity log did not answer (${fault}): again in ${wait / 1000} s`);
    await io.pause(wait);
  }
}

/** Of the log that a mind publishes at `url`: its id and the hash of its last record. */
async function publishedHeadOf(url: string, io: IdentityIo) {
  const answer = await answerOf(url, {}, LOG_ANSWER_BYTES, io);
  const log = PublishedHead.safeParse(jsonOf(answer.text)).data;
  if (answer.status !== 200 || !log)
    throw new Error(`${url} answered ${answer.status} with no identity log`);
  return log;
}

/** POSTS ONE RECORD to the intake at `url`, and answers what the intake said of it: `accepted`,
 *  or `known` for a record that it had. A 200 counts only as a receipt for THIS record of THIS
 *  mind: it names the mind id and the record's hash. Throws on every other answer. */
async function postRecord(
  url: string,
  signed: SignedRecord,
  sent: { mind: string; hash: string },
  io: IdentityIo,
) {
  const answer = await answerOf(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    },
    // the intake's answer is a few names and one sentence
    4096,
    io,
  );
  const said = IntakeAnswer.safeParse(jsonOf(answer.text)).data;
  if (answer.status === 200 && (said?.answer === "accepted" || said?.answer === "known")) {
    if (said.mind === sent.mind && said.hash === sent.hash) return said.answer;
    throw new Error(
      `${url} answered 200 with no receipt for the record that was sent: it named another mind or record.`,
    );
  }
  const reason = said?.reason ? ` ${hostWords(said.reason)}` : "";
  const message = said?.message ? `: ${hostWords(said.message)}` : "";
  throw new Error(`${url} did not take the record (${answer.status}${reason})${message}`);
}

/** POSTS THE RECORDS THAT THE MIND'S PUBLISHED LOG LACKS, oldest first, to the intake at the
 *  control plane's hostname. It reads the published log first. A record more in the file is one
 *  post more. Then, with the root key on this computer, it LISTS THE STACK'S WORKING KEY: a
 *  record that names the key the stack shows, when the last record does not name it
 *  (`workingKeyRecord`). Until a record lists it, the mind signs nothing as itself.
 *
 *  THE LAST RECORD HERE IS POSTED EVEN WHEN THE LOG HAS IT. The intake then answers `known`, and
 *  that request makes the stack deliver to the mind's own log the events that it still owes. So
 *  every run sends one request at least, and a second run harms nothing.
 *
 *  A deploy knows `mindId` from its config, and asks nothing of a mind whose records are not
 *  here. Without `mindId` the id is the one that the mind publishes. Either way the records go
 *  only to a hostname that they name (`namesHostname`), and nothing is signed for another.
 *  Answers undefined when this computer holds no
 *  records of the mind. Else: `taken`, how many records the intake took now; `here`, how many
 *  are here; `published`, how many of them the log shows after the posts (undefined: the log's
 *  last record is not here, so nothing here continues it and nothing was sent); and
 *  `emptyBefore`, whether the log had no record before. Throws with what failed. */
export async function postIdentity(
  mind: { controlPlaneHostname: string; mindId?: string },
  io: IdentityIo,
) {
  if (mind.mindId && !existsSync(recordsFileOf(io.dir, mind.mindId))) return undefined;
  const url = `https://${mind.controlPlaneHostname}${MIND_IDENTITY_PATH}`;
  const before = await publishedHeadOf(url, io);
  const mindId = mind.mindId || before.mind;
  if (before.mind !== mindId)
    throw new Error(`${url} is the log of the mind ${before.mind}, and this mind is ${mindId}`);
  const held = await heldIdentity(io.dir, mindId);
  if (!held) return undefined;
  if (!namesHostname(held, mind.controlPlaneHostname))
    throw new Error(
      `The records of the mind ${mindId} on this computer do not name ${mind.controlPlaneHostname}. Nothing was sent.`,
    );
  const emptyBefore = !before.head;
  const known = publishedOf(held.hashes, before.head);
  if (known === undefined)
    return { mindId, taken: 0, here: held.records.length, published: known, emptyBefore };
  let taken = 0;
  const posted = async (signed: SignedRecord, hash: string) => {
    if ((await postRecord(url, signed, { mind: mindId, hash }, io)) === "accepted") taken++;
  };
  for (let at = Math.min(known, held.records.length - 1); at < held.records.length; at++)
    await posted(held.records[at]!, held.hashes[at]!);
  const hashes = [...held.hashes];
  const listing = await workingKeyRecord(mind.controlPlaneHostname, mindId, held, io);
  if (listing) {
    hashes.push(listing.hash);
    await posted(listing.signed, listing.hash);
  }
  const here = hashes.length;
  // "published" is what the log shows, not what the intake said
  const after = await publishedHeadOf(url, io);
  const published = after.mind === mindId ? publishedOf(hashes, after.head) : undefined;
  if (published === undefined)
    throw new Error(
      `After the posts, ${url} shows a log that does not end in a record of this computer.`,
    );
  return { mindId, taken, here, published, emptyBefore };
}

/** The working key that this command lists for the stack, and replaces when the stack's key
 *  changes. */
const isStackKey = (key: { label?: string; purpose: string }) =>
  key.label === "stack" && key.purpose === "statements";

/** What `STACK_KEY_PATH` answers (iterate/signed `StackKeyDocument`), as far as the command reads
 *  it. */
const StackKey = z.object({
  mind: z.string(),
  key: z.string(),
  publicKey: z.string(),
  algorithm: z.literal("ML-DSA-65"),
});

/** THE RECORD THAT LISTS THE STACK'S WORKING KEY, signed, checked and saved at the end of the
 *  records file, with its hash; undefined when the last record here lists it already, or when
 *  the root key is not on this computer. The stack makes its key itself and shows it as a
 *  candidate at `https://<control plane>/keys/stack.json`. The new record is the last one's
 *  content with that key in place of the stack's key of before (label `stack`, purpose
 *  `statements`), signed by the root key in the key file. Every other working key stays. A stack
 *  whose key changed (a new database) gets a record that names the new key in place of the old. The caller has checked that the records
 *  name the hostname (`namesHostname`).
 *
 *  KNOWN AND ACCEPTED: the key is read over TLS from the mind's own hostname, so whoever answers
 *  there gets their key listed. The design's later way is the deploy's own output, which names
 *  the key with no fetch. */
async function workingKeyRecord(
  controlPlaneHostname: string,
  mindId: string,
  held: NonNullable<Awaited<ReturnType<typeof heldIdentity>>>,
  io: IdentityIo,
) {
  if (!existsSync(keyFileOf(io.dir, mindId))) return undefined;
  const url = `https://${controlPlaneHostname}${STACK_KEY_PATH}`;
  // the stack's key document is a raw key of 1952 bytes as base64url, and a few names
  const answer = await answerOf(url, {}, 16 * 1024, io);
  const stack = StackKey.safeParse(jsonOf(answer.text)).data;
  if (answer.status !== 200 || !stack || stack.mind !== controlPlaneHostname)
    throw new Error(`${url} answered ${answer.status} with no ML-DSA-65 key of the stack`);
  if (
    !/^[A-Za-z0-9_-]+$/.test(stack.publicKey) ||
    fromBase64url(stack.publicKey).length !== 1952 ||
    (await identityKeyIdOf(stack.publicKey)) !== stack.key
  )
    throw new Error(`${url} shows a key that is no ML-DSA-65 key under its own id`);
  const { last } = held;
  if (
    last.workingKeys.some(
      (key) => key.purpose === "statements" && key.publicKey === stack.publicKey,
    )
  )
    return undefined;
  const head = held.hashes.at(-1)!;
  const record = identityRecordText({
    ...last,
    prev: head,
    nonce: undefined,
    workingKeys: [
      // only the stack's own key of before: every other working key stays as it is listed
      ...last.workingKeys.filter((key) => !isStackKey(key)),
      {
        signs: "raw",
        algorithm: "ML-DSA-65",
        publicKey: stack.publicKey,
        label: "stack",
        purpose: "statements",
      },
    ],
  });
  const root = await rootKeyOf(io.dir, mindId);
  const signed = {
    record,
    signatures: [
      await signIdentityRecord(record, root.signer, await identityKeyIdOf(root.publicKey)),
    ],
  };
  const checked = await nextIdentity(
    { expected: mindId, head, position: held.records.length, current: last },
    signed,
  );
  if (!("state" in checked))
    throw new Error(
      `The record that lists the stack's key did not pass its own check (${"reason" in checked ? checked.message : "known"}).`,
    );
  // saved before it is sent: a post whose answer is lost leaves the record here, and the next
  // post sends it again
  writeWhole(recordsFileOf(io.dir, mindId), {
    version: 1,
    mind: mindId,
    records: [...held.records, signed],
  });
  return { signed, hash: await identityHashOf(record) };
}

/** `iterate identity show`: the mind's id as the mind publishes it, and what this computer holds
 *  of it: the hostnames of the last record, how many records are here and how many of them are
 *  published, and where the key file is. Records that do not name the hostname are not shown. */
export async function shownIdentity(controlPlaneHostname: string, io: IdentityIo) {
  const url = `https://${controlPlaneHostname}${MIND_IDENTITY_PATH}`;
  const log = await publishedHeadOf(url, io);
  const held = await heldIdentity(io.dir, log.mind);
  if (!held)
    return { mind: log.mind, records: "none on this computer: another computer has its key" };
  if (!namesHostname(held, controlPlaneHostname))
    return {
      mind: log.mind,
      records: `the records of this mind id on this computer do not name ${controlPlaneHostname}`,
    };
  const published = publishedOf(held.hashes, log.head);
  const keyFile = keyFileOf(io.dir, log.mind);
  return {
    mind: log.mind,
    hostnames: held.last.hostnames,
    records: {
      here: held.records.length,
      published:
        published === undefined
          ? "more than here: another computer went on from these records"
          : published,
    },
    key: existsSync(keyFile) ? keyFile : "not on this computer",
  };
}
