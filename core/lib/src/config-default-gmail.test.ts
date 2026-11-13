// The default config's Gmail push (core/configs/default/gmail.ts): which secret watches a mailbox
// that the Cloud says was connected, what a push puts on the mailbox's log, what happens when Gmail
// no longer has the history, and the day's renewal.
import { expect, test } from "vitest";
import { gmailEvent } from "../../configs/default/gmail.ts";
import { codedError } from "./lib.ts";

const API = "https://gmail.test";
const TOPIC = "projects/iterate-example/topics/gmail-push";
const ADA = "/integrations/google/ada@example.com";
const WORK = "/integrations/google/work@example.com";
const WATCHED = "events.iterate.com/google/gmail-watched";
const ADDED = "events.iterate.com/google/gmail-message-added";

test("a connected mailbox is watched with the secret that holds it, on the Cloud's topic, and once a day again", async () => {
  const mind = gmailMind();

  await gmailEvent(mind.itx, connected(ADA, 7));

  // the secret is found by asking Gmail whose mailbox each Google grant of the mind reads: not the
  // key of another service, nor a grant pinned elsewhere
  expect(mind.gmail).toMatchObject({
    watches: [{ secret: "/secrets/google", body: { topicName: TOPIC } }],
  });
  expect(mind.asked("/secrets/openai")).toBe(0);
  expect(mind.asked("/secrets/elsewhere")).toBe(0);
  expect(mind.rowOf(ADA)).toEqual({
    secret: "/secrets/google",
    topic: TOPIC,
    api: API,
    historyId: "100",
  });
  expect(mind.factsOn(ADA)).toEqual([
    {
      type: WATCHED,
      payload: {
        secret: "/secrets/google",
        topic: TOPIC,
        historyId: "100",
        expiresAt: "2026-11-19T22:00:00.000Z",
      },
    },
  ]);
  expect(mind).toMatchObject({
    schedules: {
      "gmail-watch": {
        key: "gmail-watch",
        when: { everyMs: 24 * 60 * 60_000 },
        events: [{ type: "events.iterate.com/google/gmail-watch-requested" }],
      },
    },
  });

  // THE SAME EVENT AGAIN (an event arrives at least once): the same watch, no second fact, and
  // the place in the mailbox's history stays where it was
  mind.gmail.historyId = 180;
  await gmailEvent(mind.itx, connected(ADA, 7));
  expect(mind.factsOn(ADA)).toHaveLength(1);
  expect(mind.rowOf(ADA)).toMatchObject({ historyId: "100" });

  // only the Cloud's word counts: an event of this type that the Cloud did not sign does nothing
  const before = mind.gmail.calls.length;
  await gmailEvent(mind.itx, { ...connected(WORK, 8), source: {} });
  await gmailEvent(mind.itx, {
    ...connected(WORK, 9),
    source: { signer: { principal: { actor: "someone-else" } } },
  });
  expect([mind.gmail.calls.length - before, mind.rowOf(WORK)]).toEqual([0, null]);

  // a mailbox that no secret of the mind holds is watched by nobody, and the log says so
  const nobodys = "/integrations/google/eve@example.com";
  await gmailEvent(mind.itx, connected(nobodys, 10));
  expect([mind.rowOf(nobodys), mind.factsOn(nobodys)]).toEqual([
    null,
    [
      {
        type: "events.iterate.com/google/gmail-watch-failed",
        payload: { reason: "no secret of this mind holds the mailbox eve@example.com" },
      },
    ],
  ]);
});

