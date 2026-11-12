// THE STREAM'S WAKE EVENTS ON A REAL Stream, over an in-memory SQLite: the part of a Durable
// Object's storage that the stream uses (`sql.exec` and `transactionSync`), behind node:sqlite.
// ./wake-events.test.ts holds the rule; this holds its wiring into a birth and a wake, and that a
// host's event can never fail a wake. One database is one context: a second Stream on it is the
// context's next incarnation.
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import type { StreamEventInput } from "iterate/stream/processor";
import { defineItxHost } from "../host.ts";
import { Stream } from "./stream.ts";

const ROW: StreamEventInput = {
  type: "events.iterate.com/itx/subscription-configured",
  idempotencyKey: "itx/platform-subscription",
  payload: { name: "platform", target: "itx.builtins.platformHook.deliverEvents", afterOffset: 0 },
};

test("born with the host naming nothing, then woken three times: the row lands once", () => {
  const db = new DatabaseSync(":memory:");
  wake(open(db, []));
  for (let times = 0; times < 3; times += 1) {
    const stream = open(db, [ROW]);
    wake(stream);
    expect(rowsOf(stream)).toEqual([4]);
  }
});

test("born with the host naming the row: it is on the log from the birth, once", () => {
  const db = new DatabaseSync(":memory:");
  const born = open(db, [ROW]);
  wake(born);
  expect(rowsOf(born)).toEqual([3]);
  const again = open(db, [ROW]);
  wake(again);
  expect(rowsOf(again)).toEqual([3]);
});

test("a row that its owner removed stays removed at the next wake", () => {
  const db = new DatabaseSync(":memory:");
  const born = open(db, [ROW]);
  wake(born);
  born.append({ type: ROW.type, payload: { name: "platform", target: null } });
  const again = open(db, [ROW]);
  wake(again);
  // the row, and its removal: no third
  expect(rowsOf(again)).toEqual([3, 4]);
});

test("a paused context that is owed the row still wakes, and gets the row at its first wake after the resume", () => {
  const db = new DatabaseSync(":memory:");
  const born = open(db, []);
  wake(born);
  born.append({
    type: "events.iterate.com/itx/paused",
    payload: { reason: "the owner paused it" },
  });
  const paused = open(db, [ROW]);
  expect(() => wake(paused)).not.toThrow();
  expect({ woke: paused.wakeRecorded(), rows: rowsOf(paused) }).toEqual({ woke: true, rows: [] });
  // its own resume lands: the context can be reached
  paused.append({ type: "events.iterate.com/itx/resumed", payload: {} });
  const resumed = open(db, [ROW]);
  wake(resumed);
  expect(rowsOf(resumed)).toHaveLength(1);
});

test.for([
  ["an event with no key", [{ ...ROW, idempotencyKey: undefined }]],
  ["an event of a type the stream does not take while paused", [{ ...ROW, pause: true }]],
] as const)("a wake whose host names %s is still a wake: the context is reached", ([, events]) => {
  const db = new DatabaseSync(":memory:");
  const born = open(db, []);
  wake(born);
  // paused after the rule was asked: the stream itself refuses the owed event
  const pauses = events.some((event) => "pause" in event);
  const woken = new Stream({
    storage: storageOf(db) as never,
    path: "/x",
    wakeEvents: () => {
      if (pauses)
        woken.append({ type: "events.iterate.com/itx/paused", payload: { reason: "meanwhile" } });
      return events.map(({ type, idempotencyKey, payload }) => ({ type, idempotencyKey, payload }));
    },
    onCommit: () => {},
  });
  expect(() => wake(woken)).not.toThrow();
  expect({ woke: woken.wakeRecorded(), rows: rowsOf(woken) }).toEqual({ woke: true, rows: [] });
});

test("a host whose list of wake events throws does not fail the wake", () => {
  const db = new DatabaseSync(":memory:");
  const woken = new Stream({
    storage: storageOf(db) as never,
    path: "/x",
    wakeEvents: () => {
      throw new Error("the host's list threw");
    },
    onCommit: () => {},
  });
  expect(() => wake(woken)).not.toThrow();
  expect(woken.wakeRecorded()).toBe(true);
});

/** A new incarnation of the context whose storage is `db`, with the wake events its host names. */
function open(db: DatabaseSync, wakeEvents: StreamEventInput[]) {
  return new Stream({
    // The cast: the stream's own storage type is not exported, and this has its two members.
    storage: storageOf(db) as never,
    path: "/x",
    wakeEvents: () => wakeEvents,
    onCommit: () => {},
  });
}

function wake(stream: Stream) {
  stream.appendWakeRecord({ cause: "call" });
}

/** The offsets of the events that configure or remove a subscription. */
function rowsOf(stream: Stream) {
  return stream
    .read(0, 500)
    .events.filter((event) => event.type === ROW.type)
    .map((event) => event.offset);
}

/** A context's storage over `db`: a read answers its rows, a write answers none. */
function storageOf(db: DatabaseSync) {
  return {
    sql: {
      exec(query: string, ...params: unknown[]) {
        const statement = db.prepare(query);
        // a read answers its rows; a write answers none
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
