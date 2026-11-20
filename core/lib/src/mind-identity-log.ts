// mind-identity-log.ts — THE LOG OF A MIND'S IDENTITY (`iterate/mind-identity-log`): the records
// of ./mind-identity.ts as a context holds them, and as a mind publishes them.
//
// A CONTEXT HOLDS A LOG AS TWO EVENT TYPES, which only the platform writes: a record that was
// checked and accepted, and one that was refused. `/` holds the mind's own log, as a projection
// of the rows that the auth Worker accepted: the rows decide, and the events decide nothing. A
// signature check is asynchronous and a reduce is not, so the check (`nextIdentity`) runs before
// an event exists, and the reduce here trusts the event's type.
//
// A MIND PUBLISHES ITS LOG at `/.well-known/iterate`, on every hostname that the log's last
// record lists. `publishedMindOf` reads another mind's log there and runs the check on every
// record itself: nothing in the document is believed but what its signatures prove.
import { z } from "zod";
import {
  IdentityHash,
  IdentityHostname,
  IdentityRecord,
  type IdentityState,
  identityStateFrom,
  nextIdentity,
} from "./mind-identity.ts";
import { STACK_KEY_PATH } from "./signed.ts";

/** Where a mind publishes its log (`GET`), and where a signed record is posted to it (`POST`, on
 *  the control plane's hostname alone). core/auth-worker answers both. */
export const MIND_IDENTITY_PATH = "/.well-known/iterate";

/** One record with its signatures, as JSON, is under this many bytes: the text is at most 64 KiB
 *  and at most doubles when it is written as a JSON string, and 16 signatures are under 72 KiB.
 *  An intake reads no more of a body than this. */
export const SIGNED_RECORD_MAX_BYTES = 256 * 1024;

/** A page of a published log ends with the record that takes it past this size, so no page is
 *  larger than this and one record more. */
export const LOG_PAGE_BYTES = 512 * 1024;

/** What `events.iterate.com/mind/identity-record-accepted` carries: a record that the check
 *  accepted as the next of the log of the mind `mind`. `record` is the exact text that was
 *  signed, `hash` its SHA-256, `signedBy` the root keys whose signatures verified. */
export const IdentityRecordAccepted = z.object({
  mind: IdentityHash,
  hash: IdentityHash,
  record: z.string(),
  signatures: z.array(z.object({ key: z.string(), sig: z.string() })),
  signedBy: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      algorithm: z.enum(["ML-DSA-65", "Ed25519", "P-256"]),
      signs: z.enum(["raw", "sshsig"]),
      userVerified: z.boolean().optional(),
    }),
  ),
});
export type IdentityRecordAccepted = z.infer<typeof IdentityRecordAccepted>;

/** What `events.iterate.com/mind/identity-record-refused` carries: a record that a current root
 *  key validly signed and that the check refused all the same, with the check's `reason` and its
 *  one sentence. */
export const IdentityRecordRefused = z.object({
  mind: IdentityHash,
  hash: IdentityHash.optional(),
  reason: z.string(),
  message: z.string(),
  record: z.string().optional(),
  signatures: IdentityRecordAccepted.shape.signatures.optional(),
});
export type IdentityRecordRefused = z.infer<typeof IdentityRecordRefused>;

/** ONE MIND ID'S LOG IN A CONTEXT'S REDUCED STATE: its last accepted record and its last
 *  refusal. It is there from the genesis on, so it always has a head. */
export const ReducedIdentity = z.object({
  head: IdentityHash,
  /** How many records are accepted: 1 is the genesis. */
  position: z.number().int().min(1),
  /** The last accepted record: the whole identity. */
  current: IdentityRecord,
  /** The last refused record: where its event is, and the check's reason. */
  refused: z.object({ offset: z.number().int().positive(), reason: z.string() }).nullable(),
});
export type ReducedIdentity = z.infer<typeof ReducedIdentity>;

/** EVERY IDENTITY LOG THAT A CONTEXT HOLDS, each under its mind id, side by side. Nothing
 *  chooses one of them here and nothing empties one: an event folds into the log of the mind id
 *  that it names, whatever a deploy's config says the mind's id is. So a mind that gets
 *  another id, and the first one again, has both logs whole. The state is a projection of what
 *  the auth Worker accepted: it decides nothing. */
