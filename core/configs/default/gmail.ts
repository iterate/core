// gmail.ts — GMAIL'S PUSH (worker.ts, the `google/gmail-*` case). A Gmail mailbox that a member
// connected through iterate Cloud's Google client puts each new message on the mind's log as it
// arrives, with no polling. Three events drive it:
//
//   google/gmail-connected        the Cloud says which mailbox this mind connected, the topic to
//                                 watch it with, and where Gmail's API is. The secret that holds
//                                 the mailbox is found, Gmail is asked to watch it, and the mind
//                                 keeps a row for it (kv `gmail:<the mailbox's context>`).
//   google/gmail-push-received    the Cloud relays Gmail's word that the mailbox changed. The
//                                 history since the row's place is read, and each new message
//                                 becomes one `google/gmail-message-added` on the mailbox's
//                                 context, `/integrations/<client>/<address>`.
//   google/gmail-watch-requested  once a day, from the schedule `gmail-watch`: each mailbox is
//                                 watched again (Gmail ends a watch after seven days) and its
//                                 history is read (Gmail says a push may be late or lost).
//
// The first two count only as iterate Cloud signed them (worker.ts says how a signer gets that
// name), and the third only on the mind's root, where the schedule appends it.
//
// ONE WATCH PER MAILBOX IS SHARED by every mind that connected the mailbox through the same Google
// client. So this code never stops a watch (`users.stop`) and names no labels in it: either would
// change what the other minds get. A watch that nobody asks for again ends by itself in a week,
// and a mailbox whose secret is gone is dropped here at the next day's event.
//
// THE FIRST WORDS OF EACH MAIL ARE ON THE LOG. An event has the message's ids, labels, headers
// and Gmail's snippet, which is the start of the mail's text: a sign-in code or a reset link's
// first words are there too, for whoever reads the mind's log (a member, an agent, a backup).
// Whoever has the mind has the mailbox, so that is the same reach; the rest of the body is not on
// the log, and code that wants it reads the message with the same secret. A draft is no mail
// (each save of one is a new message at Gmail) and gets no event.
//
// A `google/gmail-message-added` EVENT CARRIES OTHER PEOPLE'S WORDS and is this file's word,
// not a platform fact: whatever may append on the mailbox's context can write one. A case that
// hands mail to an agent reads the message again from Gmail by its id, and marks its words as
// its sender's, never as a member's instruction.
//
// EVERY EVENT ARRIVES AT LEAST ONCE. A fact is keyed by the event that caused it, a message by its
// id, and the row's place in the history moves on only after its messages are on the log.
import { errorCode } from "iterate/lib";
import { z } from "zod";

/** What the mind keeps of one watched mailbox: the secret that reads it, the Cloud's topic, the
 *  origin of Gmail's API, and the mailbox's history id up to which its messages are on the log. */
type Mailbox = { secret: string; topic: string; api: string; historyId: string };

/** An event as `processEvent` is handed it, as far as this file reads it. */
type GmailEvent = {
  type: string;
  path: string;
  offset: number;
  payload?: unknown;
  source?: { signer?: { principal: { actor?: string } } };
};

