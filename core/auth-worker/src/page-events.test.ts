// `POST /.page-events` (./page-events.ts): its refusals, and the facts of a member's and an
// outsider's records, on the right contexts, cut to the right sizes, within the minute's bounds
// and the day's budget of the outside in D1; a URL's query cut out; no failure thrown out.
import { decodeFacts, FACTS_HEADER, type Facts } from "iterate/facts";
import { expect, test, vi } from "vitest";
import type { Env } from "./env.ts";
import {
  BOUNDS,
  EXCEPTION_SEEN,
  OUTSIDE_A_DAY,
  outsideReserved,
  PAGE_LEFT,
  PAGE_VIEWED,
  pageEventsResponse,
  resetBounds,
  resetSpentDay,
  type Sender,
  senderOf,
} from "./page-events.ts";
import { configVars, sqliteStack } from "./test-support.ts";

const ORIGIN = "https://iterate.example.com";
const MEMBER: Sender = {
  actor: { userId: "user_owner", email: "owner@example.net" },
  member: true,
};
const OUTSIDER: Sender = { actor: null, member: false };
const PAGE = {
  id: "aaaabbbbccccdddd",
  title: "Members of iterate.example.com",
  screen: [1440, 900],
  viewport: [1280, 760],
  language: "en-GB",
  timezone: "Europe/London",
  timezoneOffset: 0,
};
const CF = {
  country: "GB",
  region: "England",
  city: "London",
  postalCode: "EC1A",
  continent: "EU",
  timezone: "Europe/London",
  latitude: "51.50853",
  longitude: "-0.12574",
};

test("the route refuses another path, another method, another origin, a large body, and a body that is no send", async () => {
  const other = new Request(`${ORIGIN}/members`);
  expect(
    await pageEventsResponse(
      other,
      async () => MEMBER,
      async () => true,
    ),
  ).toBeNull();
  expect(await answer(sent(null, {}, "GET"))).toMatchObject({ status: 405 });
  const elsewhere = sent({ page: PAGE, events: [] }, { origin: "https://evil.example" });
  expect(await answer(elsewhere)).toMatchObject({ status: 403 });
  const noOrigin = new Request(`${ORIGIN}/.page-events`, { method: "POST", body: "{}" });
  expect(await answer(noOrigin)).toMatchObject({ status: 403 });
  expect(await answer(sent("x".repeat(16_001)))).toMatchObject({ status: 413 });
  expect(await answer(sent("not json"))).toMatchObject({ status: 400 });
  expect(await answer(sent([]))).toMatchObject({ status: 400 });
  expect(await answer(sent({ page: { id: "no" }, events: [] }))).toMatchObject({ status: 400 });
  const many = Array.from({ length: 21 }, (_, i) => record(i + 1, "viewed"));
  expect(await answer(sent({ page: PAGE, events: many }))).toMatchObject({ status: 400 });
  expect(await answer(sent({ page: PAGE, events: [] }))).toEqual({ status: 204, facts: [] });
});

