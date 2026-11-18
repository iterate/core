// THE FETCH ROUTE TABLE against shapes that this kernel did not write: the earlier stack's
// `{ routingSlug }` matcher, an empty matcher, and a checkpoint that an older reduce saved. Each
// must leave no route that takes a request: a route that matched everything would serve one
// sandbox on every hostname of the mind. The in-memory storage is stream-wake-events.test.ts's.
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { defineItxHost } from "./host.ts";
import {
  FetchRouteConfiguredPayload,
  matchFetchRoute,
  reduceFetchRouteConfigured,
  type FetchRouteTable,
} from "./fetch-routes.ts";
import { CoreContract, reduceCoreEventBatch } from "./stream/core-processor.ts";
import { Stream } from "./stream/stream.ts";

const TYPE = "events.iterate.com/itx/fetch-route-configured";
const TARGET = [
  "itx",
  "sandboxes",
  ["get", "/sandboxes/s"],
  "container",
  ["getTcpPort", 8080],
  "fetch",
];
// The payload that iterate.com's root holds at offset 139493, as main's sandbox ports wrote it.
const ROUTING_SLUG_ROUTE = {
  fetchRouteName: "sandbox-age-of-ai",
  requestMatcher: { routingSlug: "age-of-ai" },
  target: TARGET,
  authRequirement: null,
  priority: 0,
};
const REQUESTS = [
  "https://iterate.example.com/",
  "https://age-of-ai.iterate.example.com/",
  "https://dash.iterate.example.com/agents",
].map((url) => ({ url, headers: new Headers({ "x-iterate-routing-slug": "age-of-ai" }) }));

test.for([
  { name: "the earlier stack's { routingSlug }", requestMatcher: { routingSlug: "age-of-ai" } },
  { name: "an empty matcher", requestMatcher: {} },
  { name: "an empty url pattern", requestMatcher: { url: {} } },
  { name: "no header in headers", requestMatcher: { headers: {} } },
])("$name is refused at the write and leaves no route at the reduce", ({ requestMatcher }) => {
  const payload = { ...ROUTING_SLUG_ROUTE, requestMatcher };
  expect(FetchRouteConfiguredPayload.safeParse(payload)).toMatchObject({ success: false });
  const reduced = reduceCoreEventBatch(
    [
      {
        type: TYPE,
        payload,
        offset: 7,
        path: "/",
        createdAt: "2026-11-18T21:00:25.173Z",
        source: { origin: "/" },
      },
    ],
    CoreContract.initialState(),
    () => {},
  );
  expect(Object.keys(reduced.fetchRoutes)).toEqual([]);
  expect(reduceFetchRouteConfigured({}, { offset: 7, payload })).toBeUndefined();
});

test("a table entry with no condition that this kernel knows matches no request", () => {
  // as an older reduce kept it: its one field is unknown here, so it reads as no condition
  const table = {
    "sandbox-age-of-ai": {
      requestMatcher: { routingSlug: "age-of-ai" },
      target: TARGET,
      authRequirement: null,
      priority: 0,
      configuredOffset: 139493,
    },
  } as unknown as FetchRouteTable;
  for (const request of REQUESTS) expect(matchFetchRoute(table, request)).toBeNull();
});

test("the same route by its hostname takes that hostname alone", () => {
  const payload = {
    ...ROUTING_SLUG_ROUTE,
    requestMatcher: { url: { hostname: "age-of-ai.iterate.example.com" } },
  };
  const table = reduceFetchRouteConfigured({}, { offset: 8, payload })!;
  expect(REQUESTS.map((request) => matchFetchRoute(table, request)?.fetchRouteName)).toEqual([
    undefined,
    "sandbox-age-of-ai",
    undefined,
  ]);
});

test("a checkpoint that the earlier stack's reduce saved is not read: the log is reduced again", () => {
  const db = new DatabaseSync(":memory:");
  const born = open(db);
  born.appendWakeRecord({ cause: "call" });
  // what the earlier stack left: the event on the log, and its table in a checkpoint of 17.0.0
  const offset = born.highestDurableOffset() + 1;
  born.storage.insertEvent(
    offset,
    JSON.stringify({ type: TYPE, payload: ROUTING_SLUG_ROUTE, createdAt: "2026-11-18T21:00:25Z" }),
    null,
  );
  const oldTable = { "sandbox-age-of-ai": { ...ROUTING_SLUG_ROUTE, configuredOffset: offset } };
  db.prepare(
    "UPDATE reduce_checkpoints SET reducer_version = ?, reduced_through_offset = ?, state = ? WHERE slug = ?",
  ).run(
    "17.0.0",
    offset,
    JSON.stringify({ ...born.coreReducedState, fetchRoutes: oldTable }),
    CoreContract.slug,
  );
  const woken = open(db);
  expect({
    fetchRoutes: woken.coreReducedState.fetchRoutes,
    highestDurableOffset: woken.highestDurableOffset(),
  }).toEqual({ fetchRoutes: {}, highestDurableOffset: offset });
});

function open(db: DatabaseSync) {
  return new Stream({
    // The cast: the stream's own storage type is not exported, and this has its two members.
    storage: storageOf(db) as never,
    path: "/",
    onCommit: () => {},
  });
}

/** A context's storage over `db`: a read answers its rows, a write answers none. */
function storageOf(db: DatabaseSync) {
  return {
    sql: {
      exec(query: string, ...params: unknown[]) {
        const statement = db.prepare(query);
        const rows = /^\s*(select|with|pragma)/i.test(query)
          ? (statement.all(...(params as never[])) as Record<string, unknown>[])
          : (statement.run(...(params as never[])), []);
        return {
          toArray: () => rows,
          one: () => rows[0],
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const out = closure();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

// the kernel's reducer reads the host's roots when it resolves a row's target
defineItxHost({ firstPartyFacets: {} });
