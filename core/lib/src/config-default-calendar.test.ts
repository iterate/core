// The default config's Google Calendar push (core/configs/default/calendar.ts): which secret
// watches a calendar that the Cloud says was connected, what a push puts on the calendar's log,
// what happens when Google no longer has the sync token, and the day's new channel.
import { expect, test, vi } from "vitest";
import { calendarEvent } from "../../configs/default/calendar.ts";
import { codedError } from "./lib.ts";

const API = "https://google.test";
/** The Cloud's address for a channel's pushes, and the tokens it made for this mind's calendars. */
const HOOK = "https://cloud.test/clients/google/calendar-webhook";
const ADA = "/integrations/google/ada@example.com";
const WORK = "/integrations/google/work@example.com";
const WATCHED = "events.iterate.com/google/calendar-watched";
const CHANGED = "events.iterate.com/google/calendar-event-changed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("a connected calendar is watched with the secret that holds it, on a channel with the Cloud's token, and none of its events is read onto the log", async () => {
  using mind = calendarMind();
  // a calendar with years of events: its first listing has three pages
  mind.calendar.pagesOfFirstSync = 3;

  await calendarEvent(mind.itx, connected(ADA, 7));

  // the secret is found by asking Google whose primary calendar each Google grant of the mind
  // reaches: not the key of another service, nor a grant pinned elsewhere
  expect(mind.calendar).toMatchObject({
    channels: [
      {
        secret: "/secrets/google",
        body: {
          id: expect.stringMatching(UUID),
          type: "web_hook",
          address: HOOK,
          token: "token-of-ada@example.com",
          // a channel lives two days
          expiration: String(Date.UTC(2026, 10, 14, 22)),
        },
      },
    ],
    stopped: [],
  });
  expect(mind.asked("/secrets/openai")).toBe(0);
  expect(mind.asked("/secrets/elsewhere")).toBe(0);
  const first = mind.calendar.channels[0]!.body;
  expect(mind.rowOf(ADA)).toEqual({
    secret: "/secrets/google",
    api: API,
    address: HOOK,
    token: "token-of-ada@example.com",
    syncToken: "sync-0",
    channel: {
      id: first.id,
      resourceId: "resource-of-Ada",
      expiration: String(Date.UTC(2026, 10, 14, 22)),
    },
  });
  expect(mind.factsOn(ADA)).toEqual([
    {
      type: WATCHED,
      payload: {
        secret: "/secrets/google",
        channelId: first.id,
        expiresAt: "2026-11-14T22:00:00.000Z",
      },
    },
  ]);
  expect(mind).toMatchObject({
    schedules: {
      "calendar-watch": {
        key: "calendar-watch",
        when: { everyMs: 24 * 60 * 60_000 },
        events: [{ type: "events.iterate.com/google/calendar-watch-requested" }],
      },
    },
  });
  // THE PLACE TO READ CHANGES FROM came with no event of the calendar: each page of the first
  // listing asks for the two tokens alone
  const listings = () => mind.calendar.calls.filter((call) => call.includes("/events?"));
  expect(listings()).toEqual([
    "/secrets/google GET /calendars/primary/events?maxResults=2500&fields=nextPageToken%2CnextSyncToken",
    "/secrets/google GET /calendars/primary/events?maxResults=2500&fields=nextPageToken%2CnextSyncToken&pageToken=first-2",
    "/secrets/google GET /calendars/primary/events?maxResults=2500&fields=nextPageToken%2CnextSyncToken&pageToken=first-3",
  ]);

  // THE SAME EVENT AGAIN (an event arrives at least once): a new channel, the one before it
  // stopped, no second fact, and the place in the calendar's changes stays where it was
  await calendarEvent(mind.itx, connected(ADA, 7));
  const second = mind.calendar.channels[1]!.body;
  expect(second).not.toMatchObject({ id: first.id });
  expect(mind.calendar).toMatchObject({
    stopped: [{ secret: "/secrets/google", body: { id: first.id, resourceId: "resource-of-Ada" } }],
  });
  expect(mind.factsOn(ADA)).toHaveLength(1);
  expect(mind.rowOf(ADA)).toMatchObject({ syncToken: "sync-0", channel: { id: second.id } });
  expect(listings()).toHaveLength(3);

  // only the Cloud's word counts: an event of this type that the Cloud did not sign does nothing
  const before = mind.calendar.calls.length;
  await calendarEvent(mind.itx, { ...connected(WORK, 8), source: {} });
  await calendarEvent(mind.itx, {
    ...connected(WORK, 9),
    source: { signer: { principal: { actor: "someone-else" } } },
  });
  expect([mind.calendar.calls.length - before, mind.rowOf(WORK)]).toEqual([0, null]);

  // a calendar that no secret of the mind holds is watched by nobody, and the log says so
  const nobodys = "/integrations/google/eve@example.com";
  await calendarEvent(mind.itx, connected(nobodys, 10));
  expect([mind.rowOf(nobodys), mind.factsOn(nobodys)]).toEqual([
    null,
    [
      {
        type: "events.iterate.com/google/calendar-watch-failed",
        payload: { reason: "no secret of this mind holds the calendar eve@example.com" },
      },
    ],
  ]);
  // Google gives no word on one grant, and no other grant holds the calendar: the event fails,
  // and the platform hands it over again
  mind.calendar.busy.add("/secrets/google");
  await expect(calendarEvent(mind.itx, connected(ADA, 11))).rejects.toThrow(
    "Google did not answer for the calendar ada@example.com",
  );
});

