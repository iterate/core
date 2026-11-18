// identity.ts — THE MIND'S IDENTITY IN THE AUTH WORKER (iterate/mind-identity): the intake of a
// signed record, the row of every record it accepted, the delivery of each row to the mind's own
// log, and the log that the mind publishes.
//
// `POST /.well-known/iterate` on the control plane's hostname takes `{ record, signatures }` from
// anyone, with no sign-in: a record proves itself. The check is `nextIdentity`, which reads
// nothing but the log's state and the record. What such a check cannot do is done here:
//   - the body is bounded in bytes and in time before it is parsed;
//   - a record that was accepted before, under this mind id or an earlier one, is answered from
//     its row and never from the request, which may carry other signatures;
//   - the row is written only while the head is still the one that the check read, so of two
//     records for one place one is accepted;
//   - a refusal is an event at most once for each record, and only for a record that a current
//     root key signed. Any other refusal is an HTTP error and a line of telemetry: the intake is
//     open, and a stranger must not write into the mind's root context.
//
// THE ROWS HERE ARE THE AUTHORITY. Whether a record is the next one, whether the stack may sign
// (./stack-key.ts) and what the mind publishes are all read from these rows, and from nothing
// else. The mind's root context, `/`, holds each accepted record and each refusal as an event:
// a copy for people and for the mind's own code, which decides nothing. An event is appended at
// least once, under one key for ever (`mind/identity-record:<hash>`, and the refusal's), so an
// append of one that `/` holds already adds nothing.
//
// So the rows never wait for `/`. A record is accepted when the check says so against the stored
// head, and the intake's answer says what the rows say, whatever `/` holds.
//
// THE BOUNDARY DELIVERS, AS WELL AS IT CAN, AND IT ALONE MARKS. A row is written undelivered.
// After every request to the intake the boundary asks for the facts that are not delivered
// (`identityFactsToDeliver`), appends them on `/`, and marks each only once its append has
// resolved (`identityFactsDelivered`). `/` folds an accepted record only when it continues the
// record before it, so the facts of one mind id come in the order of its log, and the boundary
// appends none of them after one that failed. Whatever stops in between (a failed append, a
// Worker that ends after the row is written) leaves an unmarked row, which the next request to
// the intake, by anyone, delivers.
import { reportIssue } from "iterate/lib";
import {
  IdentityHash,
  identityHashOf,
  IdentityRecord,
  type IdentityState,
  type NextIdentity,
  nextIdentity,
  RECORD_MAX_BYTES,
  SignedRecord,
} from "iterate/mind-identity";
import {
  deadlineIn,
  IdentityRecordAccepted,
  IdentityRecordRefused,
  jsonOf,
  LOG_PAGE_BYTES,
  type PublishedLog,
  SIGNED_RECORD_MAX_BYTES,
  textWithin,
} from "iterate/mind-identity-log";
import type { IdentityFact } from "iterate/workers";
import { z } from "zod";
import { configOf, type Env } from "./env.ts";

/** A row of `identity_records` (../migrations), without its times. */
type AcceptedRow = {
  hash: string;
  mind: string;
  position: number;
  record: string;
  signatures: string;
  signed_by: string;
};

/** A row of `identity_refusals`, without its times. */
type RefusedRow = {
  hash: string;
  mind: string;
  reason: string;
  message: string;
  record: string;
  signatures: string;
};

/** WHERE THE MIND'S OWN LOG STANDS, from the rows: what the next record is checked against. The
 *  log is the one of the config's `mindId`; the rows of an id that the mind had before are
 *  history. */
export async function identityOf(env: Env): Promise<IdentityState> {
  const expected = configOf(env).mindId;
  const head = await env.DB.prepare(
    `select hash, position, record from identity_records
     where mind = ?1 order by position desc limit 1`,
  )
    .bind(expected)
    .first<Pick<AcceptedRow, "hash" | "position" | "record">>();
  if (!head) return { expected, head: null, position: 0, current: null };
  return {
    expected,
    head: head.hash,
    position: head.position,
    current: IdentityRecord.parse(JSON.parse(head.record)),
  };
}

const encoder = new TextEncoder();

/** How long a sender has to send its body: far more than 256 KiB take on any connection. */
const BODY_READ_MS = 10_000;

