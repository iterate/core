import { DatabaseSync } from "node:sqlite";
import { parse } from "iterate/expression";
import { applyPatch } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import { expect, test, vi } from "vitest";
import type { Caller } from "../caller.ts";
import { defineItxHost } from "../host.ts";
import {
  AWAKE_ACTIVITY_DEBOUNCE_MS,
  AWAKE_QUIET_MS,
  AwakeSocket,
  awakeContexts,
  setAwakeActivities,
} from "./awake.ts";
import { buildPortableBuiltIns } from "./built-ins.ts";
import {
  CONTEXT_ACTIVITIES_FACET,
  CONTEXT_ACTIVITY_POPPED_TYPE,
  CONTEXT_ACTIVITY_PUSHED_TYPE,
  CONTEXT_ACTIVITY_STACK_LIMIT,
  ContextActivityTracker,
  describeFetchActivity,
  describeItxCallActivity,
  describeScriptRunActivity,
  withTrackedActivity,
} from "./context-activity-stack.ts";
import { ContextCatalog, type ContextSummaryMessage } from "./context-catalog.ts";
import { ItxExpressionResolver } from "./itx-expression-rewriting.ts";

defineItxHost({ firstPartyFacets: {} });

test("ContextActivityTracker folds pushes, pops, TTL expiry, LiveState deltas, run-settled sweeps, and LLM lifecycle", () => {
  const deltas: { key: string; from: number; to: number; patch: unknown }[] = [];
  let changed = 0;
  const tracker = new ContextActivityTracker({
    sink: {
      append: (event) => {
        if (event.type === "events.iterate.com/itx/live-state-changed" && event.payload) {
          deltas.push(event.payload as { key: string; from: number; to: number; patch: unknown });
        }
      },
    },
    onChanged: () => {
      changed += 1;
    },
  });

  const seed0 = tracker.liveSnapshot(Date.parse("2026-11-25T12:00:00.000Z"));
  expect(seed0).toMatchObject({ state: [] });

  // Push run-scoped user items + an unbounded item
  tracker.committed(
    [
      streamEvent(
        1,
        CONTEXT_ACTIVITY_PUSHED_TYPE,
        "2026-11-25T12:00:00.000Z",
        {
          items: [
            {
              key: "gh",
              text: "Reading PR diff",
              url: "https://github.com/iterate/private/pull/42",
              tags: ["web", "github"],
              ttlMs: 30_000,
            },
            {
              key: "docs",
              text: "Checking DO hibernation docs",
              icon: "☁️",
              tags: ["docs"],
              ttlMs: 5_000,
            },
          ],
        },
        { onBehalfOf: { principal: { actor: "usr_a" }, run: "/agents/a@10" } },
      ),
    ],
    "/agents/a",
    Date.parse("2026-11-25T12:00:01.000Z"),
  );

  expect(tracker.active(Date.parse("2026-11-25T12:00:01.000Z")).map((item) => item.key)).toEqual([
    "docs",
    "gh",
  ]);
  expect(changed).toBe(1);

  // Lazy TTL expiry at t+6s drops `docs` and updates LiveState
  expect(tracker.active(Date.parse("2026-11-25T12:00:06.000Z")).map((item) => item.key)).toEqual([
    "gh",
  ]);
  expect(changed).toBe(2);

  // LLM requested -> Thinking item pushed; LLM settled -> popped
  tracker.committed(
    [
      streamEvent(11, "events.iterate.com/llm-request/requested", "2026-11-25T12:00:07.000Z", {
        model: "anthropic/claude-sonnet-4-6",
        purpose: "answer",
      }),
    ],
    "/agents/a",
    Date.parse("2026-11-25T12:00:07.000Z"),
  );
  expect(
    tracker.active(Date.parse("2026-11-25T12:00:07.000Z")).map((item) => [item.key, item.text]),
  ).toEqual([
    ["llm:11", "Thinking · claude-sonnet-4-6"],
    ["gh", "Reading PR diff"],
  ]);

  tracker.committed(
    [
      streamEvent(12, "events.iterate.com/llm-request/settled", "2026-11-25T12:00:09.000Z", {
        llmRequestOffset: 11,
      }),
    ],
    "/agents/a",
    Date.parse("2026-11-25T12:00:09.000Z"),
  );
  expect(tracker.active(Date.parse("2026-11-25T12:00:09.000Z")).map((item) => item.key)).toEqual([
    "gh",
  ]);

  // `itx/run-settled` for run 10 sweeps `gh` immediately even before its 30s TTL expires
  tracker.committed(
    [
      streamEvent(13, "events.iterate.com/itx/run-settled", "2026-11-25T12:00:10.000Z", {
        requestOffset: 10,
      }),
    ],
    "/agents/a",
    Date.parse("2026-11-25T12:00:10.000Z"),
  );
  expect(tracker.active(Date.parse("2026-11-25T12:00:10.000Z"))).toEqual([]);

  // Stack enforces CONTEXT_ACTIVITY_STACK_LIMIT
  for (let i = 0; i < CONTEXT_ACTIVITY_STACK_LIMIT + 5; i++) {
    tracker.push({ key: `k-${String(i)}`, text: `Item ${String(i)}`, tags: ["batch"] });
  }
  expect(tracker.active()).toHaveLength(CONTEXT_ACTIVITY_STACK_LIMIT);
  expect(tracker.active()[0]?.key).toBe(`k-${String(CONTEXT_ACTIVITY_STACK_LIMIT + 4)}`);

  // Pop by tag via CONTEXT_ACTIVITY_POPPED_TYPE
  tracker.committed(
    [
      streamEvent(14, CONTEXT_ACTIVITY_POPPED_TYPE, "2026-11-25T12:00:11.000Z", {
        tag: "batch",
      }),
    ],
    "/agents/a",
    Date.parse("2026-11-25T12:00:11.000Z"),
  );
  expect(tracker.active()).toEqual([]);

  // Clear empties everything
  tracker.push({ key: "temp", text: "Temporary" });
  tracker.clear();
  expect(tracker.active()).toEqual([]);

  // Wait for LiveState's async delta chain to flush and verify RFC-6902 patches reconstruct `[]`
  return Promise.resolve().then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((delta) => delta.key === CONTEXT_ACTIVITIES_FACET)).toBe(true);
    let clientState: unknown = seed0.state;
    let rev = seed0.rev;
    for (const delta of deltas) {
      expect(delta).toMatchObject({ from: rev });
      clientState = applyPatch(clientState, delta.patch as Parameters<typeof applyPatch>[1]);
      rev = delta.to;
    }
    expect(clientState).toEqual([]);
  });
});