/** The mind's root, as far as this file uses it. */
export type GmailItx = {
  fetch(request: Request): Promise<Response>;
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  secrets: {
    list(): Promise<{ path: string; urls: string[]; refresh?: string; createdAt: string }[]>;
  };
  schedules: {
    set(input: {
      key: string;
      when: { everyMs: number };
      events: { type: string }[];
    }): Promise<unknown>;
    cancel(key: string): Promise<unknown>;
  };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

const WATCH_REQUESTED = "events.iterate.com/google/gmail-watch-requested";
/** What the Cloud says of a connected mailbox (`google/gmail-connected`). */
const Connected = z.object({ emailAddress: z.string(), topic: z.string(), api: z.string() });
/** Gmail's answer to `users.history.list`, as far as this file reads it. */
const History = z.object({
  history: z
    .array(
      z.object({
        id: z.coerce.string(),
        messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.coerce.string().optional(),
});
/** The kv rows of the watched mailboxes: `gmail:<the mailbox's context path>`. */
const ROWS = "gmail:";
/** How many messages one event puts on the log; the rest wait for the next push or the day's read. */
const MESSAGES_PER_EVENT = 50;

/** One of the three events above; any other event, and one that does not count, does nothing. */
export async function gmailEvent(itx: GmailItx, event: GmailEvent): Promise<void> {
  const fromCloud = event.source?.signer?.principal.actor === "iterate-cloud";
  if (event.type === "events.iterate.com/google/gmail-connected" && fromCloud)
    await connected(itx, event);
  if (event.type === "events.iterate.com/google/gmail-push-received" && fromCloud)
    await read(itx, event.path, event);
  if (event.type === WATCH_REQUESTED && event.path === "/") await watchedAgain(itx, event);
}

/** THE CLOUD SAYS THIS MIND CONNECTED A MAILBOX. Which secret holds it, the Cloud does not know:
 *  Gmail is asked whose mailbox each Google grant of the mind reads (a secret with an OAuth
 *  refresh, pinned to the API's origin), newest secret first, since a mailbox connected again may
 *  be in another secret. A mailbox watched before keeps its place in the history. */
async function connected(itx: GmailItx, event: GmailEvent): Promise<void> {
  const said = Connected.safeParse(event.payload);
  if (!said.success) return;
  const { emailAddress, topic, api } = said.data;
  const grants = (await itx.secrets.list())
    .filter(({ refresh, urls }) => refresh === "oauth-refresh-token" && urls.includes(api))
    .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  let unanswered = false;
  for (const { path: secret } of grants) {
    const profile = await gmail(itx, { secret, api }, "profile");
    unanswered ||= profile.unanswered;
    if (String(profile.body?.emailAddress || "").toLowerCase() !== emailAddress.toLowerCase())
      continue;
    // a mailbox watched before keeps its place; a new one starts at its profile's history id
    const before = await mailboxOf(itx, event.path);
    const historyId = before?.historyId || String(profile.body?.historyId || "");
    await watch(itx, event.path, { secret, topic, api, historyId }, event);
    await itx.schedules.set({
      key: "gmail-watch",
      when: { everyMs: 24 * 60 * 60_000 },
      events: [{ type: WATCH_REQUESTED }],
    });
    return;
  }
  // Gmail gave no word on some grant: the platform hands this event over again
  if (unanswered) throw new Error(`Gmail did not answer for the mailbox ${emailAddress}`);
  await say(itx, event.path, event, "gmail-watch-failed", {
    reason: `no secret of this mind holds the mailbox ${emailAddress}`,
  });
}

/** GMAIL IS ASKED TO WATCH THE MAILBOX (`users.watch`), for the next seven days, with no labels
 *  named. The row is kept, at the mailbox's newest history id when it has no place yet, and the
 *  log says `gmail-watched`. When Gmail refused or failed, the log says `gmail-watch-failed` and
 *  nothing is kept: the next day's event asks again. Answers the row. */
async function watch(
  itx: GmailItx,
  path: string,
  mailbox: Mailbox,
  event: GmailEvent,
): Promise<Mailbox | null> {
  const asked = await gmail(itx, mailbox, "watch", { topicName: mailbox.topic });
  if (!asked.body?.historyId) {
    // the row is kept all the same when it has a place, so that the day's event asks again
    if (mailbox.historyId) await itx.kv.put(`${ROWS}${path}`, JSON.stringify(mailbox));
    await say(itx, path, event, "gmail-watch-failed", {
      reason: `Gmail answered ${asked.status} to the watch of ${path.split("/").at(-1)}`,
    });
    return null;
  }
  const kept = { ...mailbox, historyId: mailbox.historyId || String(asked.body.historyId) };
  await itx.kv.put(`${ROWS}${path}`, JSON.stringify(kept));
  await say(itx, path, event, "gmail-watched", {
    secret: mailbox.secret,
    topic: mailbox.topic,
    historyId: String(asked.body.historyId),
    // Gmail's own page says a watch has one; an answer without it is a watch all the same
    expiresAt: asked.body.expiration ? new Date(Number(asked.body.expiration)).toISOString() : null,
  });
  return kept;
}

/** THE MAILBOX CHANGED: its history since the row's place is read (`users.history.list`), and
 *  each message added becomes one event, oldest first. The place moves on after them. Gmail
 *  keeps a mailbox's history for about a week and answers 404 for a place older than that: the
 *  mailbox is then watched afresh from its newest history id, the log says `gmail-history-lost`,
 *  and the mail between the two places is NOT read: this code never reads a whole mailbox. */
async function read(itx: GmailItx, path: string, event: GmailEvent): Promise<void> {
  const mailbox = await mailboxOf(itx, path);
  if (!mailbox) return;
  const keep = (historyId: string) =>
    historyId === mailbox.historyId
      ? undefined
      : itx.kv.put(`${ROWS}${path}`, JSON.stringify({ ...mailbox, historyId }));
  let place = mailbox.historyId;
  let left = MESSAGES_PER_EVENT;
  for (let page = ""; ;) {
    const query = new URLSearchParams({
      startHistoryId: mailbox.historyId,
      historyTypes: "messageAdded",
      maxResults: "100",
    });
    if (page) query.set("pageToken", page);
    const history = await gmail(itx, mailbox, `history?${query}`);
    if (history.status === 404) {
      const fresh = await watch(itx, path, { ...mailbox, historyId: "" }, event);
      if (fresh)
        await say(itx, path, event, "gmail-history-lost", {
          from: mailbox.historyId,
          to: fresh.historyId,
        });
      return;
    }
    // Gmail refused, or gave no word: the day's event says so (`watch`), or the next push reads
    const listed = History.safeParse(history.body);
    if (!listed.success) return;
    for (const record of listed.data.history || []) {
      // between two records, never inside one: the place is a whole record's
      if (left <= 0) return void (await keep(place));
      for (const { message } of record.messagesAdded || []) {
        // Gmail gave no word on this message: the place stays before its record, and the next
        // push or the day's event reads it again
        if (!(await added(itx, path, mailbox, message.id))) return void (await keep(place));
        left -= 1;
      }
      place = String(record.id);
    }
    page = listed.data.nextPageToken || "";
    if (!page) return void (await keep(listed.data.historyId || place));
  }
}

/** One message of the mailbox, as one event on its context, once: its headers and Gmail's
 *  snippet (`format=metadata`), and no more of its body. Answers false when Gmail gave no word on
 *  the message, which is then read again later. A message that is gone by now (Gmail answers 404)
 *  gets no event, and one that Gmail refuses for good (another 4xx) gets `gmail-message-skipped`:
 *  both are answers. */
async function added(itx: GmailItx, path: string, mailbox: Mailbox, id: string): Promise<boolean> {
  const headers = ["From", "To", "Cc", "Subject", "Date", "Message-ID"];
  const query = new URLSearchParams([
    ["format", "metadata"],
    ...headers.map((name) => ["metadataHeaders", name]),
  ]);
  const { status, body: message } = await gmail(itx, mailbox, `messages/${id}?${query}`);
  if (status === 404) return true;
  // a refusal that no repeat changes (any 4xx but 429): the message is skipped, and the log says
  // so, or one bad message would hold the mailbox's history for good
  if (!message && status >= 400 && status < 500 && status !== 429) {
    // keyed by the message: one event may skip several
    await once(
      itx.cd(path).append({
        type: "events.iterate.com/google/gmail-message-skipped",
        idempotencyKey: `gmail-message-skipped:${id}`,
        payload: { id, status },
      }),
    );
    return true;
  }
  if (!message) return false;
  const labelIds: string[] = message?.labelIds || [];
  if (labelIds.includes("DRAFT")) return true;
  const sent: { name: string; value: string }[] = message.payload?.headers || [];
  const [from, to, cc, subject, date, messageId] = headers.map(
    (name) =>
      sent.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? null,
  );
  await once(
    itx.cd(path).append({
      type: "events.iterate.com/google/gmail-message-added",
      idempotencyKey: `gmail-message-added:${id}`,
      payload: {
        id,
        threadId: message.threadId,
        labelIds,
        from,
        to,
        cc,
        subject,
        date,
        messageId,
        snippet: message.snippet || "",
        receivedAt: message.internalDate
          ? new Date(Number(message.internalDate)).toISOString()
          : null,
      },
    }),
  );
  return true;
}

/** THE DAY'S EVENT: each mailbox is watched again and its history read. A mailbox whose secret is
 *  gone is dropped, with no word to Gmail: its watch is other minds' too, and ends by itself.
 *  With no mailbox left, the schedule goes. */
async function watchedAgain(itx: GmailItx, event: GmailEvent): Promise<void> {
  const secrets = new Set((await itx.secrets.list()).map(({ path }) => path));
  const { keys } = await itx.kv.list(ROWS);
  let left = keys.length;
  for (const key of keys) {
    const path = key.slice(ROWS.length);
    const mailbox = await mailboxOf(itx, path);
    if (mailbox && secrets.has(mailbox.secret)) {
      // a watch Gmail refused says so on the log; the history is read all the same, since the
      // grant may still read mail
      await watch(itx, path, mailbox, event);
      await read(itx, path, event);
      continue;
    }
    await itx.kv.delete(key);
    left -= 1;
  }
  if (left === 0) await itx.schedules.cancel("gmail-watch");
}

async function mailboxOf(itx: GmailItx, path: string): Promise<Mailbox | null> {
  return JSON.parse((await itx.kv.get(`${ROWS}${path}`)) || "null");
}

/** One fact on the mailbox's context, `events.iterate.com/google/<name>`, once for the event that
 *  caused it. */
async function say(
  itx: GmailItx,
  path: string,
  cause: GmailEvent,
  name: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await once(
    itx.cd(path).append({
      type: `events.iterate.com/google/${name}`,
      idempotencyKey: `${name}:${cause.path}:${cause.offset}`,
      payload,
    }),
  );
}

/** An append that was made before is made: the event came again. */
const once = (appended: Promise<unknown>) =>
  appended.catch((error: unknown) => {
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  });

/** ONE CALL OF GMAIL'S API as the mailbox's account, through the vault: the header names the
 *  secret, and the vault puts the token in. `unanswered`: Gmail gave no word (it is busy, or
 *  failed), which says nothing of the grant. A secret that is gone answers nothing and is no
 *  failure of this event: the day's event drops its mailbox. */
async function gmail(
  itx: GmailItx,
  { secret, api }: Pick<Mailbox, "secret" | "api">,
  path: string,
  body?: unknown,
): Promise<{ status: number; unanswered: boolean; body: any }> {
  const answer = await itx
    .fetch(
      new Request(`${api}/gmail/v1/users/me/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer getSecret(${JSON.stringify(secret)}, { field: "accessToken" })`,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    .catch((error: unknown) => {
      if (errorCode(error) !== "SECRET_NOT_SET") throw error;
      return null;
    });
  const status = answer?.status || 0;
  return {
    status,
    unanswered: status === 429 || status >= 500,
    body: answer?.ok ? await answer.json().catch(() => null) : null,
  };
}