/** THE INTAKE: `{ record, signatures }` as JSON. Its answer says what the rows say, and nothing
 *  of the mind's own log: `accepted` or `known` (200), or `refused` with the check's `reason`
 *  and its sentence (400, or 409 for a record that is not the next). It carries no event: the
 *  boundary delivers what is not delivered after every answer of this intake. */
export async function identityIntakeResponse(env: Env, request: Request): Promise<Response> {
  const deadline = deadlineIn(BODY_READ_MS);
  const body = await textWithin(request, SIGNED_RECORD_MAX_BYTES, deadline.expiry).finally(
    deadline.clear,
  );
  const signed = SignedRecord.safeParse(body ? jsonOf(body) : null);
  // A text with a lone surrogate has no UTF-8 bytes, so it has no hash. The bound in bytes
  // comes before the hash and before any row is read: a text of many-byte characters passes the
  // schema's bound in characters at up to three times the size.
  if (
    !signed.success ||
    !signed.data.record.isWellFormed() ||
    encoder.encode(signed.data.record).length > RECORD_MAX_BYTES
  ) {
    console.info({ event: "auth.identity-record-refused", reason: "not-a-signed-record" });
    return Response.json(
      {
        answer: "refused",
        reason: "not-a-signed-record",
        message: `Send { record, signatures } as JSON, in at most ${SIGNED_RECORD_MAX_BYTES} bytes and ten seconds.`,
      },
      { status: 400 },
    );
  }
  const hash = await identityHashOf(signed.data.record);
  // Two looks at most. The second is for a request that another one overtook between its check
  // and its write: the record is then known (the same record, sent twice at once) or refused.
  for (let look = 0; look < 2; look++) {
    const known = await env.DB.prepare(
      `select mind, position from identity_records where hash = ?1`,
    )
      .bind(hash)
      .first<Pick<AcceptedRow, "mind" | "position">>();
    if (known) return Response.json({ answer: "known", hash, ...known });
    const state = await identityOf(env);
    const next = await nextIdentity(state, signed.data);
    if ("known" in next) continue;
    if ("reason" in next) {
      const refusal = await refusedResponse(env, hash, signed.data, state, next);
      if (refusal) return refusal;
      continue;
    }
    const row = {
      hash,
      mind: next.state.expected,
      position: next.state.position,
      record: signed.data.record,
      signatures: JSON.stringify(signed.data.signatures),
      signed_by: JSON.stringify(next.signedBy),
    };
    // What the record takes in a published page: its entry as JSON, and the comma after it.
    const pageBytes = encoder.encode(JSON.stringify(pageEntryOf(row))).length + 1;
    if (!(await writtenAtHead(env, row, state.head, pageBytes))) continue;
    console.info({
      event: "auth.identity-record-accepted",
      mind: row.mind,
      hash,
      position: row.position,
    });
    return Response.json({ answer: "accepted", hash, mind: row.mind, position: row.position });
  }
  return Response.json(
    {
      answer: "retry",
      reason: "busy",
      message: "Other records were accepted at the same moment. Send the same request again.",
    },
    { status: 503, headers: { "retry-after": "1" } },
  );
}

/** A row as an entry of a published page: the record's text and its signatures. */
const pageEntryOf = (row: Pick<AcceptedRow, "record" | "signatures">) => ({
  record: row.record,
  signatures: IdentityRecordAccepted.shape.signatures.parse(JSON.parse(row.signatures)),
});

/** Writes `row`, undelivered, in the one statement that also checks that the log's head is still
 *  `head`, the head that the check read. Says whether it wrote. The table's own rules refuse a
 *  second record at a position or after a record. */
async function writtenAtHead(
  env: Env,
  row: AcceptedRow,
  head: string | null,
  pageBytes: number,
): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    `insert into identity_records
       (hash, mind, prev, position, record, signatures, signed_by, page_bytes, accepted_at)
     select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     where (select hash from identity_records where mind = ?2 order by position desc limit 1) is ?3
     on conflict do nothing`,
  )
    .bind(
      row.hash,
      row.mind,
      head,
      row.position,
      row.record,
      row.signatures,
      row.signed_by,
      pageBytes,
      Date.now(),
    )
    .run();
  return meta.changes > 0;
}

/** The reasons that say nothing about the record: the check could not run. They are this
 *  Worker's own error. */
const CHECK_FAULTS: ReadonlySet<string> = new Set([
  "state-not-valid",
  "no-ml-dsa-runtime",
  "check-failed",
]);

