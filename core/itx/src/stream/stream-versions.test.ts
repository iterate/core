// A CONTEXT'S VERSIONS ON A REAL Stream, over an in-memory SQLite: the part of a Durable Object's
// storage that the stream uses (`sql.exec` and `transactionSync`), behind node:sqlite. One database
// is one context: a second Stream on it is the context's next incarnation.
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import type { StreamEventInput } from "iterate/stream/processor";
import { FacetHandle, RpcStubHandle } from "../context/dispatch.ts";
import { defineItxHost } from "../host.ts";
import { CoreContract, normalizeControlEvent } from "./core-processor.ts";
import { Stream } from "./stream.ts";
import { SubscriptionDelivery } from "./subscription-delivery.ts";

test("a new version empties the core state and keeps the log, every offset as it was", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  stream.append(...rowsOfAVersion());
  const before = stream.read(0, 500).events;

  const { ended, created } = stream.startNewVersion({ reason: "start over" }, undefined);

  expect(created).toMatchObject({
    offset: ended.offset + 1,
    type: "events.iterate.com/itx/created",
    payload: { path: "/x", version: 2 },
  });
  const { version, versionStartedAtOffset, subscriptions, itxExpressionRewriteRules, schedules } =
    stream.coreReducedState;
  expect({
    version,
    versionStartedAtOffset,
    subscriptions,
    itxExpressionRewriteRules,
    schedules,
  }).toEqual({
    version: 2,
    versionStartedAtOffset: ended.offset + 1,
    subscriptions: {},
    itxExpressionRewriteRules: {},
    schedules: {},
  });
  const all = stream.read(0, 500, { allVersions: true }).events;
  expect(all.slice(0, before.length)).toEqual(before);
  expect(all.slice(before.length).map(({ offset, type }) => ({ offset, type }))).toEqual([
    { offset: ended.offset, type: "events.iterate.com/itx/started-over" },
    { offset: ended.offset + 1, type: "events.iterate.com/itx/created" },
  ]);
});

test("`started-over` names the schedules, subscriptions and rules that the version held", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  stream.append(...rowsOfAVersion());

  const { ended } = stream.startNewVersion({ reason: "start over" }, undefined);

  expect(ended).toMatchObject({
    type: "events.iterate.com/itx/started-over",
    payload: {
      version: 1,
      reason: "start over",
      held: { schedules: ["tick"], subscriptions: ["platform"], rewriteRules: ["itx.greet"] },
    },
  });
});

test("after a new version the same stream refuses every append as UNAVAILABLE, so nothing lands after the `created`", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  const { ended } = stream.startNewVersion({}, undefined);

  for (const event of [
    { type: "events.iterate.com/test/said", payload: {} },
    { type: "events.iterate.com/test/said", payload: {}, ephemeral: true as const },
  ])
    expect(() => stream.append(event)).toThrow(
      expect.objectContaining({
        code: "UNAVAILABLE",
        data: expect.objectContaining({ kind: "deploy-reset" }),
      }) as Error,
    );
  expect({
    head: stream.highestAssignedOffset(),
    atVersionStart: open(db).atVersionStart(),
  }).toEqual({ head: ended.offset + 1, atVersionStart: true });
});

test("a version's first wake is its birth: `woken`, the host's birth events and each owed wake event, once", () => {
  const db = new DatabaseSync(":memory:");
  const birthEvent = { type: "events.iterate.com/test/born", payload: {} };
  const wakeEvent = { type: "events.iterate.com/test/hello", idempotencyKey: "hello", payload: {} };
  const { ended } = born(db, [wakeEvent], [birthEvent]).startNewVersion({}, undefined);

  const next = open(db, [wakeEvent], [birthEvent]);
  const before = next.atVersionStart();
  next.appendWakeRecord({ cause: "call" });
  const third = open(db, [wakeEvent], [birthEvent]);
  third.appendWakeRecord({ cause: "call" });

  expect({
    before,
    after: next.atVersionStart(),
    types: third.read(ended.offset, 500).events.map(({ type }) => type),
    wokenAfterContextAbortedOffset: next.coreReducedState.wokenAfterContextAbortedOffset,
  }).toEqual({
    before: true,
    after: false,
    types: [
      "events.iterate.com/itx/created",
      "events.iterate.com/itx/woken",
      birthEvent.type,
      wakeEvent.type,
      "events.iterate.com/itx/woken",
    ],
    // the new version is a deliberate reset, as `itx/aborted` is
    wokenAfterContextAbortedOffset: ended.offset + 1,
  });
});