test("a first listing that Google gives no word on fails the connect, and the platform's next try watches the calendar", async () => {
  using mind = calendarMind();
  mind.calendar.busyListing = true;
  await expect(calendarEvent(mind.itx, connected(ADA, 7))).rejects.toThrow(
    "Google did not answer for the calendar ada@example.com",
  );
  expect(mind.rowOf(ADA)).toBeNull();
  mind.calendar.busyListing = false;
  await calendarEvent(mind.itx, connected(ADA, 7));
  expect(mind.rowOf(ADA)).toMatchObject({ syncToken: "sync-0" });
});

test("a push puts each changed event on the calendar's log once, with no description, and a push that comes again puts nothing", async () => {
  using mind = calendarMind();
  await calendarEvent(mind.itx, connected(ADA, 7));
  mind.calendar.changes("/secrets/google", {
    id: "e1",
    status: "confirmed",
    summary: "Lunch with Grace",
    description: "the words of the invitation, which stay at Google",
    location: "The Ivy",
    start: { dateTime: "2026-11-13T12:00:00Z" },
    end: { dateTime: "2026-11-13T13:00:00Z" },
    organizer: { email: "grace@example.com", displayName: "Grace" },
    attendees: [
      { email: "ada@example.com", responseStatus: "needsAction", self: true },
      { email: "grace@example.com", responseStatus: "accepted", organizer: true },
    ],
    htmlLink: "https://www.google.com/calendar/event?eid=e1",
    updated: "2026-11-12T22:00:01.000Z",
    etag: '"1"',
  });
  // an event that was deleted: Google sends its id and its status
  mind.calendar.changes("/secrets/google", { id: "e2", status: "cancelled" });

  await calendarEvent(mind.itx, pushed(ADA, 20));

  const changed = () => mind.factsOn(ADA).filter((fact) => fact.type === CHANGED);
  expect(changed()).toEqual([
    {
      type: CHANGED,
      payload: {
        id: "e1",
        status: "confirmed",
        summary: "Lunch with Grace",
        start: { dateTime: "2026-11-13T12:00:00Z" },
        end: { dateTime: "2026-11-13T13:00:00Z" },
        location: "The Ivy",
        organizer: "grace@example.com",
        attendees: [
          { email: "ada@example.com", responseStatus: "needsAction" },
          { email: "grace@example.com", responseStatus: "accepted" },
        ],
        htmlLink: "https://www.google.com/calendar/event?eid=e1",
        updated: "2026-11-12T22:00:01.000Z",
        recurringEventId: null,
      },
    },
    {
      type: CHANGED,
      payload: {
        id: "e2",
        status: "cancelled",
        summary: null,
        start: null,
        end: null,
        location: null,
        organizer: null,
        attendees: null,
        htmlLink: null,
        updated: null,
        recurringEventId: null,
      },
    },
  ]);
  expect(JSON.stringify(mind.factsOn(ADA))).not.toContain("the words of the invitation");
  expect(mind.rowOf(ADA)).toMatchObject({ syncToken: "sync-2" });

  // THE SAME PUSH AGAIN: Google has nothing after the place the mind is at
  await calendarEvent(mind.itx, pushed(ADA, 20));
  expect(changed()).toHaveLength(2);
  // and a push that is worked through twice from the same place (the first run ended before it
  // kept its place) writes no event a second time
  mind.setRow(ADA, { syncToken: "sync-0" });
  await calendarEvent(mind.itx, pushed(ADA, 21));
  expect(changed()).toHaveLength(2);
  expect(mind.rowOf(ADA)).toMatchObject({ syncToken: "sync-2" });
  // the same event changed again is a new fact; a push on an older channel of the calendar,
  // which lives on beside the new one for a while, is read all the same
  mind.calendar.changes("/secrets/google", {
    id: "e1",
    status: "confirmed",
    summary: "Lunch with Grace, moved",
    updated: "2026-11-12T22:05:00.000Z",
  });
  await calendarEvent(mind.itx, pushed(ADA, 22, "exists", "a-channel-of-yesterday"));
  expect(changed().at(-1)).toMatchObject({
    payload: { id: "e1", summary: "Lunch with Grace, moved", location: null },
  });
  expect(changed()).toHaveLength(3);

  // Google's first message on a new channel says only that the channel is live; a push the Cloud
  // did not sign, and one for a calendar this mind does not watch: nothing is asked of Google
  const before = mind.calendar.calls.length;
  await calendarEvent(mind.itx, pushed(ADA, 23, "sync"));
  await calendarEvent(mind.itx, { ...pushed(ADA, 24), source: {} });
  await calendarEvent(mind.itx, pushed(WORK, 25));
  expect(mind.calendar.calls.length).toBe(before);
});

