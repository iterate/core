// Which sandbox gets a session of its own (./own-session.ts), and what a live one does on a frame.
import { expect, test } from "vitest";
import { asksForOwnSession, egressFilterOf, ownSessionOf, sessionWatch } from "./own-session.ts";

const DOMAIN = "example.com";
const API = "https://iterate.example.com/api";
const BOX = "/agents/ada/box";

/** What `rewriteRules.list()` answers at a sandbox whose links reach the mind's root: its own
 *  roots, and the root's built-in fetch. */
const unfiltered = [
  { match: "itx.append", target: "itx.builtins.append", context: BOX },
  { match: "itx", target: "itx.builtins.cd('/agents/ada')", context: BOX },
  { match: "itx.fetch", target: "itx.builtins.fetch", context: "/" },
];

test.for<{ name: string; request: Request; asks: boolean }>([
  { name: "the API, no bearer", request: new Request(API), asks: true },
  {
    name: "the API's handshake, no bearer",
    request: new Request(API, { headers: { upgrade: "websocket" } }),
    asks: true,
  },
  {
    name: "a bearer of its own, a placeholder too",
    request: new Request(API, {
      headers: { authorization: 'Bearer getSecret("/secrets/iterate-mind")' },
    }),
    asks: false,
  },
  { name: "a path under the API", request: new Request(`${API}/webhooks/x`), asks: false },
  { name: "a query that names a path", request: new Request(`${API}?sandbox=/other`), asks: false },
  { name: "the MCP server", request: new Request("https://iterate.example.com/mcp"), asks: false },
  {
    name: "another mind's API",
    request: new Request("https://iterate.other.com/api"),
    asks: false,
  },
  { name: "plain http", request: new Request("http://iterate.example.com/api"), asks: false },
])("a request asks for the sandbox's own session: $name → $asks", ({ request, asks }) => {
  expect(asksForOwnSession(request, DOMAIN)).toBe(asks);
});

test("a sandbox that sends through the mind's own fetch gets a session", () => {
  expect(egressFilterOf(unfiltered)).toBeNull();
});

test("a sandbox started with an egress rule gets none: the rule is on its own context", () => {
  const rows = [
    { match: "itx.fetch", target: "itx.cd('/').workers.get(@).fetch", context: BOX },
    ...unfiltered.filter((row) => row.match !== "itx.fetch"),
  ];
  expect(egressFilterOf(rows)).toBe(
    `the mind filters what it sends (the rule for itx.fetch at ${BOX})`,
  );
});

test("a sandbox beneath a jail gets none: it inherits the jail's rule for itx.fetch", () => {
  const jail = "/jails/visitors/a";
  const rows = [
    { match: "itx.append", target: "itx.builtins.append", context: `${jail}/box` },
    { match: "itx", target: `itx.builtins.cd('${jail}')`, context: `${jail}/box` },
    {
      match: "itx.fetch",
      target: "itx.builtins.cd('/').config.jailFetch('visitors', @)",
      context: jail,
    },
  ];
  expect(egressFilterOf(rows)).toBe(
    `the mind filters what it sends (the rule for itx.fetch at ${jail})`,
  );
});

test("a masked itx.fetch, a bare null, and a list that is no list give no session", () => {
  expect(egressFilterOf([{ match: "itx.fetch", target: null, context: BOX }])).toMatch(/filters/);
  // a bare `itx ⇒ null` on the sandbox's context: the list holds its own rows alone
  expect(egressFilterOf([{ match: "itx", target: null, context: BOX }])).toBe(
    "itx.fetch is masked for it",
  );
  expect(egressFilterOf([])).toBe("itx.fetch is masked for it");
  expect(egressFilterOf("FORBIDDEN")).toBe("its context's rules could not be read");
});

test("who the session is comes from the sandbox's name alone, as the code of its context", () => {
  // the request has no part in it: `ownSessionOf` takes the path the egress's props name
  expect(ownSessionOf(BOX)).toEqual({ path: BOX, caller: { principal: null, app: true } });
  const forged = new Request(API, {
    headers: {
      "x-itx-caller-path": "/agents/bob/box",
      "x-itx-principal": '{"actor":"user_1"}',
      "x-iterate-sandbox": "/agents/bob/box",
    },
  });
  // such a request still asks, and still gets the session of the sandbox it came from
  expect(asksForOwnSession(forged, DOMAIN)).toBe(true);
});

test("a rule that lands while a session lives ends it on the next frame that checks", async () => {
  const live = watched();
  live.clock.now = 4_000;
  expect(await live.onFrame()).toBeUndefined();
  expect(live).toMatchObject({ reads: 0 });
  // five seconds after the session opened the rules are read again, and nothing filters the sandbox
  live.clock.now = 5_000;
  expect(await live.onFrame()).toBeUndefined();
  expect(live).toMatchObject({ reads: 1 });
  // an owner's `start({ egress })`, or a jail above, lands now
  live.rows = [{ match: "itx.fetch", target: "itx.cd('/').workers.get(@).fetch", context: BOX }];
  live.clock.now = 9_000;
  expect(await live.onFrame()).toBeUndefined();
  live.clock.now = 10_000;
  const reason = `the mind filters what it sends (the rule for itx.fetch at ${BOX})`;
  expect(await live.onFrame()).toBe(`this sandbox's session ended: ${reason}`);
  expect(live).toMatchObject({ ended: [reason] });
});

test("an open session is use: a frame stamps the sandbox's clock, at most every ten seconds", async () => {
  const live = watched();
  for (const now of [1_000, 9_999, 10_000, 15_000, 20_000]) {
    live.clock.now = now;
    await live.onFrame();
  }
  expect(live).toMatchObject({ stamps: [10_000, 20_000] });
});

test.for<{ name: string; used: () => Promise<void> }>([
  { name: "fails", used: () => Promise.reject(new Error("the container's object was reset")) },
  { name: "never answers", used: () => new Promise<void>(() => {}) },
])("a stamp that $name does not keep a rule from ending the session", async ({ used }) => {
  const now = { ms: 0 };
  const rule = [{ match: "itx.fetch", target: null, context: BOX }];
  const onFrame = sessionWatch({
    now: () => now.ms,
    used,
    filter: async () => egressFilterOf(rule),
    ended: () => {},
  });
  // the frame that is due a stamp and a check at once
  now.ms = 10_000;
  expect(await onFrame()).toMatch(/^this sandbox's session ended: the mind filters what it sends/);
});

test("rules that cannot be read end a live session, as they refuse one at its start", async () => {
  const now = { ms: 5_000 };
  const ended: string[] = [];
  const onFrame = sessionWatch({
    now: () => (now.ms += 5_000),
    used: async () => {},
    filter: () => Promise.reject(new Error("the context is overloaded")),
    ended: (reason) => void ended.push(reason),
  });
  expect(await onFrame()).toBe(
    "this sandbox's session ended: its context's rules could not be read (Error: the context is overloaded)",
  );
  expect(ended).toEqual([
    "its context's rules could not be read (Error: the context is overloaded)",
  ]);
});

/** A live session's watch over a clock, a container and a table that the test moves. */
function watched() {
  const live = {
    clock: { now: 0 },
    rows: unfiltered as unknown[],
    reads: 0,
    stamps: [] as number[],
    ended: [] as string[],
    onFrame: async (): Promise<string | undefined> => undefined,
  };
  live.onFrame = sessionWatch({
    now: () => live.clock.now,
    used: async () => void live.stamps.push(live.clock.now),
    filter: async () => {
      live.reads += 1;
      return egressFilterOf(live.rows);
    },
    ended: (reason) => void live.ended.push(reason),
  });
  return live;
}