export const ReducedIdentities = z.record(z.string(), ReducedIdentity);
export type ReducedIdentities = z.infer<typeof ReducedIdentities>;

/** THE ONE READER OF "THIS MIND'S IDENTITY": the log of the mind id `mind` in the reduced
 *  state, or null before its genesis is folded. `mind` is the config's `mindId` for a mind's
 *  own identity. */
export const identityOfMind = (identities: ReducedIdentities, mind: string) =>
  (Object.hasOwn(identities, mind) && identities[mind]) || null;

/** The log of `mind` as `nextIdentity` takes it: before the genesis, a log with no head; after
 *  it, the reduced log. Null when the reduced log is no state that the check takes
 *  (`identityStateFrom`): a caller of the check narrows through this, so a state that would
 *  skip the last record's root keys never reaches it. */
export function identityStateOf(identities: ReducedIdentities, mind: string): IdentityState | null {
  const log = identityOfMind(identities, mind);
  if (!log) return identityStateFrom({ expected: mind, head: null, position: 0, current: null });
  const { head, position, current } = log;
  return identityStateFrom({ expected: mind, head, position, current });
}

/** THE REDUCE OF AN ACCEPTED RECORD: the logs with the record folded into the log of the mind
 *  id that the event names, or undefined when the record does not continue that log. A genesis
 *  opens a log: it has no record before it and its hash is the mind id. Any later record
 *  continues the head. It checks no signature: only the platform writes the event, after the
 *  check. An event that arrives out of its order, or again, is passed over and stays in the
 *  context's log as history. */
export function identitiesAfterAccepted(
  identities: ReducedIdentities,
  accepted: IdentityRecordAccepted,
): ReducedIdentities | undefined {
  const record = recordOf(accepted.record);
  if (!record) return undefined;
  const log = identityOfMind(identities, accepted.mind);
  if (!log) {
    if (record.prev || accepted.hash !== accepted.mind) return undefined;
    return {
      ...identities,
      [accepted.mind]: { head: accepted.hash, position: 1, current: record, refused: null },
    };
  }
  if (record.prev !== log.head) return undefined;
  return {
    ...identities,
    [accepted.mind]: { ...log, head: accepted.hash, position: log.position + 1, current: record },
  };
}

/** THE REDUCE OF A REFUSED RECORD: the log of the mind id that the event names keeps its latest
 *  refusal. Undefined for a mind id with no log: a record is refused with an event only when a
 *  root key of the log's last record signed it. */
export function identitiesAfterRefused(
  identities: ReducedIdentities,
  refused: IdentityRecordRefused,
  offset: number,
): ReducedIdentities | undefined {
  const log = identityOfMind(identities, refused.mind);
  if (!log) return undefined;
  return {
    ...identities,
    [refused.mind]: { ...log, refused: { offset, reason: refused.reason } },
  };
}

/** A record's text as a record, or null. The platform wrote the text after the check read it, so
 *  null means an event that the platform did not write. */
function recordOf(text: string): IdentityRecord | null {
  const read = IdentityRecord.safeParse(jsonOf(text));
  if (!read.success) return null;
  return read.data;
}

/** WHAT A MIND PUBLISHES at `MIND_IDENTITY_PATH`: its id, the hash of its last record, and its
 *  records with their signatures, oldest first. `?after=<hash>` answers the records after that
 *  one. A page has at most 64 records and may end before the head (`LOG_PAGE_BYTES`); the reader
 *  then asks for the rest. A record is read by `nextIdentity` alone, so the document's schema
 *  leaves each as it comes. */
const PublishedLogAsRead = z.object({
  version: z.literal(1),
  mind: IdentityHash,
  head: IdentityHash.nullable(),
  records: z.array(z.unknown()).max(64),
});
/** The document as its writer gives it: each record with its signatures. */
export type PublishedLog = {
  version: 1;
  mind: string;
  head: string | null;
  records: { record: string; signatures: { key: string; sig: string }[] }[];
};

/** A mind's identity as its log proves it: the state after the log's last record. `expected` is
 *  the mind id, and `current` the whole identity. */
export type PublishedMind = Extract<IdentityState, { head: string }>;

/** A reader asks for at most this many pages of one log. */
const LOG_MAX_PAGES = 64;