test("many changes come in pages, and the place moves on only after the last page is on the log", async () => {
  using mind = calendarMind();
  await calendarEvent(mind.itx, connected(ADA, 7));
  for (let n = 1; n <= 7; n += 1)
    mind.calendar.changes("/secrets/google", {
      id: `e${n}`,
      status: "confirmed",
      updated: `2026-11-12T22:00:0${n}.000Z`,
    });
  const changed = () => mind.factsOn(ADA).filter((fact) => fact.type === CHANGED).length;

  // Google fails at the second page: the first page's events are on the log, and the place stays
  mind.calendar.failsAtPage = "page-3";
  await calendarEvent(mind.itx, pushed(ADA, 20));
  expect([changed(), mind.rowOf(ADA)?.syncToken]).toEqual([3, "sync-0"]);

  // the next push reads all three pages from the same place, and no event is on the log twice
  mind.calendar.failsAtPage = "";
  mind.calendar.calls.length = 0;
  await calendarEvent(mind.itx, pushed(ADA, 21));
  expect([changed(), mind.rowOf(ADA)?.syncToken]).toEqual([7, "sync-7"]);
  expect(mind.calendar).toMatchObject({
    calls: [
      "/secrets/google GET /calendars/primary/events?syncToken=sync-0&maxResults=250",
      "/secrets/google GET /calendars/primary/events?syncToken=sync-0&maxResults=250&pageToken=page-3",
      "/secrets/google GET /calendars/primary/events?syncToken=sync-0&maxResults=250&pageToken=page-6",
    ],
  });
});