/** The answer to a record that the check refused against `state`, or null when the rows moved on
 *  since the check read them, so that the record must be looked at again. A record that a
 *  current root key signed gets a row of `identity_refusals` with what its event says, written
 *  only while the head is still the one that the check read and while no row accepts the record:
 *  a root key that a later record removed says nothing, and a record that was accepted meanwhile
 *  was not refused. */
async function refusedResponse(
  env: Env,
  hash: string,
  signed: SignedRecord,
  state: IdentityState,
  { reason, message, signedByCurrentRoot }: Extract<NextIdentity, { reason: string }>,
): Promise<Response | null> {
  if (CHECK_FAULTS.has(reason)) {
    reportIssue("auth.identity-check-failed", new Error(message), { reason, hash });
    return Response.json({ answer: "failed", reason, message }, { status: 500 });
  }
  console.info({ event: "auth.identity-record-refused", reason, hash, signedByCurrentRoot });
  const answer = Response.json(
    { answer: "refused", reason, message },
    { status: reason === "not-next" ? 409 : 400 },
  );
  if (!signedByCurrentRoot) return answer;
  const { meta } = await env.DB.prepare(
    `insert into identity_refusals (hash, mind, reason, message, record, signatures, refused_at)
     select ?1, ?2, ?3, ?4, ?5, ?6, ?7
     where (select hash from identity_records where mind = ?2 order by position desc limit 1) is ?8
       and not exists (select 1 from identity_records where hash = ?1)
     on conflict do nothing`,
  )
    .bind(
      hash,
      state.expected,
      reason,
      message,
      signed.record,
      JSON.stringify(signed.signatures),
      Date.now(),
      state.head,
    )
    .run();
  if (meta.changes > 0) return answer;
  // Nothing was written: the record has its one refusal already, or the rows moved on.
  const refusedBefore = await env.DB.prepare(
    `select 1 as refused from identity_refusals where hash = ?1`,
  )
    .bind(hash)
    .first();
  if (refusedBefore) return answer;
  return null;
}

/** How many facts one answer holds. A fact is at most a record's 64 KiB of text and its 16
 *  signatures, about 140 KB, so one answer and the one append of its events stay near 1 MB. */
const FACTS_AT_ONCE = 8;

/** `AuthService.identityFactsToDeliver`: the rows that `/` does not hold. The accepted records
 *  come first: those of every mind id, each id's in the order of its log, and each fact names
 *  its mind id, so that none is appended after one of the same id that failed. A record of a
 *  mind id that the config no longer names is delivered like any other: `/` keeps a log for
 *  each id. The refusals follow, oldest first. */
export async function identityFactsToDeliver(env: Env): Promise<IdentityFact[]> {
  const { results: accepted } = await env.DB.prepare(
    `select hash, mind, position, record, signatures, signed_by from identity_records
     where delivered_at is null order by mind, position limit ?1`,
  )
    .bind(FACTS_AT_ONCE)
    .all<AcceptedRow>();
  const { results: refused } = await env.DB.prepare(
    `select hash, mind, reason, message, record, signatures from identity_refusals
     where delivered_at is null order by refused_at limit ?1`,
  )
    .bind(FACTS_AT_ONCE - accepted.length)
    .all<RefusedRow>();
  return [...accepted.map(acceptedFact), ...refused.map(refusedFact)];
}

/** A row as the fact that takes it to `/`. The event is made from the row alone and has the
 *  one key of its record, so every delivery of it is the same event, which the log keeps once. */
function acceptedFact(row: AcceptedRow): IdentityFact {
  return {
    id: `accepted:${row.hash}`,
    mind: row.mind,
    event: {
      type: "events.iterate.com/mind/identity-record-accepted",
      idempotencyKey: `mind/identity-record:${row.hash}`,
      payload: IdentityRecordAccepted.parse({
        mind: row.mind,
        hash: row.hash,
        record: row.record,
        signatures: JSON.parse(row.signatures),
        signedBy: JSON.parse(row.signed_by),
      }),
    },
  };
}

/** A refusal's row as its fact: what the request that was refused sent, and what the check
 *  said of it. No later request changes it. */
function refusedFact(row: RefusedRow): IdentityFact {
  return {
    id: `refused:${row.hash}`,
    event: {
      type: "events.iterate.com/mind/identity-record-refused",
      idempotencyKey: `mind/identity-record-refused:${row.hash}`,
      payload: IdentityRecordRefused.parse({ ...row, signatures: JSON.parse(row.signatures) }),
    },
  };
}