/** THE ANSWERS KEPT, NEVER A READ THAT IS UNDER WAY. A promise belongs to the request that made
 *  it: when that request ends before its read settles (its caller went away), workerd settles
 *  nothing of it, and a later request that awaits the promise throws. So each call that finds no
 *  answer reads for itself, and the first read to settle is the answer kept. */
const published = new Map<string, { until: number; answer: PublishedMind | { why: string } }>();

/** THE IDENTITY THAT THE MIND AT `hostname` PUBLISHES, or why there is none. It reads the log
 *  at that hostname, checks every record with `nextIdentity`, from the genesis or from `from` (a
 *  state the reader holds already, whose records it does not ask for again), and takes the log
 *  only when its last record lists `hostname`. So the id it answers is the hash of a genesis
 *  whose root keys signed every step to that hostname.
 *
 *  `hostname` is a lowercase DNS name and nothing more, and `from` a state that a log can stand
 *  at: both are checked before anything is asked or remembered, so a caller's text never becomes
 *  another address, port or path. No redirect is followed. The whole read, every page and every
 *  check of it, ends at five seconds: a stranger who names a mind must not make the reader wait
 *  on a host, or work for one after it stopped waiting.
 *
 *  One answer is kept a minute for each hostname, expected id and head, and it cannot be
 *  changed: a stranger must not make the reader ask a host often. Calls that come before any
 *  answer is kept each read (`published`). An answer after `fetcher` itself failed is not kept:
 *  that is the reader's own way out, which may work at the next call. A host with no log is
 *  another host's fault and is kept. */
export function publishedMindOf(
  hostname: string,
  fetcher: (request: Request) => Promise<Response>,
  from?: PublishedMind,
): Promise<PublishedMind | { why: string }> {
  if (!IdentityHostname.safeParse(hostname).success)
    return Promise.resolve({ why: "a mind is read at a lowercase DNS hostname, and nothing more" });
  const start = from && identityStateFrom(from);
  if (from && !start?.head)
    return Promise.resolve({ why: "the state to read on from is no state of a log with a record" });
  const name = `${hostname} ${start?.expected || ""} ${start?.head || ""}`;
  const kept = published.get(name);
  if (kept && kept.until > Date.now()) return Promise.resolve(kept.answer);
  const url = `https://${hostname}${MIND_IDENTITY_PATH}`;
  const deadline = deadlineIn(5_000);
  let fetcherFailed = false;
  return readLog({
    url,
    hostname,
    from: start?.head ? start : undefined,
    deadline,
    fetcher: (request) =>
      fetcher(request).catch((error: unknown) => {
        fetcherFailed = true;
        throw error;
      }),
  })
    .then(frozen, (error: unknown) => ({ why: `${url}: ${String(error).slice(0, 200)}` }))
    .then((answer) => {
      const now = Date.now();
      const first = published.get(name);
      // another read of the same log settled first: its answer stays for its minute
      if (fetcherFailed || (first && first.until > now)) return answer;
      // the oldest answer goes: a full cache never drops them all at once
      const oldest = published.size >= 1_000 ? published.keys().next().value : undefined;
      if (oldest) published.delete(oldest);
      published.set(name, { until: now + 60_000, answer });
      return answer;
    })
    .finally(deadline.clear);
}