test("a list of changes longer than one event reads goes on from its page at the next event, and then moves the sync token", async () => {
  using mind = calendarMind();
  await calendarEvent(mind.itx, connected(ADA, 7));
  for (let n = 1; n <= 130; n += 1)
    mind.calendar.changes("/secrets/google", {
      id: `e${n}`,
      status: "confirmed",
      updated: `u${n}`,
    });
  const changed = () => mind.factsOn(ADA).filter((fact) => fact.type === CHANGED).length;

  // forty pages of three: the place is the page the read stopped before, under the same token
  await calendarEvent(mind.itx, pushed(ADA, 20));
  expect([changed(), mind.rowOf(ADA)]).toMatchObject([
    120,
    { syncToken: "sync-0", pageToken: "page-120" },
  ]);
  // the next event goes on from that page, and the sync token moves on at the end
  mind.calendar.calls.length = 0;
  await calendarEvent(mind.itx, pushed(ADA, 21));
  expect(changed()).toBe(130);
  expect(mind.rowOf(ADA)).toMatchObject({ syncToken: "sync-130" });
  expect(mind.rowOf(ADA)).not.toHaveProperty("pageToken");
  expect(mind.calendar.calls[0]).toContain("syncToken=sync-0&maxResults=250&pageToken=page-120");
});

test("a first channel that Google refuses is asked for again by the day's event", async () => {
  using mind = calendarMind();
  mind.calendar.refusesWatch = true;
  await calendarEvent(mind.itx, connected(ADA, 7));
  expect(mind.rowOf(ADA)).toMatchObject({
    secret: "/secrets/google",
    syncToken: "sync-0",
    channel: null,
  });
  expect(mind.schedules).toHaveProperty("calendar-watch");
  mind.calendar.refusesWatch = false;
  await calendarEvent(mind.itx, {
    type: "events.iterate.com/google/calendar-watch-requested",
    path: "/",
    offset: 30,
  });
  expect(mind.factsOn(ADA).map((fact) => fact.type)).toEqual([
    "events.iterate.com/google/calendar-watch-failed",
    "events.iterate.com/google/calendar-watched",
  ]);
});

test("the day's event reads the changes even when Google refuses the new channel", async () => {
  using mind = calendarMind();
  await calendarEvent(mind.itx, connected(ADA, 7));
  mind.calendar.changes("/secrets/google", { id: "e1", status: "confirmed", updated: "u1" });
  mind.calendar.refusesWatch = true;

  await calendarEvent(mind.itx, {
    type: "events.iterate.com/google/calendar-watch-requested",
    path: "/",
    offset: 30,
  });

  expect(
    mind
      .factsOn(ADA)
      .slice(1)
      .map((fact) => fact.type),
  ).toEqual(["events.iterate.com/google/calendar-watch-failed", CHANGED]);
});

test("a sync token that Google no longer has ends in a fresh one and a fact, and the changes in between are not reported", async () => {
  using mind = calendarMind();
  await calendarEvent(mind.itx, connected(ADA, 7));
  mind.calendar.changes("/secrets/google", { id: "e1", status: "confirmed", updated: "t1" });
  mind.calendar.gone.add("sync-0");

  await calendarEvent(mind.itx, pushed(ADA, 20));

  expect(mind.factsOn(ADA).slice(1)).toEqual([
    {
      type: "events.iterate.com/google/calendar-sync-lost",
      payload: {
        reason:
          "Google no longer has this calendar's sync token: the changes since the last read are not reported",
      },
    },
  ]);
  expect(mind.rowOf(ADA)).toMatchObject({ syncToken: "sync-1" });
  // the fresh token came as the first one did: with no event of the calendar
  expect(mind.calendar.calls.at(-1)).toBe(
    "/secrets/google GET /calendars/primary/events?maxResults=2500&fields=nextPageToken%2CnextSyncToken",
  );
  // the same push again says it once
  await calendarEvent(mind.itx, pushed(ADA, 20));
  expect(mind.factsOn(ADA)).toHaveLength(2);
  // from the new place on, changes arrive as before
  mind.calendar.changes("/secrets/google", { id: "e9", status: "confirmed", updated: "t9" });
  await calendarEvent(mind.itx, pushed(ADA, 24));
  expect(mind.factsOn(ADA).at(-1)).toMatchObject({ type: CHANGED, payload: { id: "e9" } });
});

