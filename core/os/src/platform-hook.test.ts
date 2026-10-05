// platform-hook.test.ts — the `events` row the platform hook builds from one durable event, its
// columns exactly those of internal-packages/telemetry/schemas/events.json, and how a batch of them
// is sent to a `TELEMETRY_EVENTS` binding that records each send.
import type { StreamEvent } from "iterate/stream/processor";
import { expect, test, vi } from "vitest";
import { eventsRow, sendEvents } from "./platform-hook.ts";

const source = { worker: "pr3142-a1b2c3d-os", projectId: "prj_1" };

test("a person's event: their actor id, never their email, and the cause it was written in", () => {
  const event = committed({
    source: {
      origin: "/agents/web/1",
      principal: { actor: "usr_1", email: "person@example.com" },
      cause: { chain: "2026-09-30T12:00:00.000Z with a call ~a1", depth: 1, parent: "/@41" },
    },
  });
  // exact: a row is the `events` table's columns, and none of them is an email
  expect(eventsRow(event, source)).toEqual({
    timestamp: "2026-09-30T12:00:00.000Z",
    worker: "pr3142-a1b2c3d-os",
    project_id: "prj_1",
    path: "/agents/web/1",
    offset: 42,
    type: "chat/message-added",
    actor: "usr_1",
    cause_chain: "2026-09-30T12:00:00.000Z with a call ~a1",
    cause_depth: 1,
    cause_parent: "/@41",
    payload: '{"text":"hello"}',
    payload_bytes: 16,
  });
});

test.for([
  {
    name: "the platform's own event with no payload: no actor, no cause, and {} as its payload",
    payload: undefined,
    row: { actor: null, cause_chain: null, cause_depth: null, cause_parent: null, payload: "{}" },
  },
  { name: "a payload of 0 is stored as itself, not as {}", payload: 0, row: { payload: "0" } },
  { name: "a payload of false is stored as itself", payload: false, row: { payload: "false" } },
  { name: 'a payload of "" is stored as itself', payload: "", row: { payload: '""' } },
  {
    name: "a payload over 96 KiB is cut by bytes, a split character to U+FFFD; payload_bytes stays whole",
    // 9 bytes of `{"text":"`, then two per é: the cut at 96 KiB leaves one byte of the 49,148th
    payload: { text: "é".repeat(100_000) },
    row: { payload: `{"text":"${"é".repeat(49_147)}�`, payload_bytes: 200_011 },
  },
])("$name", ({ payload, row }) => {
  expect(eventsRow(committed({ payload }), source)).toMatchObject(row);
});

// ── a batch: its rows in sends under 4 MB, in order; a failed send throws for the loop to retry ──

test.for([
  {
    name: "a batch that fits goes in one send",
    events: [1, 2, 3],
    sent: [[1, 2, 3]],
    logged: [],
  },
  {
    name: "a batch over 4 MB goes in sends under it, in order: twelve rows of 500 KB as eight and four",
    events: range(1, 12),
    kb: 500,
    sent: [range(1, 8), range(9, 12)],
    logged: [],
  },
  {
    name: "a row over 1 MB, which would fail its send every time, is dropped and counted; the rest go",
    events: [1, 2, 3],
    kb: { 2: 1100 },
    sent: [[1, 3]],
    logged: [{ level: "warn", event: "telemetry.events-dropped", projectId: "prj_1", count: 1 }],
  },
])("a batch: $name", async ({ events, kb, sent, logged }) => {
  expect(await runSend(events, kb)).toMatchObject({ sent, logged, error: undefined });
});

test("a send that fails throws, after the sends before it, so the loop delivers the batch again", async () => {
  const refused = new Error("Too many requests");
  expect(await runSend(range(1, 12), 500, refused)).toMatchObject({
    sent: [range(1, 8)],
    error: refused,
  });
});

/** A committed event: a message someone's code appended at offset 42, and no one's. Its payload may
 *  be any JSON value, as one off the wire may be whatever its type says: the one cast. */
function committed(overrides: Partial<Omit<StreamEvent, "payload">> & { payload?: unknown }) {
  return {
    type: "chat/message-added",
    offset: 42,
    createdAt: "2026-09-30T12:00:00.000Z",
    path: "/agents/web/1",
    payload: { text: "hello" },
    source: { origin: "/agents/web/1" },
    ...overrides,
  } as StreamEvent;
}

/** `sendEvents` of one event per offset, each with a type of `kb` KB (or of `kb[offset]` KB) since a
 *  payload is cut to 96 KiB, over a stream that records each send's offsets and refuses the
 *  second with `refuses`. Returns the sends, the console lines with their levels, and what it threw. */
async function runSend(
  offsets: number[],
  kb: number | Record<number, number> = 0,
  refuses?: Error,
) {
  const sent: number[][] = [];
  const logged: object[] = [];
  vi.spyOn(console, "warn").mockImplementation((line: object) =>
    logged.push({ level: "warn", ...line }),
  );
  const events = offsets.map((offset) => {
    const size = typeof kb === "number" ? kb : kb[offset] || 0;
    return committed({ offset, ...(size && { type: "t".repeat(size * 1000) }) });
  });
  const TELEMETRY_EVENTS = {
    async send(rows: { offset: number }[]) {
      if (refuses && sent.length === 1) throw refuses;
      sent.push(rows.map((row) => row.offset));
    },
  };
  const error = await sendEvents(
    { TELEMETRY_EVENTS, WORKER_NAME: source.worker },
    source.projectId,
    events,
  )
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  return { sent, logged, error };
}

/** `from` through `to`, inclusive. */
function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