test("a read from the start begins at the version; a read from a positive offset is taken as given", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  const [said] = stream.append({ type: "events.iterate.com/test/said", payload: { n: 1 } });
  const { ended } = stream.startNewVersion({}, undefined);
  const next = woken(db);

  expect({
    fromTheStart: next.read(0, 500).events.map(({ offset }) => offset),
    pointRead: next.read(said!.offset - 1, 1).events,
    readOn: next.read(said!.offset, 500).events.map(({ type }) => type),
  }).toEqual({
    fromTheStart: [ended.offset + 1, ended.offset + 2],
    pointRead: [said],
    readOn: [
      "events.iterate.com/itx/started-over",
      "events.iterate.com/itx/created",
      "events.iterate.com/itx/woken",
    ],
  });
});

test("a page says which version it is of and where that version starts, from the second version on", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  const first = stream.read(0, 1);
  const { created } = stream.startNewVersion({}, undefined);
  const next = woken(db);

  expect({
    first: { version: first.version, versionStartedAtOffset: first.versionStartedAtOffset },
    // a probe past the head holds no event, and says the same
    probe: next.read(Number.MAX_SAFE_INTEGER, 1),
  }).toEqual({
    first: { version: undefined, versionStartedAtOffset: undefined },
    probe: {
      events: [],
      atHead: true,
      scannedThroughOffset: next.highestDurableOffset(),
      version: 2,
      versionStartedAtOffset: created.offset,
    },
  });
});

test("an idempotency key counts within its version", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  const keyed = { type: "events.iterate.com/test/said", idempotencyKey: "k", payload: {} };
  const [first] = stream.append(keyed);
  stream.startNewVersion({}, undefined);
  const next = woken(db);
  const [second] = next.append(keyed);
  const [third] = next.append(keyed);

  expect({ second: second!.offset > first!.offset, third: third!.offset }).toEqual({
    second: true,
    third: second!.offset,
  });
});

test("no caller's key begins with the mark of a later version's keys, and a log that holds one takes no new version", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  const marked = `${String.fromCharCode(0x1f)}v2${String.fromCharCode(0x1f)}k`;
  expect(() =>
    stream.append({ type: "events.iterate.com/test/said", idempotencyKey: marked, payload: {} }),
  ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }) as Error);

  // a stored key under the mark, which no append of this stream wrote: an append with it is
  // the echo of that event, and the first new version refuses the log
  db.prepare("UPDATE events SET idempotency_key = ? WHERE offset = 1").run(marked);
  const held = open(db);
  const first = held.read(0, 1).events[0]!;
  expect(held.append({ type: first.type, idempotencyKey: marked, payload: first.payload })).toEqual(
    [first],
  );
  expect(() => open(db).startNewVersion({}, undefined)).toThrow(
    expect.objectContaining({ code: "INVALID_CONTEXT" }) as Error,
  );
});

test("a paused context takes a new version, and the new version is not paused", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  stream.append({ type: "events.iterate.com/itx/paused", payload: { reason: "stuck" } });

  stream.startNewVersion({ reason: "unstick" }, undefined);
  const next = woken(db);

  expect(next.coreReducedState).toMatchObject({ version: 2, paused: null });
  expect(next.append({ type: "events.iterate.com/test/said", payload: {} })).toHaveLength(1);
});

test("an open run is settled `interrupted` before the version ends", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  const [requested] = stream.append(
    normalizeControlEvent(
      { type: "events.iterate.com/itx/run-requested", payload: { code: "async () => 1" } },
      "/x",
    ),
  );

  const { ended } = stream.startNewVersion({}, undefined);

  const [settled] = stream.read(ended.offset - 2, 1).events;
  expect(settled).toMatchObject({
    offset: ended.offset - 1,
    type: "events.iterate.com/itx/run-settled",
    payload: { requestOffset: requested!.offset, settlement: { failureKind: "interrupted" } },
  });
  expect(Object.keys(stream.coreReducedState.scriptRuns)).toEqual([]);
});

test.for([
  {
    name: "a jail keeps its masks and loses every rule with a target: under the bare null each is a grant, at an own verb too",
    set: [
      { match: "itx", target: null },
      { match: "itx.cd", target: null },
    ],
    stay: ["itx", "itx.cd"],
  },
  {
    name: "with a mask and no jail: the mask and a rule at an own verb stay, the parent link and a grant go",
    set: [
      { match: "itx", target: "itx.cd('/')" },
      { match: "itx.cd", target: null },
    ],
    stay: ["itx.cd", "itx.run"],
  },
  {
    name: "with no mask: a rule at an own verb stays, the parent link and a grant go",
    set: [{ match: "itx", target: "itx.cd('/')" }],
    stay: ["itx.run"],
  },
])("$name", ({ set, stay }) => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  stream.append(
    ...[
      ...set,
      { match: "itx.run", target: "itx.cd('/jail').run" },
      { match: "itx.greet", target: "itx.builtins.whoami" },
    ].map((payload) =>
      normalizeControlEvent(
        { type: "events.iterate.com/itx/rewrite-rule-configured", payload },
        "/x",
      ),
    ),
  );
  const before = stream.coreReducedState.itxExpressionRewriteRules;

  stream.startNewVersion({}, undefined);

  // exactly these, with the rows they had: a subset match would let a grant through
  const { itxExpressionRewriteRules } = stream.coreReducedState;
  expect(itxExpressionRewriteRules).toEqual(
    Object.fromEntries(stay.map((match) => [match, before[match]])),
  );
});