test("a member's view, leave and error: the views on /pages, the error on /exceptions, with the platform's actor and the place to 2 decimals", async () => {
  const { status, facts } = await answer(
    sent({
      page: PAGE,
      events: [
        record(1, "viewed", { pathname: "/keys/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee?x=1" }),
        record(2, "error", {
          kind: "uncaught",
          message: "m ".repeat(1_000),
          stack: "s ".repeat(3_000),
        }),
        record(3, "left", { openMs: 48_210, seenMs: 40_102, scrolled: 85 }),
        { type: "typed", value: "secret" },
      ],
    }),
  );
  expect(status).toBe(204);
  expect(facts.map((fact) => [fact.path, fact.events.map((event) => event.type)])).toEqual([
    ["/pages", [PAGE_VIEWED, PAGE_LEFT]],
    ["/exceptions", [EXCEPTION_SEEN]],
  ]);
  const [viewed, left] = facts[0]!.events;
  expect(viewed).toEqual({
    type: PAGE_VIEWED,
    idempotencyKey: "page/viewed:aaaabbbbccccdddd:1",
    payload: {
      app: "iterate",
      host: "iterate.example.com",
      page: PAGE.id,
      view: 1,
      visitor: null,
      actor: MEMBER.actor,
      member: true,
      country: "GB",
      place: {
        region: "England",
        city: "London",
        postalCode: "EC1A",
        continent: "EU",
        timezone: "Europe/London",
        latitude: 51.51,
        longitude: -0.13,
      },
      userAgent: "Mozilla/5.0 (Macintosh)",
      pathname: "/keys/<id>",
      at: "2026-11-22T10:00:00.000Z",
      how: "load",
      title: PAGE.title,
      screen: [1440, 900],
      viewport: [1280, 760],
      language: "en-GB",
      timezone: "Europe/London",
      timezoneOffset: 0,
    },
  });
  expect(left!.payload).toMatchObject({ openMs: 48_210, seenMs: 40_102, scrolled: 85 });
  const error = facts[1]!.events[0]!;
  expect(error).toMatchObject({
    idempotencyKey: "exception/seen:page:iterate:aaaabbbbccccdddd-2",
  });
  expect(error.payload).toMatchObject({
    kind: "uncaught",
    count: 1,
    source: { from: "page", app: "iterate" },
    where: { pathname: "/members" },
    actor: MEMBER.actor,
    member: true,
    page: PAGE.id,
  });
  // a member's texts: 1,024 and 4,000
  expect(String(error.payload!.message)).toHaveLength(1_024);
  expect(String(error.payload!.stack)).toHaveLength(4_000);
});

test("an outsider's error lands on /exceptions/outside, cut to 300 and 1,000, with no actor, no member and no visitor", async () => {
  const { facts } = await answer(
    sent({
      page: PAGE,
      events: [
        record(1, "error", {
          kind: "rejection",
          message: "m ".repeat(1_000),
          stack: "s ".repeat(3_000),
        }),
      ],
    }),
    OUTSIDER,
  );
  expect(facts.map((fact) => fact.path)).toEqual(["/exceptions/outside"]);
  const { payload } = facts[0]!.events[0]!;
  expect(String(payload!.message)).toHaveLength(300);
  expect(String(payload!.stack)).toHaveLength(1_000);
  expect(payload).toMatchObject({ kind: "rejection", actor: null, visitor: null });
  expect(payload).not.toHaveProperty("member");
});

test("each minute, in the isolate: 120 records from members, 30 from everyone else, 30 errors; a record over a bound is dropped and the answer stays 204", async () => {
  resetBounds();
  const views = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => record(from + i, "viewed"));
  const counted = async (events: unknown[], sender: Sender) => {
    const { status, facts } = await answer(sent({ page: PAGE, events }), sender, false);
    expect(status).toBe(204);
    return facts.reduce((sum, fact) => sum + fact.events.length, 0);
  };
  let outside = 0;
  for (let i = 0; i < 3; i++) outside += await counted(views(i * 20, 20), OUTSIDER);
  expect(outside).toBe(BOUNDS.outside);
  let members = 0;
  for (let i = 0; i < 7; i++) members += await counted(views(i * 20, 20), MEMBER);
  expect(members).toBe(BOUNDS.member);

  resetBounds();
  const errors = (from: number) =>
    Array.from({ length: 20 }, (_, i) => record(from + i, "error", { message: `e${from + i}` }));
  expect((await counted(errors(0), MEMBER)) + (await counted(errors(20), MEMBER))).toBe(
    BOUNDS.errors,
  );
});

test("the sender is the Worker's own word: no session cookie is nobody, whatever the page says", async () => {
  // the cast: with no cookie the session check reads no binding
  const env = configVars() as unknown as Env;
  expect(await senderOf(env, sent({}, { cookie: "" }))).toEqual({ actor: null, member: false });
});

