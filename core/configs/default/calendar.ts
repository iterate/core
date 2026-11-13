// calendar.ts — GOOGLE CALENDAR'S PUSH (worker.ts, the `google/calendar-*` case). The primary
// calendar of a Google account that a member connected through iterate Cloud's Google client puts
// each changed event on the mind's log as it changes, with no polling. Three events drive it:
//
//   google/calendar-connected        the Cloud says which calendar this mind connected, where
//                                    Google's API is, and the address and the token of the channel
//                                    that Google pushes on. The secret that holds the calendar is
//                                    found, Google is asked for a channel on its events, and the
//                                    mind keeps a row for it (kv `calendar:<the calendar's context>`).
//   google/calendar-push-received    the Cloud relays Google's word that the calendar changed. The
//                                    changes since the row's sync token are read, and each changed
//                                    event becomes one `google/calendar-event-changed` on the
//                                    calendar's context, `/integrations/<client>/<address>`.
//   google/calendar-watch-requested  once a day, from the schedule `calendar-watch`: each calendar
//                                    gets a new channel, its old one is stopped, and its changes
//                                    are read (Google says a push may be lost).
//
// The first two count only as iterate Cloud signed them (worker.ts says how a signer gets that
// name), and the third only on the mind's root, where the schedule appends it.
//
// A CHANNEL IS THIS MIND'S OWN, and Google does not renew one: a channel here lives two days, and
// each day's event makes a new one before it stops the old one, so the two overlap for a moment
// and no push is lost. Only the grant that made a channel can stop it. So a calendar whose secret
// is gone is dropped here with no word to Google, and its last channel ends by itself within two
// days. Google's push carries no signature: the channel's token, which the Cloud made for this
// mind and this calendar, is what the Cloud routes a push by.
//
// NOTHING OF AN EVENT'S DESCRIPTION is on the log: a fact has the event's id, status, title, times,
// place, organizer, attendees and link. Code that wants more reads the event with the same secret.
// And no event that the calendar held before it was connected is read: the first sync token is
// asked for with no event beside it.
//
// A `google/calendar-event-changed` FACT CARRIES OTHER PEOPLE'S WORDS (an invitation's title and
// place are its sender's) and is this file's word, not a platform fact: whatever may append on
// the calendar's context can write one. A case that hands a change to an agent reads the event
// again from Google by its id, and marks its words as their sender's, never as a member's
// instruction.
//
// EVERY EVENT ARRIVES AT LEAST ONCE. A fact is keyed by the event that caused it, a changed
// calendar event by its id and its time of change, and the row's sync token moves on only after
// every change before it is on the log.
import { errorCode } from "iterate/lib";
import { z } from "zod";

/** What the mind keeps of one watched calendar: the secret that reads it, the origin of Google's
 *  API, the Cloud's address and token for its channels, the sync token up to which its changes
 *  are on the log, and the channel that Google pushes on now. */
type Calendar = {
  secret: string;
  api: string;
  address: string;
  token: string;
  syncToken: string;
  /** Where a read of the changes since `syncToken` stopped, for the next event to go on from:
   *  Google's page token, good with that sync token alone. */
  pageToken?: string;
  channel: { id: string; resourceId: string; expiration: string } | null;
};

/** An event as `processEvent` is handed it, as far as this file reads it. */
type CalendarEvent = {
  type: string;
  path: string;
  offset: number;
  payload?: unknown;
  source?: { signer?: { principal: { actor?: string } } };
};