test.each(["events.iterate.com/itx/started-over", "events.iterate.com/itx/version-ended"])(
  "nobody appends %s by hand: the border, under its name and its earlier name",
  (type) => {
    expect(() => normalizeControlEvent({ type, payload: { version: 1 } }, "/x")).toThrow(
      "is the platform's own record",
    );
  },
);

test("a log whose border has the earlier name, `itx/version-ended`, replays to its version, and the next version's offsets go on", () => {
  const db = new DatabaseSync(":memory:");
  const first = born(db);
  first.append(...rowsOfAVersion());
  // the border as the kernel wrote it before the rename
  const [earlierName, created] = first.append(
    { type: "events.iterate.com/itx/version-ended", payload: { version: 1, held: {} } },
    { type: "events.iterate.com/itx/created", payload: { path: "/x", version: 2 } },
  );
  const second = woken(db);
  const [said] = second.append({ type: "events.iterate.com/test/said", payload: {} });
  db.prepare("UPDATE reduce_checkpoints SET reducer_version = ? WHERE slug = ?").run(
    "18.0.0",
    CoreContract.slug,
  );

  const replayed = open(db);
  const { version, versionStartedAtOffset, subscriptions, schedules } = replayed.coreReducedState;
  expect({ version, versionStartedAtOffset, subscriptions, schedules }).toEqual({
    version: 2,
    versionStartedAtOffset: created!.offset,
    subscriptions: {},
    schedules: {},
  });
  expect(replayed.read(0, 500).events[0]).toMatchObject({ offset: created!.offset });

  const next = replayed.startNewVersion({}, undefined);
  expect(next.ended).toMatchObject({
    type: "events.iterate.com/itx/started-over",
    payload: { version: 2 },
  });
  expect(next.created).toMatchObject({ offset: next.ended.offset + 1, payload: { version: 3 } });
  // no offset starts again at a border, under either name
  const offsets = [earlierName, created, said, next.ended, next.created].map(
    (event) => event!.offset,
  );
  expect(offsets).toEqual([...new Set(offsets)].toSorted((a, b) => a - b));
});

test("the emptying is owed from the next incarnation until its marker is written, whatever wakes meanwhile", () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  const before = stream.owesEmptying();
  stream.startNewVersion({}, undefined);
  const next = open(db);
  const atRestart = next.owesEmptying();
  next.appendWakeRecord({ cause: "call" });
  const afterAWake = open(db).owesEmptying();
  next.storage.writeEmptiedVersion(2);

  expect({
    before,
    atRestart,
    afterAWake,
    marked: next.owesEmptying(),
    nextIncarnation: open(db).owesEmptying(),
  }).toEqual({
    before: false,
    atRestart: true,
    afterAWake: true,
    marked: false,
    nextIncarnation: false,
  });
});

test("a commit hook that throws after the batch landed still leaves the stream refusing appends", () => {
  const db = new DatabaseSync(":memory:");
  born(db);
  let throwOnce = true;
  const stream = new Stream({
    // The cast: the stream's own storage type is not exported, and this has its two members.
    storage: storageOf(db) as never,
    path: "/x",
    onCommit: () => {
      if (!throwOnce) return;
      throwOnce = false;
      throw new Error("a hook that fails after the commit");
    },
  });

  expect(() => stream.startNewVersion({}, undefined)).toThrow("a hook that fails after the commit");
  expect({
    version: stream.coreReducedState.version,
    versionEnded: stream.versionEnded(),
  }).toEqual({ version: 2, versionEnded: true });
  expect(() => stream.append({ type: "events.iterate.com/test/said", payload: {} })).toThrow(
    expect.objectContaining({ code: "UNAVAILABLE" }) as Error,
  );
});