test("once a day each calendar gets a new channel and its old one is stopped, and its changes are read; a calendar whose secret is gone is dropped with no word to Google", async () => {
  using mind = calendarMind();
  await calendarEvent(mind.itx, connected(ADA, 7));
  await calendarEvent(mind.itx, connected(WORK, 8));
  expect(mind.rowOf(WORK)).toMatchObject({ secret: "/secrets/google-work" });
  const channelOf = (path: string) => mind.rowOf(path)!.channel as { id: string };
  const [adas, works] = [channelOf(ADA), channelOf(WORK)];
  // a change with no push: the day's read finds it
  mind.calendar.changes("/secrets/google", { id: "e1", status: "confirmed", updated: "t1" });
  const due = (offset: number) => ({
    type: "events.iterate.com/google/calendar-watch-requested",
    path: "/",
    offset,
  });

  mind.calendar.channels.length = 0;
  await calendarEvent(mind.itx, due(30));

  expect(mind.calendar).toMatchObject({
    channels: [{ secret: "/secrets/google" }, { secret: "/secrets/google-work" }],
    stopped: [
      { secret: "/secrets/google", body: { id: adas.id, resourceId: "resource-of-Ada" } },
      { secret: "/secrets/google-work", body: { id: works.id, resourceId: "resource-of-work" } },
    ],
  });
  expect(channelOf(ADA)).not.toMatchObject({ id: adas.id });
  expect(mind.factsOn(ADA).map((fact) => fact.type)).toEqual([WATCHED, WATCHED, CHANGED]);
  // the same day's event again: no second fact of that day
  await calendarEvent(mind.itx, due(30));
  expect(mind.factsOn(ADA)).toHaveLength(3);
  // an event of this type on another context is not the schedule's
  mind.calendar.channels.length = 0;
  await calendarEvent(mind.itx, { ...due(31), path: "/agents/web/a1" });
  expect(mind.calendar).toMatchObject({ channels: [] });

  // GOOGLE REFUSES ONE GRANT (the person withdrew it): the log says so, its old channel is not
  // stopped, and the other calendar gets its new channel all the same
  mind.calendar.refuses.add("/secrets/google");
  const kept = channelOf(ADA);
  mind.calendar.stopped.length = 0;
  await calendarEvent(mind.itx, due(32));
  expect(mind.factsOn(ADA).at(-1)).toEqual({
    type: "events.iterate.com/google/calendar-watch-failed",
    payload: { reason: "Google answered 403 to the watch of the calendar ada@example.com" },
  });
  expect(mind.calendar).toMatchObject({
    channels: [{ secret: "/secrets/google-work" }],
    stopped: [{ secret: "/secrets/google-work" }],
  });
  expect(channelOf(ADA)).toEqual(kept);

  // the secret is deleted (calendar.ts `watchedAgain` says why its channel is not stopped)
  mind.secrets.delete("/secrets/google");
  await calendarEvent(mind.itx, pushed(ADA, 33));
  mind.calendar.calls.length = 0;
  await calendarEvent(mind.itx, due(34));
  expect([mind.rowOf(ADA), mind.rowOf(WORK)?.secret]).toEqual([null, "/secrets/google-work"]);
  expect(mind.asked("/secrets/google")).toBe(0);
  expect(mind.schedules).toHaveProperty("calendar-watch");
  // the last calendar goes, and the schedule with it
  mind.secrets.delete("/secrets/google-work");
  await calendarEvent(mind.itx, due(35));
  expect([mind.rowOf(WORK), mind.schedules]).toEqual([null, {}]);
});

/** The Cloud's word that this mind connected the calendar of `path`. */
function connected(path: string, offset: number) {
  const emailAddress = path.split("/").at(-1)!;
  return {
    type: "events.iterate.com/google/calendar-connected",
    path,
    offset,
    source: { signer: { principal: { actor: "iterate-cloud" } } },
    payload: { emailAddress, api: API, address: HOOK, token: `token-of-${emailAddress}` },
  };
}

