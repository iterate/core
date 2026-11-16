import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { defineItxHost } from "../host.ts";
import { Stream } from "./stream.ts";

test("a historical wait yields after one page so other root calls can run", async () => {
  const { stream, db } = fixture(1_201);
  const read = vi.spyOn(stream, "read");
  const pending = stream.waitForEvent({
    afterOffset: 0,
    type: "events.iterate.com/test/match",
    timeoutMs: 1_000,
  });
  const synchronousReads = read.mock.calls.length;
  stream.append({ type: "events.iterate.com/test/match", payload: { source: "live" } });
  expect(await pending).toMatchObject({ payload: { source: "live" } });
  expect(synchronousReads).toBe(1);
  db.close();
});

test("an older historical match wins over a match appended during the scan", async () => {
  const { stream, db } = fixture(501);
  const historical = stream.append({
    type: "events.iterate.com/test/match",
    payload: { source: "history" },
  })[0];
  const pending = stream.waitForEvent({ afterOffset: 0, type: historical.type });
  stream.append({ type: historical.type, payload: { source: "live" } });
  expect(await pending).toEqual(historical);
  db.close();
});

test("a live ephemeral match is not lost while history is being scanned", async () => {
  const { stream, db } = fixture(1_201);
  const pending = stream.waitForEvent({
    afterOffset: 0,
    type: "events.iterate.com/test/match",
  });
  const live = stream.append({
    type: "events.iterate.com/test/match",
    ephemeral: true,
    payload: {},
  })[0];
  expect(await pending).toEqual(live);
  db.close();
});

test("a live match survives the replay deadline and stops further reads", async () => {
  const { stream, db } = fixture(1_201);
  vi.useFakeTimers();
  try {
    const original = stream.read.bind(stream);
    const read = vi.spyOn(stream, "read").mockImplementation((...args) => {
      const page = original(...args);
      vi.setSystemTime(Date.now() + 60);
      return page;
    });
    const pending = stream.waitForEvent({
      afterOffset: 0,
      type: "events.iterate.com/test/match",
      timeoutMs: 100,
    });
    const live = stream.append({
      type: "events.iterate.com/test/match",
      ephemeral: true,
      payload: {},
    })[0];
    const resolved = expect(pending).resolves.toEqual(live);
    await vi.advanceTimersByTimeAsync(101);
    await resolved;
    expect(read.mock.calls.length).toBe(2);
  } finally {
    vi.useRealTimers();
    db.close();
  }
});

test("the wait deadline includes replay and stops further history reads", async () => {
  const { stream, db } = fixture(1_201);
  vi.useFakeTimers();
  try {
    const original = stream.read.bind(stream);
    const read = vi.spyOn(stream, "read").mockImplementation((...args) => {
      const page = original(...args);
      vi.setSystemTime(Date.now() + 60);
      return page;
    });
    const pending = stream.waitForEvent({
      afterOffset: 0,
      type: "events.iterate.com/test/absent",
      timeoutMs: 100,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    const reads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read.mock.calls.length).toBe(reads);
    expect(reads).toBeLessThan(3);
  } finally {
    vi.useRealTimers();
    db.close();
  }
});

test("an offset ahead of the head is respected after yielding", async () => {
  const { stream, db } = fixture(0);
  const pending = stream.waitForEvent({ afterOffset: 2, type: "events.iterate.com/test/match" });
  stream.append({ type: "events.iterate.com/test/match", payload: { n: 1 } });
  stream.append({ type: "events.iterate.com/test/match", payload: { n: 2 } });
  const expected = stream.append({ type: "events.iterate.com/test/match", payload: { n: 3 } })[0];
  expect(await pending).toEqual(expected);
  db.close();
});

test("an unreadable history row releases the live waiter and its timer", async () => {
  const { stream, db } = fixture(501);
  db.prepare("UPDATE events SET body = ? WHERE offset = ?").run("bad JSON", 501);
  await expect(
    stream.waitForEvent({ afterOffset: 0, type: "events.iterate.com/test/match" }),
  ).rejects.toMatchObject({ code: "EVENT_UNREADABLE" });
  const pending = stream.waitForEvent();
  const fresh = stream.append({ type: "events.iterate.com/test/match", payload: {} })[0];
  expect(await pending).toEqual(fresh);
  db.close();
});

function fixture(count: number) {
  const db = new DatabaseSync(":memory:");
  const stream = new Stream({ storage: storageOf(db) as never, path: "/", onCommit: () => {} });
  stream.append(
    ...Array.from({ length: count }, () => ({
      type: "events.iterate.com/test/noise",
      payload: { text: "x".repeat(4_096) },
    })),
  );
  return { stream, db };
}

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
        const answer = closure();
        db.exec("COMMIT");
        return answer;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

defineItxHost({ firstPartyFacets: {} });