test("a push puts each new message on the mailbox's log once, and a push that comes again puts nothing", async () => {
  const mind = gmailMind();
  await gmailEvent(mind.itx, connected(ADA, 7));
  mind.gmail.arrives("/secrets/google", {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Shall we meet on Friday?",
    internalDate: String(Date.UTC(2026, 10, 12, 22)),
    payload: {
      headers: [
        { name: "From", value: "Grace <grace@example.com>" },
        { name: "To", value: "ada@example.com" },
        { name: "Subject", value: "Friday" },
        { name: "Date", value: "Thu, 12 Nov 2026 22:00:00 +0000" },
        { name: "Message-ID", value: "<m1@example.com>" },
      ],
    },
  });
  // a draft is no mail: each save of one is a new message at Gmail
  mind.gmail.arrives("/secrets/google", { id: "m2", threadId: "t2", labelIds: ["DRAFT"] });
  mind.gmail.arrives("/secrets/google", { id: "m3", threadId: "t1", labelIds: ["SENT"] });

  await gmailEvent(mind.itx, pushed(ADA, 20, "103"));

  expect(mind.factsOn(ADA).filter((fact) => fact.type === ADDED)).toEqual([
    {
      type: ADDED,
      payload: {
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX", "UNREAD"],
        from: "Grace <grace@example.com>",
        to: "ada@example.com",
        cc: null,
        subject: "Friday",
        date: "Thu, 12 Nov 2026 22:00:00 +0000",
        messageId: "<m1@example.com>",
        snippet: "Shall we meet on Friday?",
        receivedAt: "2026-11-12T22:00:00.000Z",
      },
    },
    {
      type: ADDED,
      payload: expect.objectContaining({
        id: "m3",
        threadId: "t1",
        labelIds: ["SENT"],
        from: null,
      }),
    },
  ]);
  // no body of a mail is asked for
  expect(mind.gmail.calls.filter((call) => call.includes("/messages/"))).toEqual([
    expect.stringContaining("/messages/m1?format=metadata"),
    expect.stringContaining("/messages/m2?format=metadata"),
    expect.stringContaining("/messages/m3?format=metadata"),
  ]);
  expect(mind.rowOf(ADA)).toMatchObject({ historyId: "103" });

  // THE SAME PUSH AGAIN: Gmail has nothing after the place the mind is at
  await gmailEvent(mind.itx, pushed(ADA, 20, "103"));
  expect(mind.factsOn(ADA).filter((fact) => fact.type === ADDED)).toHaveLength(2);
  // and a push that is worked through twice from the same place (the first run ended before it
  // kept its place) writes no message a second time
  mind.setRow(ADA, { historyId: "100" });
  await gmailEvent(mind.itx, pushed(ADA, 21, "103"));
  expect(mind.factsOn(ADA).filter((fact) => fact.type === ADDED)).toHaveLength(2);
  expect(mind.rowOf(ADA)).toMatchObject({ historyId: "103" });

  // a push the Cloud did not sign, and one for a mailbox this mind does not watch: nothing
  const before = mind.gmail.calls.length;
  await gmailEvent(mind.itx, { ...pushed(ADA, 22, "104"), source: {} });
  await gmailEvent(mind.itx, pushed(WORK, 23, "104"));
  expect(mind.gmail.calls.length).toBe(before);
});

test("a message that Gmail gives no word on keeps the place before it, and the next push reads it", async () => {
  const mind = gmailMind();
  await gmailEvent(mind.itx, connected(ADA, 7));
  for (const id of ["m1", "m2", "m3"])
    mind.gmail.arrives("/secrets/google", { id, threadId: id, labelIds: ["INBOX"] });
  const added = () =>
    mind
      .factsOn(ADA)
      .filter((fact) => fact.type === ADDED)
      .map((fact) => (fact.payload as { id: string }).id);

  // Gmail is busy for the second message: only a 404 says that a message is gone
  mind.gmail.busy.add("m2");
  await gmailEvent(mind.itx, pushed(ADA, 20, "103"));
  expect([added(), mind.rowOf(ADA)?.historyId]).toEqual([["m1"], "101"]);
  mind.gmail.busy.clear();
  await gmailEvent(mind.itx, pushed(ADA, 21, "103"));
  expect([added(), mind.rowOf(ADA)?.historyId]).toEqual([["m1", "m2", "m3"], "103"]);

  // a watch that Gmail answers with no expiration is a watch all the same
  mind.gmail.watchExpires = false;
  await gmailEvent(mind.itx, connected(ADA, 30));
  expect(mind.factsOn(ADA).at(-1)).toMatchObject({
    type: WATCHED,
    payload: { historyId: "103", expiresAt: null },
  });
});

test("a message that Gmail refuses for good is skipped with a fact, and holds back no mail behind it", async () => {
  const mind = gmailMind();
  await gmailEvent(mind.itx, connected(ADA, 7));
  for (const id of ["m1", "m2", "m3"])
    mind.gmail.arrives("/secrets/google", { id, threadId: id, labelIds: ["INBOX"] });
  mind.gmail.refusesMessage.add("m2");

  await gmailEvent(mind.itx, pushed(ADA, 20, "103"));

  expect(mind.factsOn(ADA).slice(1)).toEqual([
    { type: ADDED, payload: expect.objectContaining({ id: "m1" }) },
    {
      type: "events.iterate.com/google/gmail-message-skipped",
      payload: { id: "m2", status: 400 },
    },
    { type: ADDED, payload: expect.objectContaining({ id: "m3" }) },
  ]);
  expect(mind.rowOf(ADA)).toMatchObject({ historyId: "103" });
});