async function readLog({
  url,
  hostname,
  from,
  deadline,
  fetcher,
}: {
  url: string;
  hostname: string;
  from: PublishedMind | undefined;
  deadline: Deadline;
  fetcher: (request: Request) => Promise<Response>;
}): Promise<PublishedMind | { why: string }> {
  const late = { why: `${url} was not read in five seconds` };
  let state: IdentityState | undefined = from;
  for (let page = 0; page < LOG_MAX_PAGES; page++) {
    if (deadline.passed()) return late;
    const pageUrl = state?.head ? `${url}?after=${state.head}` : url;
    const asked = fetcher(new Request(pageUrl, { redirect: "manual" }));
    const answer = await Promise.race([asked, deadline.expiry]);
    if (!answer) {
      // an answer that comes after the deadline is not read
      void asked.then((unread) => unread.body?.cancel()).catch(() => {});
      return late;
    }
    const text = answer.ok
      ? await textWithin(answer, LOG_PAGE_BYTES + SIGNED_RECORD_MAX_BYTES, deadline.expiry)
      : null;
    await answer.body?.cancel().catch(() => {});
    if (deadline.passed()) return late;
    const log = PublishedLogAsRead.safeParse(text ? jsonOf(text) : null);
    if (!log.success) return { why: `${pageUrl} answered ${answer.status} with no identity log` };
    const { mind, head, records } = log.data;
    state ||= { expected: mind, head: null, position: 0, current: null };
    if (mind !== state.expected) return { why: `${pageUrl} is the log of another mind` };
    if (!head) return { why: `${url} has no record yet` };
    if (records.length === 0 && state.head !== head)
      return { why: `${pageUrl} ends before the head that it names` };
    for (const signed of records) {
      if (deadline.passed()) return late;
      const next = await nextIdentity(state, signed);
      if ("reason" in next)
        return { why: `${pageUrl} has a record that does not continue its log: ${next.reason}` };
      // A page starts after the record that the reader stands at, so it never holds that
      // record: a host that repeats it would be asked for the same page again.
      if ("known" in next) return { why: `${pageUrl} repeats a record that the reader has` };
      state = next.state;
    }
    if (state.head && state.head === head) {
      if (!state.current.hostnames.includes(hostname))
        return { why: `the log at ${url} does not list ${hostname}` };
      return state;
    }
  }
  return { why: `${url} has more than ${LOG_MAX_PAGES} pages` };
}

/** `value` and everything in it, frozen: one answer is handed to every caller of a minute. */
function frozen<Value>(value: Value): Value {
  if (typeof value !== "object" || !value || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const part of Object.values(value)) frozen(part);
  return value;
}

/** One moment that several waits end at: `expiry` resolves with no value when it comes, and
 *  `passed` says whether it has. `clear` ends the timer, which would otherwise keep a Durable
 *  Object awake for its whole length. */
export type Deadline = { passed: () => boolean; expiry: Promise<undefined>; clear: () => void };

export function deadlineIn(ms: number): Deadline {
  let passed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      passed = true;
      resolve(undefined);
    }, ms);
  });
  return { passed: () => passed, expiry, clear: () => clearTimeout(timer) };
}

/** A body's text when it is at most `limit` bytes and is read before `expiry` resolves, else
 *  null: a body that is too large, that comes too slowly, or that its sender cut off. It stops
 *  reading at the limit and at the expiry, and cancels the stream: the sender is another party,
 *  and what it sends must not be held whole or waited for. */
export async function textWithin(
  sent: Pick<Response, "headers" | "body">,
  limit: number,
  expiry: Promise<undefined>,
): Promise<string | null> {
  if (Number(sent.headers.get("content-length") || 0) > limit) return null;
  if (!sent.body) return "";
  const reader = sent.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expiry]);
      if (!next) return null;
      if (next.done) break;
      // the cast: a body's stream holds bytes, which the Workers' types leave untyped
      const chunk = next.value as Uint8Array;
      size += chunk.byteLength;
      if (size > limit) return null;
      chunks.push(chunk);
    }
  } catch {
    // a sender that went away in the middle of its body sent no body
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** `text` as JSON, or null: no JSON is no record and no log. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** THE TWO PATHS THAT A MIND'S OWN CODE NEVER ANSWERS, on any hostname: the identity log's and
 *  the stack key's (./signed.ts `STACK_KEY_PATH`). Both are read at a hostname as the word of
 *  the mind there, so code that answered one could publish a log or a key as that mind. This is
 *  the one decision for every entrance to the mind's code: the path that `pathname` is, and
 *  whether it is spelled exactly. A spelling that a server or a client may take for the same
 *  path is reserved too: another case, repeated or trailing slashes, and percent-encoded
 *  characters. Null: an ordinary path. */
export function reservedPathOf(
  pathname: string,
): { path: typeof MIND_IDENTITY_PATH | typeof STACK_KEY_PATH; exact: boolean } | null {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // a malformed escape is no escape: the path is compared as it is written
  }
  const plain = decoded.toLowerCase().replace(/\/+/g, "/").replace(/\/$/, "");
  for (const path of [MIND_IDENTITY_PATH, STACK_KEY_PATH] as const)
    if (plain === path) return { path, exact: pathname === path };
  return null;
}