/** `AuthService.identityFactsDelivered`: the events of these facts are stored on `/`. Only the
 *  boundary says so, after its own append resolved. An id that names no fact marks nothing. */
export async function identityFactsDelivered(env: Env, ids: string[]): Promise<void> {
  const now = Date.now();
  const marks = z
    .array(z.string().max(200))
    .max(4 * FACTS_AT_ONCE)
    .parse(ids)
    .flatMap((id) => {
      const [, table, hash] = /^(accepted|refused):([0-9a-f]{64})$/.exec(id) || [];
      if (!hash) return [];
      return env.DB.prepare(
        `update ${table === "accepted" ? "identity_records" : "identity_refusals"}
         set delivered_at = ?1 where hash = ?2 and delivered_at is null`,
      ).bind(now, hash);
    });
  if (marks.length > 0) await env.DB.batch(marks);
}

/** THE LOG THAT THE MIND PUBLISHES (iterate/mind-identity-log `PublishedLog`), as `hostname`
 *  answers it: the accepted records of the config's `mindId`, oldest first, or the ones after
 *  the record `after`. The control plane's hostname always answers, with no record before the
 *  genesis. Any other hostname answers only while the log's last record lists it, and is 404
 *  otherwise: a hostname of the mind's zones is not the mind's name until a root key said so.
 *
 *  ONE VIEW: the head is read first, it decides whether the hostname answers, and the page holds
 *  no record after it, so a record that is accepted meanwhile is in no answer whose head does
 *  not name it.
 *
 *  A PAGE IS CUT IN THE DATABASE, BY THE BYTES THAT ARE SENT. Each row holds what its record
 *  takes in a page (`page_bytes`: its entry as JSON, where a record's text is a JSON string and
 *  each of its quotes and backslashes is written with one more backslash). A page ends with the
 *  record that takes the sum to `LOG_PAGE_BYTES` less 1 KiB, which is for the page's own
 *  fields. One entry is at most the body that the intake read, `SIGNED_RECORD_MAX_BYTES`, so a
 *  page is never over the sum of the two, which is what a reader takes
 *  (`publishedMindOf`). This Worker never holds more. The answer is never stored by a cache
 *  (`no-store`): a hostname that a later record no longer lists must stop answering at once,
 *  and a reader keeps its own answer for a minute (iterate/mind-identity-log `publishedMindOf`). */
export async function identityLogResponse(
  env: Env,
  { hostname, after }: { hostname: string; after: string | null },
): Promise<Response> {
  const { mindId, controlPlaneHostname } = configOf(env);
  const headers = { "cache-control": "no-store" };
  const state = await identityOf(env);
  if (hostname !== controlPlaneHostname && !state.current?.hostnames.includes(hostname))
    return new Response("Not found\n", { status: 404, headers });
  let position = 0;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- the protocol tells an absent `after` (the whole log) from an empty one, which names no record and is refused as any text that is no hash
  if (after !== null) {
    if (!IdentityHash.safeParse(after).success)
      return Response.json(
        { error: "`after` is a record's hash: 64 lowercase hex characters" },
        { status: 400, headers },
      );
    const row = await env.DB.prepare(
      `select position from identity_records where mind = ?1 and hash = ?2`,
    )
      .bind(mindId, after)
      .first<{ position: number }>();
    if (!row)
      return Response.json(
        { error: "`after` is no record of this mind's log" },
        { status: 404, headers },
      );
    position = row.position;
  }
  // The rows are put in order here: an `order by` outside the sub-select would sort them again.
  const { results } = await env.DB.prepare(
    `select position, record, signatures from (
       select record, signatures, position,
         sum(page_bytes) over (order by position) - page_bytes as bytes_before
       from identity_records
       where mind = ?1 and position > ?2 and position <= ?3
       order by position limit 64
     ) where bytes_before <= ?4`,
  )
    .bind(mindId, position, state.position, LOG_PAGE_BYTES - 1024)
    .all<Pick<AcceptedRow, "position" | "record" | "signatures">>();
  const log: PublishedLog = {
    version: 1,
    mind: mindId,
    head: state.head,
    records: results.toSorted((one, other) => one.position - other.position).map(pageEntryOf),
  };
  return Response.json(log, { headers });
}