/** Google's push on a channel of the calendar of `path`, as the Cloud relays it. */
function pushed(path: string, offset: number, resourceState = "exists", channelId = "a-channel") {
  return {
    type: "events.iterate.com/google/calendar-push-received",
    path,
    offset,
    source: { signer: { principal: { actor: "iterate-cloud" } } },
    payload: { channelId, resourceId: "a-resource", resourceState, messageNumber: String(offset) },
  };
}

type Item = { id: string; status: string; [field: string]: unknown };

/** A mind with four secrets (two Google grants of the Cloud's client, a key of another service,
 *  and a grant pinned elsewhere) and a Google Calendar that answers each grant as its own
 *  account. The clock stands at 22:00 UTC on 12 November 2026 until the mind is disposed of. */
function calendarMind() {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 12, 22), toFake: ["Date"] });
  const kept = new Map<string, string>();
  const facts: { path: string; type: string; idempotencyKey?: string; payload?: unknown }[] = [];
  const schedules: Record<string, unknown> = {};
  const secrets = new Map([
    ["/secrets/openai", { urls: ["https://api.openai.com"], account: "" }],
    ["/secrets/google-work", { urls: [API], refresh: "oauth-refresh-token", account: "work" }],
    ["/secrets/google", { urls: [API], refresh: "oauth-refresh-token", account: "Ada" }],
    [
      "/secrets/elsewhere",
      { urls: ["https://elsewhere.test"], refresh: "oauth-refresh-token", account: "" },
    ],
  ]);
  const calendar = {
    /** Each request as `<secret> <method> <path and query>`. */
    calls: [] as string[],
    /** The channels asked for (`events.watch`), and the ones stopped (`channels.stop`). */
    channels: [] as { secret: string; body: { id: string; token: string; expiration: string } }[],
    stopped: [] as { secret: string; body: unknown }[],
    /** Every change of every calendar, in the order it happened. A sync token `sync-<n>` is the
     *  place after the first n of them. */
    changed: [] as { secret: string; item: Item }[],
    /** How many pages the first listing of a calendar has: one for each 2500 of its events. */
    pagesOfFirstSync: 1,
    /** The sync tokens Google no longer has: it answers 410 for one. */
    gone: new Set<string>(),
    /** The page token of an incremental listing that Google fails at; none when "". */
    failsAtPage: "",
    refuses: new Set<string>(),
    busy: new Set<string>(),
    refusesWatch: false,
    /** Google answers 503 to the first listing (the one with no sync token). */
    busyListing: false,
    /** One event of the calendar of `secret` changes. */
    changes(secret: string, item: Item) {
      calendar.changed.push({ secret, item });
    },
  };
  const itx = {
    kv: {
      get: async (key: string) => kept.get(key) ?? null,
      put: async (key: string, value: string) => {
        kept.set(key, value);
        return { ok: true as const };
      },
      delete: async (key: string) => {
        kept.delete(key);
        return { ok: true as const };
      },
      list: async (prefix = "") => ({
        keys: [...kept.keys()].filter((key) => key.startsWith(prefix)),
      }),
    },
    secrets: {
      list: async () =>
        [...secrets].map(([path, { urls, refresh }], index) => ({
          path,
          urls,
          refresh,
          createdAt: new Date(Date.UTC(2026, 10, 1 + index)).toISOString(),
        })),
    },
    schedules: {
      set: async (input: { key: string }) => {
        schedules[input.key] = input;
      },
      cancel: async (key: string) => {
        delete schedules[key];
      },
    },
    cd: (path: string) => ({
      append: async (event: { type: string; idempotencyKey?: string; payload?: unknown }) => {
        const again = facts.some(
          (fact) => fact.path === path && fact.idempotencyKey === event.idempotencyKey,
        );
        if (again) throw codedError("IDEMPOTENCY_CONFLICT", "appended before");
        facts.push({ path, ...event });
      },
    }),
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const secret = /getSecret\("([^"]+)"/.exec(request.headers.get("authorization") || "")?.[1];
      const held = secrets.get(secret || "");
      if (!held) throw codedError("SECRET_NOT_SET", `${secret} holds no material`);
      if (!held.urls.includes(url.origin))
        throw new Error(`${secret} is not pinned to ${url.origin}`);
      const call = url.pathname.replace("/calendar/v3/", "");
      calendar.calls.push(`${secret} ${request.method} /${call}${url.search}`);
      const refused = (status: number) =>
        Response.json({ error: { code: status, message: "refused" } }, { status });
      if (calendar.busy.has(secret!)) return refused(503);
      if (calendar.refuses.has(secret!)) return refused(403);
      if (call === "calendars/primary")
        return Response.json({ id: `${held.account}@Example.com`, summary: held.account });
      if (call === "calendars/primary/events/watch" && calendar.refusesWatch) return refused(403);
      if (call === "calendars/primary/events/watch") {
        const body = (await request.json()) as { id: string; token: string; expiration: string };
        calendar.channels.push({ secret: secret!, body });
        return Response.json({
          kind: "api#channel",
          id: body.id,
          resourceId: `resource-of-${held.account}`,
          resourceUri: `${API}/calendar/v3/calendars/primary/events`,
          token: body.token,
          expiration: body.expiration,
        });
      }
      if (call === "channels/stop") {
        calendar.stopped.push({ secret: secret!, body: await request.json() });
        return new Response(null, { status: 204 });
      }
      if (call !== "calendars/primary/events") return refused(404);
      const page = url.searchParams.get("pageToken") || "";
      const syncToken = url.searchParams.get("syncToken");
      // THE FIRST LISTING: every event the calendar has, a page at a time, and the sync token on
      // the last page. A request that does not ask for the two tokens alone gets the events too.
      if (!syncToken && calendar.busyListing) return refused(503);
      if (!syncToken) {
        const at = Number(page.replace("first-", "") || 1);
        return Response.json({
          ...(url.searchParams.get("fields") !== "nextPageToken,nextSyncToken" && {
            items: [{ id: `an-old-event-of-page-${at}`, status: "confirmed", updated: "long ago" }],
          }),
          ...(at < calendar.pagesOfFirstSync
            ? { nextPageToken: `first-${at + 1}` }
            : { nextSyncToken: `sync-${calendar.changed.length}` }),
        });
      }
      if (calendar.gone.has(syncToken)) return refused(410);
      if (page && page === calendar.failsAtPage) return refused(503);
      // THE CHANGES SINCE A SYNC TOKEN, three a page: the page token is where a page ended
      const from = Number((page || syncToken).replace(/^(sync|page)-/, ""));
      const mine = calendar.changed
        .map(({ secret: whose, item }, index) => ({ whose, item, place: index + 1 }))
        .filter(({ whose, place }) => whose === secret && place > from);
      return Response.json({
        items: mine.slice(0, 3).map(({ item }) => item),
        ...(mine.length > 3
          ? { nextPageToken: `page-${mine[2]!.place}` }
          : { nextSyncToken: `sync-${calendar.changed.length}` }),
      });
    },
  };
  return {
    itx,
    calendar,
    secrets,
    schedules,
    /** How many requests went out with `secret`. */
    asked: (secret: string) =>
      calendar.calls.filter((call) => call.startsWith(`${secret} `)).length,
    /** What the mind keeps of the calendar of `path`. */
    rowOf: (path: string): Record<string, unknown> | null =>
      JSON.parse(kept.get(`calendar:${path}`) || "null"),
    setRow: (path: string, fields: Record<string, string>) =>
      kept.set(
        `calendar:${path}`,
        JSON.stringify({ ...JSON.parse(kept.get(`calendar:${path}`)!), ...fields }),
      ),
    /** The facts on the context `path`, without their idempotency keys. */
    factsOn: (path: string) =>
      facts.filter((fact) => fact.path === path).map(({ type, payload }) => ({ type, payload })),
    [Symbol.dispose]: () => void vi.useRealTimers(),
  };
}