test("a log with a mask, another rule and two new versions re-reduces from offset 0 to the state the incremental reduce held", () => {
  const db = new DatabaseSync(":memory:");
  const first = born(db);
  first.append(...jailRules(), ...rowsOfAVersion());
  first.startNewVersion({}, undefined);
  const second = woken(db);
  second.append(
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.greet", target: "itx.builtins.whoami" },
      },
      "/x",
    ),
  );
  second.startNewVersion({ reason: "again" }, undefined);
  const third = woken(db);
  db.prepare("UPDATE reduce_checkpoints SET reducer_version = ? WHERE slug = ?").run(
    "18.0.0",
    CoreContract.slug,
  );

  const reReduced = open(db).coreReducedState;
  expect(reReduced).toEqual(third.coreReducedState);
});

test("the version's live callbacks are the rows whose head is a client's lent callback, not a facet's row, a copy row or a built-in", async () => {
  const db = new DatabaseSync(":memory:");
  const stream = born(db);
  stream.append(
    ...rowsOfAVersion(),
    ...[
      { name: "dash", target: "itx.builtins.rpcStubs.get('subscription:dash')" },
      {
        name: "narrow",
        target: "itx.builtins.rpcStubs.get('subscription:narrow')",
        consumes: ["events.iterate.com/test/said"],
      },
      { name: "agent", target: "itx.builtins.facets.get('agent').processEventBatch" },
      { name: "copy", target: { path: "/y" } },
    ].map((payload) =>
      normalizeControlEvent(
        { type: "events.iterate.com/itx/subscription-configured", payload },
        "/x",
      ),
    ),
  );
  const pushed: unknown[] = [];
  const delivery = new SubscriptionDelivery({
    stream,
    evaluateItxExpression: async (expression) => {
      const spelled = JSON.stringify(expression);
      const value = spelled.includes("rpcStubs")
        ? new RpcStubHandle((steps) => pushed.push(steps))
        : spelled.includes("facets")
          ? new FacetHandle(() => {})
          : {};
      return { value, validUntil: Infinity, routedTo: spelled };
    },
    refuseHeldVerb: async () => {},
    pushEventBatchToFacet: async () => {},
    catchUpFacetFromLog: async () => {},
    reconcileAlarm: () => {},
    runAsDelivery: (_events, call) => call(),
    appendCopy: async () => {},
    abortIncarnation: () => {},
    metrics: () => {},
  });

  const callbacks = await delivery.liveCallbacks();
  const { ended, created } = stream.startNewVersion({}, undefined);
  const range = { after: ended.offset - 1, through: created.offset };
  for (const { call } of callbacks) await call([ended, created], range);

  expect({
    // the row that consumes every event takes the capstone; the row of one other type does not
    takes: callbacks.map(({ takes }) => [takes(ended), takes(created)]),
    pushed,
  }).toEqual({
    takes: [
      [true, true],
      [false, false],
    ],
    pushed: [[["", [ended, created], range]], [["", [ended, created], range]]],
  });
});

/** A jail's rules as the platform normalizes them: two masks, a rule at an own verb and a grant. */
function jailRules() {
  return [
    { match: "itx", target: null },
    { match: "itx.cd", target: null },
    { match: "itx.run", target: "itx.cd('/jail').run" },
    { match: "itx.greet", target: "itx.builtins.whoami" },
  ].map((payload) =>
    normalizeControlEvent(
      { type: "events.iterate.com/itx/rewrite-rule-configured", payload },
      "/x",
    ),
  );
}

/** A subscription, a rule and a schedule, as the platform normalizes them. */
function rowsOfAVersion() {
  return [
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: { name: "platform", target: "itx.builtins.platformHook.deliverEvents" },
    },
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.greet", target: "itx.builtins.whoami" },
    },
    {
      type: "events.iterate.com/itx/schedule-set",
      payload: {
        key: "tick",
        when: { everyMs: 60_000 },
        events: [{ type: "events.iterate.com/test/tick" }],
      },
    },
  ].map((event) => normalizeControlEvent(event, "/x"));
}

/** The context's next incarnation, woken. */
function woken(db: DatabaseSync) {
  const stream = open(db);
  stream.appendWakeRecord({ cause: "call" });
  return stream;
}

/** A context at `/x`, born and woken. */
function born(
  db: DatabaseSync,
  wakeEvents: StreamEventInput[] = [],
  birthEvents: StreamEventInput[] = [],
) {
  const stream = open(db, wakeEvents, birthEvents);
  stream.appendWakeRecord({ cause: "call" });
  return stream;
}

function open(
  db: DatabaseSync,
  wakeEvents: StreamEventInput[] = [],
  birthEvents: StreamEventInput[] = [],
) {
  return new Stream({
    // The cast: the stream's own storage type is not exported, and this has its two members.
    storage: storageOf(db) as never,
    path: "/x",
    birthEvents,
    wakeEvents: () => wakeEvents,
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