/** The mind's root, as far as this file uses it. */
export type CalendarItx = {
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

const WATCH_REQUESTED = "events.iterate.com/google/calendar-watch-requested";
/** What the Cloud relays of a push on a channel (`google/calendar-push-received`). */
const Pushed = z.object({ resourceState: z.string() });
/** Google's answer to `events.list`, as far as this file reads it: each item is passed on as
 *  Google sent it, field by field (`changed`). */
const Listed = z.object({
  items: z.array(z.looseObject({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
});
/** What the Cloud says of a connected calendar (`google/calendar-connected`). */
const Connected = z.object({
  emailAddress: z.string(),
  api: z.string(),
  address: z.string(),
  token: z.string(),
});
/** The kv rows of the watched calendars: `calendar:<the calendar's context path>`. */
const ROWS = "calendar:";
/** How many pages one listing reads: 100,000 events of a calendar's first listing, 10,000 changes
 *  since a sync token. A listing that is longer ends with no token, and nothing moves. */
const PAGES_PER_LISTING = 40;

/** One of the three events above; any other event, and one that does not count, does nothing. */
export async function calendarEvent(itx: CalendarItx, event: CalendarEvent): Promise<void> {
  const fromCloud = event.source?.signer?.principal.actor === "iterate-cloud";
  if (event.type === "events.iterate.com/google/calendar-connected" && fromCloud)
    await connected(itx, event);
  // Google's first message on a new channel (`sync`) says only that the channel is live
  if (
    event.type === "events.iterate.com/google/calendar-push-received" &&
    fromCloud &&
    Pushed.safeParse(event.payload).data?.resourceState !== "sync"
  )
    await read(itx, event.path, event);
  if (event.type === WATCH_REQUESTED && event.path === "/") await watchedAgain(itx, event);
}

/** THE CLOUD SAYS THIS MIND CONNECTED A CALENDAR. Which secret holds it, the Cloud does not know:
 *  Google is asked whose primary calendar each Google grant of the mind reaches (a secret with an
 *  OAuth refresh, pinned to the API's origin), newest secret first, since a calendar connected
 *  again may be in another secret. A calendar watched before keeps its place in its changes; a
 *  new one starts from now. */
async function connected(itx: CalendarItx, event: CalendarEvent): Promise<void> {
  const said = Connected.safeParse(event.payload);
  if (!said.success) return;
  const { emailAddress, api, address, token } = said.data;
  const grants = (await itx.secrets.list())
    .filter(({ refresh, urls }) => refresh === "oauth-refresh-token" && urls.includes(api))
    .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  let unanswered = false;
  for (const { path: secret } of grants) {
    const primary = await google(itx, { secret, api }, "calendars/primary");
    unanswered ||= primary.unanswered;
    if (String(primary.body?.id || "").toLowerCase() !== emailAddress.toLowerCase()) continue;
    const before = await calendarOf(itx, event.path);
    const first = before?.syncToken ? null : await firstSyncToken(itx, { secret, api });
    // Google gave no word on the listing: the platform hands this event over again
    if (first?.unanswered)
      throw new Error(`Google did not answer for the calendar ${emailAddress}`);
    const syncToken = before?.syncToken || first?.token || "";
    if (!syncToken) {
      await say(itx, event.path, event, "calendar-watch-failed", {
        reason: `Google gave no sync token for the calendar ${emailAddress}`,
      });
      return;
    }
    const channel = before?.channel || null;
    await watch(itx, event.path, { secret, api, address, token, syncToken, channel }, event);
    await itx.schedules.set({
      key: "calendar-watch",
      when: { everyMs: 24 * 60 * 60_000 },
      events: [{ type: WATCH_REQUESTED }],
    });
    return;
  }
  // Google gave no word on some grant: the platform hands this event over again
  if (unanswered) throw new Error(`Google did not answer for the calendar ${emailAddress}`);
  await say(itx, event.path, event, "calendar-watch-failed", {
    reason: `no secret of this mind holds the calendar ${emailAddress}`,
  });
}

/** A SYNC TOKEN FOR THE CALENDAR AS IT IS NOW, with none of its events read: Google gives a sync
 *  token on the last page of a whole listing (`events.list`), so each page is asked for its two
 *  tokens alone (`fields`), 2500 events a page. "" when Google refused, gave no word, or the
 *  listing has more pages than one event reads. */
async function firstSyncToken(
  itx: CalendarItx,
  calendar: Pick<Calendar, "secret" | "api">,
): Promise<{ token: string; unanswered: boolean }> {
  let page = "";
  for (let pages = 0; pages < PAGES_PER_LISTING; pages += 1) {
    const query = new URLSearchParams({
      maxResults: "2500",
      fields: "nextPageToken,nextSyncToken",
    });
    if (page) query.set("pageToken", page);
    const { body, unanswered } = await google(itx, calendar, `calendars/primary/events?${query}`);
    if (body?.nextSyncToken) return { token: String(body.nextSyncToken), unanswered: false };
    page = String(body?.nextPageToken || "");
    if (!page) return { token: "", unanswered };
  }
  return { token: "", unanswered: false };
}

/** GOOGLE IS ASKED FOR A NEW CHANNEL on the calendar's events (`events.watch`), with the Cloud's
 *  address and token, for the next two days. Only then is the row's old channel stopped
 *  (`channels.stop`); a stop that fails is let be: that channel ends by itself. The row is kept
 *  with the new channel, and the log says `calendar-watched`. When Google refused or failed, the
 *  log says `calendar-watch-failed`, the row and its old channel stay, and the next day's event
 *  asks again. Answers the row. */
async function watch(
  itx: CalendarItx,
  path: string,
  calendar: Calendar,
  event: CalendarEvent,
): Promise<Calendar | null> {
  const id = crypto.randomUUID();
  const asked = await google(itx, calendar, "calendars/primary/events/watch", {
    id,
    type: "web_hook",
    address: calendar.address,
    token: calendar.token,
    expiration: String(Date.now() + 2 * 24 * 60 * 60_000),
  });
  if (!asked.body?.resourceId) {
    // the row is kept all the same, so that the day's event asks again
    await itx.kv.put(`${ROWS}${path}`, JSON.stringify(calendar));
    await say(itx, path, event, "calendar-watch-failed", {
      reason: `Google answered ${asked.status} to the watch of the calendar ${path.split("/").at(-1)}`,
    });
    return null;
  }
  if (calendar.channel)
    await google(itx, calendar, "channels/stop", {
      id: calendar.channel.id,
      resourceId: calendar.channel.resourceId,
    });
  const channel = {
    id,
    resourceId: String(asked.body.resourceId),
    expiration: String(asked.body.expiration),
  };
  const kept = { ...calendar, channel };
  await itx.kv.put(`${ROWS}${path}`, JSON.stringify(kept));
  await say(itx, path, event, "calendar-watched", {
    secret: calendar.secret,
    channelId: id,
    expiresAt: new Date(Number(channel.expiration)).toISOString(),
  });
  return kept;
}

/** THE CALENDAR CHANGED: its changes since the row's sync token are read (`events.list`, every
 *  page with the same token), and each changed event becomes one fact. The sync token moves on
 *  only after the last page's events are on the log. Google answers 410 for a sync token it no
 *  longer has: the calendar then gets a fresh one, as at its connect, the log says
 *  `calendar-sync-lost`, and the changes between the two are NOT reported: this code never reads
 *  a whole calendar onto the log. */
async function read(itx: CalendarItx, path: string, event: CalendarEvent): Promise<void> {
  const calendar = await calendarOf(itx, path);
  if (!calendar) return;
  // the row with this place in the changes: a new sync token, or a page under the same one
  const keep = (syncToken: string, pageToken?: string) =>
    itx.kv.put(`${ROWS}${path}`, JSON.stringify({ ...calendar, syncToken, pageToken }));
  let page = calendar.pageToken || "";
  for (let pages = 0; ; pages += 1) {
    // a long list of changes is read over several events: the next one goes on from this page
    if (pages === PAGES_PER_LISTING) return void (await keep(calendar.syncToken, page));
    const query = new URLSearchParams({ syncToken: calendar.syncToken, maxResults: "250" });
    if (page) query.set("pageToken", page);
    const changes = await google(itx, calendar, `calendars/primary/events?${query}`);
    if (changes.status === 410) {
      const { token: fresh } = await firstSyncToken(itx, calendar);
      if (!fresh) return;
      await keep(fresh);
      await say(itx, path, event, "calendar-sync-lost", {
        reason:
          "Google no longer has this calendar's sync token: the changes since the last read are not reported",
      });
      return;
    }
    // Google refused, or gave no word: the day's event says so (`watch`), or the next push reads
    const listed = Listed.safeParse(changes.body);
    if (!listed.success) return;
    // an item is Google's event as it sent it: `changed` reads each field and writes null for one
    // that is missing or of another kind, so the cast names fields and promises none of them
    for (const item of listed.data.items || []) await changed(itx, path, item as Item);
    page = listed.data.nextPageToken || "";
    if (page) continue;
    if (listed.data.nextSyncToken) await keep(listed.data.nextSyncToken);
    return;
  }
}

/** A calendar event as `events.list` answers it, as far as this file reads it. A deleted event
 *  comes with its `id` and the status `cancelled`, and little else. */
type Item = {
  id: string;
  status?: string;
  summary?: string;
  start?: unknown;
  end?: unknown;
  location?: string;
  organizer?: { email?: string };
  attendees?: { email?: string; responseStatus?: string }[];
  htmlLink?: string;
  updated?: string;
  etag?: string;
  recurringEventId?: string;
};

/** One changed event of the calendar, as one fact on its context, once for that change: what the
 *  event is, when and where, and who is asked. Null for what Google did not send. Its
 *  description stays at Google. */
async function changed(itx: CalendarItx, path: string, item: Item): Promise<void> {
  await once(
    itx.cd(path).append({
      type: "events.iterate.com/google/calendar-event-changed",
      idempotencyKey: `calendar-event-changed:${item.id}:${item.updated || item.etag || item.status}`,
      payload: {
        id: item.id,
        status: item.status || null,
        summary: item.summary || null,
        start: item.start || null,
        end: item.end || null,
        location: item.location || null,
        organizer: item.organizer?.email || null,
        attendees:
          item.attendees?.map(({ email, responseStatus }) => ({
            email: email || null,
            responseStatus: responseStatus || null,
          })) || null,
        htmlLink: item.htmlLink || null,
        updated: item.updated || null,
        recurringEventId: item.recurringEventId || null,
      },
    }),
  );
}

/** THE DAY'S EVENT: each calendar gets a new channel, its old one is stopped, and its changes are
 *  read. A calendar whose secret is gone is dropped, with no word to Google: the grant that made
 *  its channel went with the secret, and the channel ends by itself. With no calendar left, the
 *  schedule goes. */
async function watchedAgain(itx: CalendarItx, event: CalendarEvent): Promise<void> {
  const secrets = new Set((await itx.secrets.list()).map(({ path }) => path));
  const { keys } = await itx.kv.list(ROWS);
  let left = keys.length;
  for (const key of keys) {
    const path = key.slice(ROWS.length);
    const calendar = await calendarOf(itx, path);
    if (!calendar || !secrets.has(calendar.secret)) {
      await itx.kv.delete(key);
      left -= 1;
      continue;
    }
    // a channel Google refused says so on the log; the changes are read all the same, since the
    // grant may still read the calendar
    await watch(itx, path, calendar, event);
    await read(itx, path, event);
  }
  if (left === 0) await itx.schedules.cancel("calendar-watch");
}

async function calendarOf(itx: CalendarItx, path: string): Promise<Calendar | null> {
  return JSON.parse((await itx.kv.get(`${ROWS}${path}`)) || "null");
}

/** One fact on the calendar's context, `events.iterate.com/google/<name>`, once for the event
 *  that caused it. */
async function say(
  itx: CalendarItx,
  path: string,
  cause: CalendarEvent,
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

/** ONE CALL OF GOOGLE CALENDAR'S API as the calendar's account, through the vault: the header
 *  names the secret, and the vault puts the token in. `unanswered`: Google gave no word (it is
 *  busy, or failed), which says nothing of the grant. A secret that is gone answers nothing and is
 *  no failure of this event: the day's event drops its calendar. */
async function google(
  itx: CalendarItx,
  { secret, api }: Pick<Calendar, "secret" | "api">,
  path: string,
  body?: unknown,
): Promise<{ status: number; unanswered: boolean; body: any }> {
  const answer = await itx
    .fetch(
      new Request(`${api}/calendar/v3/${path}`, {
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