test("ContextCatalog never persists activities to SQLite and clears them the instant an AwakeSocket closes", () => {
  const { sql, rawRows } = memorySqlStorage();
  const catalog = new ContextCatalog(sql);
  const sockets = fakeAwakeSocketHost();

  const ws = sockets.open("/agents/builder", 1_000);
  const summaryMsg: ContextSummaryMessage = {
    throughOffset: 8,
    eventCount: 8,
    createdAt: "2026-11-25T12:00:00.000Z",
    lastEventAt: "2026-11-25T12:00:05.000Z",
    lastActivityAt: "2026-11-25T12:00:05.000Z",
    eventTypes: { "events.iterate.com/agent/context-added": 8 },
    recentTypes: ["events.iterate.com/agent/context-added"],
    processors: ["agent"],
    storageBytes: 4_096,
    description: "Builds pull requests",
    activities: [
      {
        key: "mcp:linear",
        text: "Querying Linear issues",
        icon: "mcp",
        tags: ["mcp", "linear"],
        pushedAt: "2026-11-25T12:00:05.000Z",
        expiresAt: "2026-11-25T12:00:35.000Z",
      },
    ],
  };

  const extracted = catalog.store("/agents/builder", JSON.stringify(summaryMsg));
  setAwakeActivities(ws, extracted);

  // SQLite `context_catalog.summary` must NOT contain ephemeral `activities`
  const storedColumns = rawRows();
  expect(storedColumns).toHaveLength(1);
  expect(JSON.parse(storedColumns[0]!.summary)).not.toHaveProperty("activities");

  const aliveNow = Date.parse("2026-11-25T12:00:10.000Z");
  const whileAwake = catalog.list({}, awakeContexts(sockets.ctx), aliveNow);
  expect(whileAwake).toMatchObject([
    {
      path: "/agents/builder",
      awake: { since: 1_000 },
      activities: [{ key: "mcp:linear", text: "Querying Linear issues" }],
    },
  ]);

  // Search matches across durable summary ("agent") AND live activities ("linear")
  expect(
    catalog
      .list({ search: "agent linear" }, awakeContexts(sockets.ctx), aliveNow)
      .map((r) => r.path),
  ).toEqual(["/agents/builder"]);

  // Expired activity is filtered out at read time without needing another socket frame
  const afterTtl = Date.parse("2026-11-25T12:01:00.000Z");
  expect(catalog.list({}, awakeContexts(sockets.ctx), afterTtl)[0]?.activities).toBeUndefined();

  // Simulate DO crash / sleep: socket closes WITHOUT sending a cleared summary message
  ws.close();
  const afterCrash = catalog.list({}, awakeContexts(sockets.ctx), aliveNow);
  expect(afterCrash).toHaveLength(1);
  expect(afterCrash[0]?.awake).toBeUndefined();
  expect(afterCrash[0]?.activities).toBeUndefined();
});