test("the day's budget of the outside: each batch reserves its records in D1 in one statement, and a batch that would pass 5,000 is dropped whole", async () => {
  resetSpentDay();
  const { env, db } = sqliteStack();
  const reserve = (records: number) => outsideReserved(env.DB, records);
  const views = (count: number) =>
    sent({ page: PAGE, events: Array.from({ length: count }, (_, i) => record(i + 1, "viewed")) });
  expect((await answer(views(20), OUTSIDER, true, reserve)).facts[0]?.events).toHaveLength(20);
  const today = new Date().toISOString().slice(0, 10);
  const stored = () => db.prepare("select day, records from page_event_days").all();
  expect(stored()).toEqual([{ day: today, records: 20 }]);
  // a member's records reserve nothing
  expect((await answer(views(5), MEMBER, true, reserve)).facts).toHaveLength(1);
  expect(stored()).toEqual([{ day: today, records: 20 }]);
  // the rows of days before yesterday go
  db.prepare("insert into page_event_days (day, records) values ('2026-01-01', 7)").run();
  await reserve(1);
  expect(stored()).toEqual([{ day: today, records: 21 }]);
  // 4,990 taken: a batch of 10 fits, and then a batch of 1 would pass 5,000, so none of it lands
  db.prepare("update page_event_days set records = ?").run(OUTSIDE_A_DAY - 10);
  expect((await answer(views(10), OUTSIDER, true, reserve)).facts[0]?.events).toHaveLength(10);
  expect(await answer(views(1), OUTSIDER, true, reserve)).toEqual({ status: 204, facts: [] });
  expect(stored()).toEqual([{ day: today, records: OUTSIDE_A_DAY }]);
  // a member's records still land
  expect((await answer(views(1), MEMBER, true, reserve)).facts).toHaveLength(1);
});