test("a first watch that Gmail refuses is asked for again by the day's event", async () => {
  const mind = gmailMind();
  mind.gmail.refusesWatch = true;
  await gmailEvent(mind.itx, connected(ADA, 7));
  // the row and the schedule are there, at the mailbox's place from its profile
  expect(mind.rowOf(ADA)).toMatchObject({ secret: "/secrets/google", historyId: "100" });
  expect(mind.schedules).toHaveProperty("gmail-watch");
  mind.gmail.refusesWatch = false;
  mind.gmail.arrives("/secrets/google", { id: "m1", threadId: "t1", labelIds: ["INBOX"] });
  await gmailEvent(mind.itx, {
    type: "events.iterate.com/google/gmail-watch-requested",
    path: "/",
    offset: 30,
  });
  expect(mind.factsOn(ADA).map((fact) => fact.type)).toEqual([
    "events.iterate.com/google/gmail-watch-failed",
    WATCHED,
    ADDED,
  ]);
});

test("the day's event reads the history even when Gmail refuses the new watch", async () => {
  const mind = gmailMind();
  await gmailEvent(mind.itx, connected(ADA, 7));
  mind.gmail.arrives("/secrets/google", { id: "m1", threadId: "t1", labelIds: ["INBOX"] });
  mind.gmail.refusesWatch = true;

  await gmailEvent(mind.itx, {
    type: "events.iterate.com/google/gmail-watch-requested",
    path: "/",
    offset: 30,
  });

  expect(
    mind
      .factsOn(ADA)
      .slice(1)
      .map((fact) => fact.type),
  ).toEqual(["events.iterate.com/google/gmail-watch-failed", ADDED]);
});

test("a long history is read a part at a time, and each part goes on from where the last ended", async () => {
  const mind = gmailMind();
  await gmailEvent(mind.itx, connected(ADA, 7));
  for (let n = 1; n <= 60; n += 1)
    mind.gmail.arrives("/secrets/google", { id: `m${n}`, threadId: `t${n}`, labelIds: ["INBOX"] });
  const added = () => mind.factsOn(ADA).filter((fact) => fact.type === ADDED).length;

  await gmailEvent(mind.itx, pushed(ADA, 20, "160"));
  expect([added(), mind.rowOf(ADA)?.historyId]).toEqual([50, "150"]);
  // the fifty came from two of Gmail's pages
  expect(mind.gmail.calls.filter((call) => call.includes("/history?"))).toEqual([
    expect.not.stringContaining("pageToken"),
    expect.stringContaining("pageToken=140"),
  ]);
  await gmailEvent(mind.itx, pushed(ADA, 21, "160"));
  expect([added(), mind.rowOf(ADA)?.historyId]).toEqual([60, "160"]);
});

test("a history that Gmail no longer has ends in a fresh watch and a fact, and no old mail is read", async () => {
  const mind = gmailMind();
  await gmailEvent(mind.itx, connected(ADA, 7));
  mind.gmail.arrives("/secrets/google", { id: "m1", threadId: "t1", labelIds: ["INBOX"] });
  mind.gmail.historyGone = true;
  mind.gmail.historyId = 500;

  await gmailEvent(mind.itx, pushed(ADA, 20, "500"));

  expect(mind.factsOn(ADA).slice(1)).toEqual([
    {
      type: WATCHED,
      payload: expect.objectContaining({ secret: "/secrets/google", historyId: "500" }),
    },
    {
      type: "events.iterate.com/google/gmail-history-lost",
      payload: { from: "100", to: "500" },
    },
  ]);
  expect(mind.rowOf(ADA)).toMatchObject({ historyId: "500" });
  // no read of the whole mailbox in its place
  expect(mind.gmail.calls.filter((call) => call.includes("/messages"))).toEqual([]);
  // the same push again says it once
  await gmailEvent(mind.itx, pushed(ADA, 20, "500"));
  expect(mind.factsOn(ADA)).toHaveLength(3);
  // from the new place on, mail arrives as before
  mind.gmail.historyGone = false;
  mind.gmail.arrives("/secrets/google", { id: "m9", threadId: "t9", labelIds: ["INBOX"] });
  await gmailEvent(mind.itx, pushed(ADA, 24, "501"));
  expect(mind.factsOn(ADA).at(-1)).toMatchObject({ type: ADDED, payload: { id: "m9" } });
});