test("AwakeSocket.activityChanged coalesces sub-debounce bursts and leaves zero timers on close", async () => {
  vi.useFakeTimers();
  try {
    const sent: string[] = [];
    let open = 0;
    let busy = true;
    let stack: string[] = [];
    const awake = new AwakeSocket({
      path: "/agents/a",
      busy: () => busy,
      summary: () => JSON.stringify({ stack }),
      dial: async () => ({
        status: 101,
        webSocket: {
          accept: () => {
            open += 1;
          },
          close: () => {
            open -= 1;
          },
          send: (msg: string) => void sent.push(msg),
          addEventListener: (() => undefined) as WebSocket["addEventListener"],
        },
      }),
    });

    awake.entered();
    await vi.advanceTimersByTimeAsync(10);
    expect(open).toBe(1);

    // Sub-debounce push + pop within 5ms sends nothing at 100ms because summary returned to baseline
    stack = ["fast-call"];
    awake.activityChanged();
    await vi.advanceTimersByTimeAsync(5);
    stack = [];
    awake.activityChanged();
    await vi.advanceTimersByTimeAsync(AWAKE_ACTIVITY_DEBOUNCE_MS + 10);
    // Initial send captures `{"stack":[]}`; no intermediate `["fast-call"]` frame was sent
    expect(sent).toEqual(['{"stack":[]}']);

    // Sustained activity sends after debounce without waiting 15s
    stack = ["long-fetch"];
    awake.activityChanged();
    await vi.advanceTimersByTimeAsync(AWAKE_ACTIVITY_DEBOUNCE_MS + 5);
    expect(sent).toEqual(['{"stack":[]}', '{"stack":["long-fetch"]}']);

    // Quiet close clears stack, sends final summary, and leaves zero timers
    stack = [];
    busy = false;
    await vi.advanceTimersByTimeAsync(AWAKE_QUIET_MS + 10);
    expect(open).toBe(0);
    expect(sent.at(-1)).toBe('{"stack":[]}');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("automatic itx call hooks format safe labels, strip URL secrets, push while in flight, and pop on settle", async () => {
  // URL credentials and query tokens must never leak into activity URLs or text
  const fetchEntry = describeFetchActivity(
    new Request("https://api.github.com/repos/iterate/private/pulls?token=shh#frag"),
  );
  expect(fetchEntry).toMatchObject({
    text: "Fetching api.github.com/repos/iterate/private/pulls",
    url: "https://api.github.com/repos/iterate/private/pulls",
    tags: ["web"],
  });
  expect(JSON.stringify(fetchEntry)).not.toContain("shh");
  expect(
    JSON.stringify(
      describeFetchActivity({
        url: "https://user:supersecret@api.github.com/repos/iterate/private",
      }),
    ),
  ).not.toContain("supersecret");

  expect(describeScriptRunActivity(7)).toEqual({
    entry: {
      key: "itx:run:7",
      text: "Running script",
      icon: "code",
      tags: ["code"],
      ttlMs: RUN_DEADLINE_MS,
    },
    runOffset: 7,
  });

  // High-level outbound `itx` expressions produce concise domain activities
  const caller: Caller = { principal: null };
  expect(
    describeItxCallActivity(
      parse('itx.agents.get("/agents/reviewer").message("hi")'),
      "/agents/a",
      caller,
    ),
  ).toMatchObject({
    text: "Messaging /agents/reviewer",
    icon: "agent",
    url: "/agents/reviewer",
    tags: ["agent"],
  });
  expect(
    describeItxCallActivity(
      parse('itx.repos.get("/repos/config").commitFiles({ message: "update" })'),
      "/agents/a",
      caller,
    ),
  ).toMatchObject({
    text: "Committing to /repos/config",
    icon: "code",
    url: "/repos/config",
    tags: ["code", "repo"],
  });
  expect(
    describeItxCallActivity(
      parse('itx.connectToMcp("https://mcp.linear.app/sse?apiKey=secret")'),
      "/agents/a",
      caller,
    ),
  ).toMatchObject({
    text: "Calling MCP mcp.linear.app",
    icon: "mcp",
    url: "https://mcp.linear.app/sse",
    tags: ["mcp"],
  });
  expect(
    describeItxCallActivity(
      parse('itx.ai.websearch({ query: "Cloudflare Durable Objects" })'),
      "/agents/a",
      caller,
    ),
  ).toMatchObject({
    text: "Searching web: Cloudflare Durable Objects",
    icon: "search",
    tags: ["search", "web"],
  });

  // Passive / housekeeping / internal calls produce no activity noise
  expect(describeItxCallActivity(parse("itx.whoami()"), "/agents/a", caller)).toBeNull();
  expect(describeItxCallActivity(parse("itx.contexts.list()"), "/", caller)).toBeNull();
  expect(
    describeItxCallActivity(
      parse('itx.facets.get("activities").liveSnapshot()'),
      "/agents/a",
      caller,
    ),
  ).toBeNull();
  expect(
    describeItxCallActivity(
      parse('itx.cd("/repos/config").facets.get("repo").readFile("a.ts")'),
      "/agents/a",
      { ...caller, libraryHop: true },
    ),
  ).toBeNull();

  // End-to-end in-flight hook through `ItxExpressionResolver` + `buildPortableBuiltIns`:
  // activity is live on the tracker WHILE egress/located awaits, and popped in `finally`.
  const tracker = new ContextActivityTracker({ sink: { append: () => undefined } });
  const hooks = {
    push: (entry: Parameters<typeof tracker.push>[0]) => tracker.push(entry),
    pop: (key: string) => tracker.pop({ key }),
  };
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  let releaseRemote!: () => void;
  const remoteGate = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });

  const resolver = new ItxExpressionResolver({
    path: "/agents/a",
    caller: () => ({ principal: null }),
    rewriteRules: () => [{ match: ["itx"], target: ["itx", "builtins", ["cd", "/"]] }],
    reach: {
      recordLoopLimit: () => undefined,
      snapshotOf: async () => ({ rules: [], readAt: 0, expiresAt: Infinity }),
      located: async () => {
        await remoteGate;
        return { ok: true };
      },
      workersOf: () => ({}),
    },
    builtIns: () =>
      buildPortableBuiltIns({
        path: "/agents/a",
        context: () => {
          throw new Error("unused");
        },
        egress: (request) =>
          withTrackedActivity(describeFetchActivity(request), hooks, async () => {
            await fetchGate;
            return new Response("ok");
          }),
        afterTheAnswer: () => undefined,
        caller: () => ({ principal: null }),
        invokeAs: (_c, call) => resolver.invoke(call),
        itx: {} as never,
      }),
    wrapActivity: (expression, callCaller, run) =>
      withTrackedActivity(describeItxCallActivity(expression, "/agents/a", callCaller), hooks, run),
  });

  const inFlightFetch = resolver.invoke(
    ["itx", "fetch"],
    new Request("https://developers.cloudflare.com/workers/"),
  );
  const inFlightMessage = resolver.invoke(
    parse('itx.cd("/agents/peer").append({ type: "demo/ping", payload: {} })'),
  );

  // Both parallel calls are visible simultaneously on the context's live activity stack!
  await vi.waitFor(() => expect(tracker.active()).toHaveLength(2));
  expect(tracker.active().map((item) => item.text)).toEqual([
    "Fetching developers.cloudflare.com/workers/",
    "Messaging /agents/peer",
  ]);

  releaseFetch();
  await inFlightFetch;
  expect(tracker.active().map((item) => item.text)).toEqual(["Messaging /agents/peer"]);

  releaseRemote();
  await inFlightMessage;
  expect(tracker.active()).toEqual([]);
});

function streamEvent(
  offset: number,
  type: string,
  createdAt: string,
  payload: Record<string, unknown>,
  sourceExtra: Partial<StreamEvent["source"]> = {},
): StreamEvent {
  return {
    offset,
    type,
    createdAt,
    payload,
    path: "/agents/a",
    source: { origin: "/agents/a", ...sourceExtra },
  };
}

function memorySqlStorage(): {
  sql: SqlStorage;
  rawRows: () => { path: string; summary: string }[];
} {
  const db = new DatabaseSync(":memory:");
  const exec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ) => {
    const trimmed = query.trim();
    if (/^SELECT\b/i.test(trimmed)) {
      const rows = db.prepare(query).all(...(bindings as never[])) as T[];
      return { toArray: () => rows };
    }
    db.prepare(query).run(...(bindings as never[]));
    return { toArray: () => [] as T[] };
  };
  return {
    sql: { exec } as unknown as SqlStorage,
    rawRows: () =>
      db.prepare("SELECT path, summary FROM context_catalog").all() as {
        path: string;
        summary: string;
      }[],
  };
}

function fakeAwakeSocketHost() {
  type FakeSocket = {
    readyState: number;
    deserializeAttachment: () => unknown;
    serializeAttachment: (value: unknown) => void;
    close: () => void;
  };
  const list: FakeSocket[] = [];
  return {
    open(path: string, since: number) {
      let attachment: unknown = { path, since };
      const ws: FakeSocket = {
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => structuredClone(attachment),
        serializeAttachment: (value: unknown) => {
          attachment = structuredClone(value);
        },
        close: () => {
          ws.readyState = WebSocket.CLOSED;
        },
      };
      list.push(ws);
      return ws;
    },
    ctx: {
      getWebSockets: () => list as unknown as WebSocket[],
    },
  };
}