test("a batch that would pass 5,000 is dropped whole, and after that one refusal the isolate takes no record from outside and asks D1 nothing until the next UTC day", async () => {
  resetSpentDay();
  const { env, db } = sqliteStack();
  let batches = 0;
  const counted: Pick<D1Database, "prepare" | "batch"> = {
    prepare: (query) => env.DB.prepare(query),
    batch: (statements) => {
      batches += 1;
      return env.DB.batch(statements);
    },
  };
  const reserve = (records: number) => outsideReserved(counted, records);
  const views = (count: number) =>
    sent({ page: PAGE, events: Array.from({ length: count }, (_, i) => record(i + 1, "viewed")) });
  const today = new Date().toISOString().slice(0, 10);
  db.prepare("insert into page_event_days (day, records) values (?, ?)").run(
    today,
    OUTSIDE_A_DAY - 10,
  );
  expect(await answer(views(20), OUTSIDER, true, reserve)).toEqual({ status: 204, facts: [] });
  expect(batches).toBe(1);
  // the day is closed in this isolate: 10 would fit in D1, and still nothing lands or is asked
  expect(await answer(views(10), OUTSIDER, true, reserve)).toEqual({ status: 204, facts: [] });
  expect(batches).toBe(1);
  expect(db.prepare("select day, records from page_event_days").all()).toEqual([
    { day: today, records: OUTSIDE_A_DAY - 10 },
  ]);
  // a member's records still land
  expect((await answer(views(1), MEMBER, true, reserve)).facts).toHaveLength(1);
  // the next UTC day opens it again
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 86_400_000);
    expect((await answer(views(10), OUTSIDER, true, reserve)).facts[0]?.events).toHaveLength(10);
    expect(batches).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("nothing throws out of the route: a body that cannot be read is a 400, a sender or a budget that cannot be asked a 503, each with no facts", async () => {
  const broken = new Request(`${ORIGIN}/.page-events`, {
    method: "POST",
    headers: { origin: ORIGIN },
    body: new ReadableStream({
      pull(controller) {
        controller.error(new Error("the connection went away"));
      },
    }),
    // @ts-expect-error -- Node's fetch asks for it with a stream body; the Workers types know no such field
    duplex: "half",
  });
  expect(await answer(broken)).toEqual({ status: 400, facts: [] });
  const view = () => sent({ page: PAGE, events: [record(1, "viewed")] });
  const noSender = await pageEventsResponse(
    view(),
    async () => {
      throw new Error("D1 is down");
    },
    async () => true,
  );
  expect(noSender).toMatchObject({ status: 503 });
  expect(noSender!.headers.get(FACTS_HEADER)).toBeNull();
  const down = async () => {
    throw new Error("D1 is down");
  };
  expect(await answer(view(), OUTSIDER, true, down)).toEqual({ status: 503, facts: [] });
  // a member's records ask no budget
  expect((await answer(view(), MEMBER, true, down)).facts).toHaveLength(1);
});

test("an OAuth callback's URL in a message, a stack or a path keeps its path alone, and the Referer is never read", async () => {
  const callback = "https://iterate.example.com/oauth2/callback?code=abc123&state=xyz789";
  const { facts } = await answer(
    sent(
      {
        page: PAGE,
        events: [
          record(1, "viewed", { pathname: "/oauth2/callback/code=abc123?state=xyz789" }),
          record(2, "error", {
            message: `Failed to fetch ${callback}`,
            stack: `Error: no\n    at go (${callback}:12:5)\n    at /oauth2/callback?code=abc123:3:4`,
          }),
        ],
      },
      { referer: callback },
    ),
  );
  expect(facts[0]!.events[0]!.payload).toMatchObject({ pathname: "/oauth2/callback/<cut>" });
  expect(facts[1]!.events[0]!.payload).toMatchObject({
    message: "Failed to fetch /oauth2/callback",
    stack: "Error: no\n    at go (/oauth2/callback:12:5)\n    at /oauth2/callback:3:4",
    where: { pathname: "/members" },
  });
  expect(JSON.stringify(facts)).not.toMatch(/abc123|xyz789|code=|state=/);
});

test("a URL in any form, in a message, a stack, a path or a title, keeps its path alone: no host, no query string, no hash", async () => {
  const { facts } = await answer(
    sent({
      page: { ...PAGE, title: "Sessions · see /sessions?next=%2Fkeys#top" },
      events: [
        record(1, "viewed", { pathname: "/sessions/assets?rev=sample#section" }),
        record(2, "error", {
          message:
            "load assets/app.js?rev=sample#section and //cdn.example/assets/app.js?v=2 failed",
          stack:
            "Error: no\n    at go (assets/app.js?rev=sample#x:3:4)\n    at //cdn.example/lib/a.js?v=2:1:2\n    at f@vendor.js?v=9:5:6",
        }),
      ],
    }),
  );
  expect(facts[0]!.events[0]!.payload).toMatchObject({
    pathname: "/sessions/assets",
    title: "Sessions · see /sessions",
  });
  expect(facts[1]!.events[0]!.payload).toMatchObject({
    message: "load assets/app.js and /assets/app.js failed",
    stack: "Error: no\n    at go (assets/app.js:3:4)\n    at /lib/a.js:1:2\n    at f@vendor.js:5:6",
  });
  expect(JSON.stringify(facts)).not.toMatch(/rev=|v=2|v=9|#section|#top|cdn\.example|next=/);
});

test("a text field that holds an object, even one whose string form throws, is no text: the route answers 204 and throws nothing", async () => {
  // `String()` throws on an object whose `toString` is no function
  const object = { toString: 1, valueOf: 1 };
  const { status, facts } = await answer(
    sent({
      page: { ...PAGE, title: object, language: object, timezone: object },
      events: [
        record(1, "viewed", { pathname: object, at: object }),
        record(2, "error", { pathname: object, at: object, message: object, stack: object }),
        record(3, "left", { pathname: object, at: object }),
      ],
    }),
  );
  expect(status).toBe(204);
  expect(facts[0]!.events[0]!.payload).toMatchObject({
    pathname: "",
    title: "",
    language: "",
    timezone: "",
  });
  expect(facts[1]!.events[0]!.payload).toMatchObject({ message: "(no message)", stack: "" });
});

function sent(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  const request = new Request(`${ORIGIN}/.page-events`, {
    method,
    headers: { origin: ORIGIN, "user-agent": "Mozilla/5.0 (Macintosh)", ...headers },
    ...(method === "POST" && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  // the cast: a test's request has no `cf`, which Cloudflare sets on a real one
  Object.defineProperty(request, "cf", { value: CF });
  return request;
}

/** One send. `fresh`: in a new minute, with no record counted. `reserve` holds the day's budget:
 *  by default it takes every batch. */
async function answer(
  request: Request,
  sender = MEMBER,
  fresh = true,
  reserve: (records: number) => Promise<boolean> = async () => true,
) {
  if (fresh) resetBounds();
  const response = await pageEventsResponse(request, async () => sender, reserve);
  const header = response?.headers.get(FACTS_HEADER);
  return { status: response?.status, facts: header ? decodeFacts(header) : ([] as Facts) };
}

function record(n: number, type: string, more: Record<string, unknown> = {}) {
  return { type, n, pathname: "/members", at: "2026-11-22T10:00:00.000Z", ...more };
}