test("once a day each mailbox is watched again and its history read; a mailbox whose secret is gone is dropped, and no watch is stopped", async () => {
  const mind = gmailMind();
  await gmailEvent(mind.itx, connected(ADA, 7));
  await gmailEvent(mind.itx, connected(WORK, 8));
  expect(mind.rowOf(WORK)).toMatchObject({ secret: "/secrets/google-work" });
  // a push that Gmail dropped: the day's read finds the mail
  mind.gmail.arrives("/secrets/google", { id: "m1", threadId: "t1", labelIds: ["INBOX"] });
  const due = (offset: number) => ({
    type: "events.iterate.com/google/gmail-watch-requested",
    path: "/",
    offset,
  });

  mind.gmail.watches.length = 0;
  await gmailEvent(mind.itx, due(30));

  expect(mind.gmail.watches.map((watch) => watch.secret)).toEqual([
    "/secrets/google",
    "/secrets/google-work",
  ]);
  expect(mind.factsOn(ADA).map((fact) => fact.type)).toEqual([WATCHED, WATCHED, ADDED]);
  // the same day's event again: no second fact of that day
  await gmailEvent(mind.itx, due(30));
  expect(mind.factsOn(ADA)).toHaveLength(3);
  // an event of this type on another context is not the schedule's
  mind.gmail.watches.length = 0;
  await gmailEvent(mind.itx, { ...due(31), path: "/agents/web/a1" });
  expect(mind.gmail).toMatchObject({ watches: [] });

  // GMAIL REFUSES ONE GRANT (the person withdrew it): the log says so, and the other mailbox is
  // watched all the same
  mind.gmail.refuses.add("/secrets/google");
  await gmailEvent(mind.itx, due(32));
  expect(mind.factsOn(ADA).at(-1)).toEqual({
    type: "events.iterate.com/google/gmail-watch-failed",
    payload: { reason: "Gmail answered 403 to the watch of ada@example.com" },
  });
  expect(mind.gmail.watches.map((watch) => watch.secret)).toEqual(["/secrets/google-work"]);

  // THE SECRET IS DELETED: a push for its mailbox reads nothing and fails nothing, and the next
  // day's event drops the mailbox
  mind.secrets.delete("/secrets/google");
  await gmailEvent(mind.itx, pushed(ADA, 33, "200"));
  await gmailEvent(mind.itx, due(34));
  expect([mind.rowOf(ADA), mind.rowOf(WORK)?.secret]).toEqual([null, "/secrets/google-work"]);
  expect(mind.schedules).toHaveProperty("gmail-watch");
  // the last mailbox goes, and the schedule with it
  mind.secrets.delete("/secrets/google-work");
  await gmailEvent(mind.itx, due(35));
  expect([mind.rowOf(WORK), mind.schedules]).toEqual([null, {}]);
  // ONE WATCH PER MAILBOX IS SHARED by every mind that connected it: this one never stops it
  expect(mind.gmail.calls.filter((call) => call.includes("/stop"))).toEqual([]);
});

/** The Cloud's word that this mind connected the mailbox of `path`. */
function connected(path: string, offset: number) {
  return {
    type: "events.iterate.com/google/gmail-connected",
    path,
    offset,
    source: { signer: { principal: { actor: "iterate-cloud" } } },
    payload: { emailAddress: path.split("/").at(-1)!, topic: TOPIC, api: API },
  };
}

/** Gmail's push for the mailbox of `path`, as the Cloud relays it. */
function pushed(path: string, offset: number, historyId: string) {
  return {
    type: "events.iterate.com/google/gmail-push-received",
    path,
    offset,
    source: { signer: { principal: { actor: "iterate-cloud" } } },
    payload: {
      emailAddress: path.split("/").at(-1)!,
      historyId,
      messageId: `pubsub-${offset}`,
      publishTime: "2026-11-12T22:00:00.000Z",
    },
  };
}

type Message = { id: string; threadId: string; labelIds: string[]; [field: string]: unknown };

/** A mind with four secrets (two Google grants of the Cloud's client, a key of another service,
 *  and a grant pinned elsewhere) and a Gmail that answers each grant as its own mailbox. */
function gmailMind() {
  const kept = new Map<string, string>();
  const facts: { path: string; type: string; idempotencyKey?: string; payload?: unknown }[] = [];
  const schedules: Record<string, unknown> = {};
  const secrets = new Map([
    ["/secrets/openai", { urls: ["https://api.openai.com"], mailbox: "" }],
    ["/secrets/google-work", { urls: [API], refresh: "oauth-refresh-token", mailbox: "work" }],
    ["/secrets/google", { urls: [API], refresh: "oauth-refresh-token", mailbox: "Ada" }],
    [
      "/secrets/elsewhere",
      { urls: ["https://elsewhere.test"], refresh: "oauth-refresh-token", mailbox: "" },
    ],
  ]);
  const gmail = {
    /** Each request as `<secret> <method> <path and query>`. */
    calls: [] as string[],
    watches: [] as { secret: string; body: unknown }[],
    /** The mailboxes' newest history id (one for all: a test moves one mailbox at a time). */
    historyId: 100,
    history: [] as { secret: string; id: string; message: Message }[],
    historyGone: false,
    /** The messages that Gmail answers 503 for, by id. */
    busy: new Set<string>(),
    /** The messages that Gmail answers 400 for, by id: a refusal no repeat changes. */
    refusesMessage: new Set<string>(),
    refusesWatch: false,
    watchExpires: true,
    refuses: new Set<string>(),
    /** One message arrives in the mailbox of `secret`: one history record. */
    arrives(secret: string, message: Message) {
      gmail.historyId += 1;
      gmail.history.push({ secret, id: String(gmail.historyId), message });
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
      const call = url.pathname.replace("/gmail/v1/users/me/", "");
      gmail.calls.push(`${secret} ${request.method} /${call}${url.search}`);
      if (gmail.refuses.has(secret!))
        return Response.json(
          { error: { code: 403, status: "PERMISSION_DENIED" } },
          { status: 403 },
        );
      if (call === "profile")
        return Response.json({
          emailAddress: `${held.mailbox}@Example.com`,
          historyId: String(gmail.historyId),
        });
      if (call === "watch" && gmail.refusesWatch)
        return Response.json(
          { error: { code: 403, status: "PERMISSION_DENIED" } },
          { status: 403 },
        );
      if (call === "watch") {
        gmail.watches.push({ secret: secret!, body: await request.json() });
        return Response.json({
          historyId: String(gmail.historyId),
          expiration: gmail.watchExpires ? String(Date.UTC(2026, 10, 19, 22)) : undefined,
        });
      }
      if (call === "history") {
        if (gmail.historyGone)
          return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
        // forty records a page, as Gmail pages a long history: the token is where a page ended
        const after = Number(
          url.searchParams.get("pageToken") || url.searchParams.get("startHistoryId"),
        );
        const records = gmail.history.filter(
          (record) => record.secret === secret && Number(record.id) > after,
        );
        return Response.json({
          history: records.slice(0, 40).map(({ id, message }) => ({
            id,
            messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }],
          })),
          nextPageToken: records.length > 40 ? records[39]!.id : undefined,
          historyId: String(gmail.historyId),
        });
      }
      if (gmail.refusesMessage.has(call.replace("messages/", "")))
        return Response.json(
          { error: { code: 400, status: "FAILED_PRECONDITION" } },
          { status: 400 },
        );
      if (gmail.busy.has(call.replace("messages/", "")))
        return Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 });
      const message = gmail.history.find(
        (record) => record.secret === secret && call === `messages/${record.message.id}`,
      )?.message;
      return message
        ? Response.json(message)
        : Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
    },
  };
  return {
    itx,
    gmail,
    secrets,
    schedules,
    /** How many requests went out with `secret`. */
    asked: (secret: string) => gmail.calls.filter((call) => call.startsWith(`${secret} `)).length,
    /** What the mind keeps of the mailbox of `path`. */
    rowOf: (path: string): Record<string, string> | null =>
      JSON.parse(kept.get(`gmail:${path}`) || "null"),
    setRow: (path: string, fields: Record<string, string>) =>
      kept.set(
        `gmail:${path}`,
        JSON.stringify({ ...JSON.parse(kept.get(`gmail:${path}`)!), ...fields }),
      ),
    /** The facts on the context `path`, without their idempotency keys. */
    factsOn: (path: string) =>
      facts.filter((fact) => fact.path === path).map(({ type, payload }) => ({ type, payload })),
  };
}
