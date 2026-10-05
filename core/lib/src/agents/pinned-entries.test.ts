// pinned-entries.test.ts — PINNED CODE NEVER BRICKS AN AGENT (results-preamble.ts): setPreamble
// refuses code that does not load; before each run the loop quarantines an entry the envelope would
// not load with, and the run goes ahead without it; an entry that threw is quarantined when its run
// settles; entries never collide; and nothing is pinned past the ceiling. The loader here is V8
// itself (`new Function`, strict), answering as the Worker Loader does through itx: 200 "ok", or
// 500 with the module's error.
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "../stream/processor.ts";
import { AgentProcessor } from "./processor.ts";
import { answerText } from "./render.ts";
import {
  envelopeLoader,
  guardPreamble,
  PREAMBLE_CEILING_CHARS,
  pinnedEntryThrew,
  preambleEntryQuarantined,
  preambleEntrySet,
  preambleSection,
  wrapScript,
  type PreambleEntry,
} from "./results-preamble.ts";
import { standingFileSection, STANDING_FILE_MAX_CHARS } from "./standing-instructions.ts";

const PATH = "/agents/family-chief-of-staff";

/** A pinned PDF extractor: its `/Length` regex written in a template literal, where `\/` is `/`,
 *  `\s` is `s` and `\d` is `d`, so the regex turns into a line comment. */
const TEMPLATE_PIN = String.raw`await setPreamble({ key: "pdfText", code: ${"`"}async function pdfLength(s) { return Number(s.match(/\/Length\s+(\d+)/)[1]); }${"`"} });
return "pinned";`;
const BROKEN_PDF_TEXT =
  "async function pdfLength(s) { return Number(s.match(//Lengths+(d+)/)[1]); }";

test("setPreamble refuses the 2026-10-03 extractor: in a template literal it lost its backslashes and does not load, so nothing is pinned; the same function pinned as String(fn) loads and is pinned", async () => {
  const { itx, append } = sandbox();
  await expect(envelope(`async (itx) => {\n${TEMPLATE_PIN}\n}`)(itx)).rejects.toThrow(
    /^setPreamble: "pdfText" was not pinned: it does not load \(.+\)\. .*pin String\(fn\) instead\.$/,
  );
  expect(append).not.toHaveBeenCalled();
  const asString = String.raw`async function pdfLength(s) { return Number(s.match(/\/Length\s+(\d+)/)[1]); }
await setPreamble({ key: "pdfText", code: String(pdfLength) });
return "pinned";`;
  expect(await envelope(`async (itx) => {\n${asString}\n}`)(itx)).toBe("pinned");
  expect(append).toHaveBeenCalledWith({
    type: "events.iterate.com/agent/preamble-entry-set",
    payload: {
      key: "pdfText",
      code: String.raw`async function pdfLength(s) { return Number(s.match(/\/Length\s+(\d+)/)[1]); }`,
    },
  });
});

test("setPreamble refuses a top-level await or return, an unclosed bracket, an entry over 8,000 characters, pinned code over 16,000 in all and a key on two lines; removal is never checked", async () => {
  const { itx, append, loads } = sandbox();
  const pin = (code: string, preamble: PreambleEntry[] = [], key = "k") =>
    envelope(
      `async (itx) => setPreamble({ key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)} })`,
      preamble,
    )(itx);
  await expect(pin("const config = await itx.kv.get('x');")).rejects.toThrow("it does not load");
  await expect(pin("return 1;")).rejects.toThrow("it does not load");
  await expect(pin("function open() {")).rejects.toThrow("it does not load");
  await expect(pin(`const blob = "${"x".repeat(8_000)}";`)).rejects.toThrow(
    "an entry holds at most 8000",
  );
  const pinned = [
    { key: "a", code: `const a = "${"a".repeat(7_000)}";` },
    { key: "b", code: `const b = "${"b".repeat(7_000)}";` },
  ];
  await expect(pin(`const c = "${"c".repeat(3_000)}";`, pinned, "c")).rejects.toThrow(
    "it holds at most 16000",
  );
  // replacing an entry counts its new code, not its old
  expect(await pin(`const b = "${"b".repeat(7_500)}";`, pinned, "b")).toBeUndefined();
  await expect(pin("const k = 1;", [], "two\nlines")).rejects.toThrow("a key is one line");
  expect(append).toHaveBeenCalledTimes(1);
  loads.mockClear();
  expect(
    await envelope("async (itx) => setPreamble({ key: 'pdfText', code: null })", pinned)(itx),
  ).toBeUndefined();
  expect(loads).not.toHaveBeenCalled();
  expect(append).toHaveBeenLastCalledWith({
    type: "events.iterate.com/agent/preamble-entry-set",
    payload: { key: "pdfText", code: null },
  });
});

test("the envelope: each entry sees the ones before it and a later one may redeclare a name (once a load failure); an entry's throw names the entry, and a script's own throw never does", async () => {
  const preamble = [
    { key: "first", code: "const rate = 2;\nfunction double(n) { return n * rate; }" },
    { key: "second", code: "const rate = 3; // a new rate, shadowing the first entry's" },
  ];
  expect(
    loadModule(
      `const script =\n${wrapScript({ code: "async () => 1", agentPath: PATH, rows: [], preamble })}\n;`,
    ),
  ).toMatchObject({ status: 200 });
  expect(await envelope("async (itx) => [double(1), rate]", preamble)({})).toEqual([2, 3]);

  const throwing = [...preamble, { key: "table", code: 'const table = JSON.parse("{");' }];
  const failure = await envelope(
    "async (itx) => 1",
    throwing,
  )({}).catch((error: Error) => error.message);
  expect(failure).toMatch(/^pinned preamble entry "table" threw before your script ran: /);
  expect(
    pinnedEntryThrew(
      { status: "failed", error: String(failure), failureKind: "runtime" },
      throwing,
      9,
    ),
  ).toEqual({
    key: "table",
    code: 'const table = JSON.parse("{");',
    error: failure,
    requestOffset: 9,
  });

  const own = await envelope(
    "async (itx) => { throw new Error('mine') }",
    throwing.slice(0, 2),
  )({}).catch((error: Error) => error.message);
  expect(own).toBe("mine");
  expect(
    pinnedEntryThrew({ status: "failed", error: String(own), failureKind: "runtime" }, throwing, 9),
  ).toBeUndefined();
});

test("guardPreamble: one load when the entries load; the entry the envelope will not load with is quarantined with the loader's words and the rest kept; a loader that fails the bare envelope too, or throws, quarantines nothing", async () => {
  const good = [
    { key: "a", code: "const a = 1;" },
    { key: "b", code: "function b() { return a + 1; }" },
  ];
  const itx = loaderItx();
  expect(await guardPreamble(envelopeLoader(itx), PATH, good)).toEqual({
    keep: good,
    quarantined: [],
  });
  expect(itx.loads).toHaveBeenCalledTimes(1);

  const broken = { key: "pdfText", code: BROKEN_PDF_TEXT };
  const { keep, quarantined } = await guardPreamble(envelopeLoader(itx), PATH, [
    good[0]!,
    broken,
    good[1]!,
  ]);
  expect(keep).toEqual(good);
  expect(quarantined).toEqual([
    {
      key: "pdfText",
      code: BROKEN_PDF_TEXT,
      error: expect.stringMatching(
        /^the script envelope does not load with it: /,
      ) as unknown as string,
    },
  ]);

  const down = {
    workers: {
      get: () => ({
        fetch: async () => new Response("expression fetch error: UNAVAILABLE", { status: 500 }),
      }),
    },
  };
  expect(await guardPreamble(envelopeLoader(down), PATH, [broken])).toEqual({
    keep: [broken],
    quarantined: [],
  });
  const gone = {
    workers: {
      get: () => {
        throw new Error("NO_ITX_EXPRESSION_MATCH");
      },
    },
  };
  expect(await guardPreamble(envelopeLoader(gone), PATH, [broken])).toEqual({
    keep: [broken],
    quarantined: [],
  });
});

test("the reduce: an entry past the ceiling is not pinned but noted; setting or clearing a key ends its note; the section reads word for word as before until an entry is quarantined; a standing file past its limit is cut with a line saying so", () => {
  const empty = { preamble: [], preambleQuarantined: [] };
  const one = preambleEntrySet(empty, { key: "a", code: "const a = 1;" }, 5);
  expect(one).toEqual({ preamble: [{ key: "a", code: "const a = 1;" }], preambleQuarantined: [] });
  const huge = preambleEntrySet(
    one,
    { key: "gallery", code: "x".repeat(PREAMBLE_CEILING_CHARS) },
    6,
  );
  expect(huge).toMatchObject({
    preamble: one.preamble,
    preambleQuarantined: [
      {
        key: "gallery",
        offset: 6,
        error: expect.stringContaining("too large") as unknown as string,
      },
    ],
  });
  expect(preambleEntrySet(huge, { key: "gallery", code: null }, 7)).toMatchObject({
    preambleQuarantined: [],
  });

  expect(preambleSection(one.preamble, [])).toBe(
    "PINNED PREAMBLE — this code runs above every script you write, so its names are in scope (`setPreamble({ key, code: null })` removes an entry):\n\n// a\nconst a = 1;",
  );
  const out = preambleEntryQuarantined(one, { key: "a", error: "Unexpected token ';'" }, 8);
  expect(out).toMatchObject({ preamble: [] });
  expect(preambleSection(out.preamble, out.preambleQuarantined)).toBe(
    "PINNED ENTRIES THE LOOP REMOVED because they broke your scripts (each one's code stays in your log, in the event at its offset: `(await itx.cd(yourPath).readEvents(offset - 1, 1)).events[0].payload.code`). Fix one before pinning it again; setting or clearing its key ends its line here:\n- \"a\" @8: Unexpected token ';'",
  );
  expect(preambleEntrySet(out, { key: "a", code: "const a = 2;" }, 9)).toEqual({
    preamble: [{ key: "a", code: "const a = 2;" }],
    preambleQuarantined: [],
  });

  expect(standingFileSection("AGENTS.md", "short")).toBe(
    "AGENTS.md (/repos/config), as it is now:\n\nshort",
  );
  const long = standingFileSection("chief-of-staff.md", "y".repeat(STANDING_FILE_MAX_CHARS + 10));
  expect(long.length).toBeLessThan(STANDING_FILE_MAX_CHARS + 300);
  expect(long).toMatch(/\[chief-of-staff\.md is cut here: it is 100010 characters, .*\]$/);
});

test("The 2026-10-03 incident replayed: the extractor appended past setPreamble is quarantined before the next run, which goes ahead without it, and the script that removes it runs", async () => {
  const log = agentLog();
  await log.commit({
    type: "events.iterate.com/agent/preamble-entry-set",
    payload: { key: "helpers", code: "const two = 2;" },
  });
  await log.commit({
    type: "events.iterate.com/agent/preamble-entry-set",
    payload: { key: "pdfText", code: BROKEN_PDF_TEXT },
  });
  const answered = await log.answer("return two + 1;");
  const [quarantine, run] = log
    .after(answered.offset)
    .filter((event) =>
      [
        "events.iterate.com/agent/preamble-entry-quarantined",
        "events.iterate.com/itx/run-requested",
      ].includes(event.type),
    );
  expect(quarantine).toMatchObject({
    type: "events.iterate.com/agent/preamble-entry-quarantined",
    payload: {
      key: "pdfText",
      code: BROKEN_PDF_TEXT,
      error: expect.stringContaining("does not load"),
    },
  });
  expect(run!).toMatchObject({ type: "events.iterate.com/itx/run-requested" });
  const code = (run!.payload as { code: string }).code;
  expect(code).not.toContain("pdfLength");
  expect(loadModule(`const script =\n${code}\n;`)).toMatchObject({ status: 200 });
  // the run as the context would run it
  expect(await ((0, eval)(code) as (itx: unknown) => Promise<unknown>)({})).toBe(3);
  expect(log.state).toMatchObject({
    preamble: [{ key: "helpers", code: "const two = 2;" }],
    preambleQuarantined: [
      {
        key: "pdfText",
        offset: quarantine!.offset,
        error: expect.stringContaining("does not load"),
      },
    ],
  });
  // the loads: the composition, the bare envelope, then each entry in turn
  expect(log.itx.loads).toHaveBeenCalledTimes(4);

  // the next run, with the healthy entry left, costs one load and quarantines nothing
  log.itx.loads.mockClear();
  const removal = await log.answer("await setPreamble({ key: 'pdfText', code: null });");
  expect(log.after(removal.offset).map((event) => event.type)).toEqual([
    "events.iterate.com/agent/summary-updated",
    "events.iterate.com/itx/run-requested",
  ]);
  expect(log.itx.loads).toHaveBeenCalledTimes(1);
});

test("An entry that throws is quarantined when its run settles, and the note says the script never started; the next run has no such entry", async () => {
  const log = agentLog();
  await log.commit({
    type: "events.iterate.com/agent/preamble-entry-set",
    payload: { key: "table", code: 'const table = JSON.parse("{");' },
  });
  const answered = await log.answer("return table;");
  const run = log
    .after(answered.offset)
    .find((event) => event.type === "events.iterate.com/itx/run-requested")!;
  // the run as the context would run it
  const error = await (
    (0, eval)((run.payload as { code: string }).code) as (itx: unknown) => Promise<unknown>
  )({}).catch((thrown: Error) => thrown.message);
  const settled = await log.commit({
    type: "events.iterate.com/itx/run-settled",
    payload: {
      requestOffset: run.offset,
      settlement: { status: "failed", error, failureKind: "runtime" },
    },
  });
  const [quarantine, note] = log.after(settled.offset);
  expect(quarantine).toMatchObject({
    type: "events.iterate.com/agent/preamble-entry-quarantined",
    payload: {
      key: "table",
      requestOffset: run.offset,
      error: expect.stringMatching(/^pinned preamble entry "table" threw before your script ran: /),
    },
  });
  expect(note).toMatchObject({
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "developer",
      content: expect.stringContaining('The loop removed the pinned entry "table"'),
    },
  });
  expect(log.state).toMatchObject({ preamble: [] });
  const again = await log.answer("return 1;");
  const next = log
    .after(again.offset)
    .find((event) => event.type === "events.iterate.com/itx/run-requested")!;
  expect((next.payload as { code: string }).code).not.toContain('JSON.parse("{")');
});

/** A module as the Worker Loader answers for it: its `export default` lines aside, it must parse. */
function loadModule(module: string): Response {
  const body = module
    .split("\n")
    .filter((line) => !line.startsWith("export default "))
    .join("\n");
  try {
    // eslint-disable-next-line no-new-func -- parsing only: the loader's verdict on the module
    new Function(`"use strict";\n${body}`);
    return new Response("ok");
  } catch (error) {
    return new Response(`expression fetch error: ${(error as Error).message}`, { status: 500 });
  }
}

/** An itx whose `workers.get` loads with V8, counting the loads. */
function loaderItx() {
  const loads = vi.fn((spec: { source: Record<string, string> }) => ({
    fetch: async () => loadModule(spec.source["worker.js"]!),
  }));
  return { workers: { get: loads }, loads, [Symbol.dispose]: () => undefined };
}

/** An envelope as the context runs it: its text evaluated to the function it spells. */
function envelope(code: string, preamble: PreambleEntry[] = []) {
  // the envelope is source text, run here as the context runs it
  return (0, eval)(wrapScript({ code, agentPath: PATH, rows: [], preamble })) as (
    itx: unknown,
  ) => Promise<unknown>;
}

/** The sandbox a script runs in: the loader, and the agent's log it appends to. */
function sandbox() {
  const append = vi.fn(async () => ({}));
  const { workers, loads } = loaderItx();
  return { itx: { workers, cd: () => ({ append }) }, append, loads };
}

type Row = {
  type: string;
  payload?: Record<string, unknown>;
  source?: Record<string, unknown>;
  idempotencyKey?: string;
};

/** The engine of answer-owed.test.ts's `agentLog`, with the V8 loader as its itx. */
function agentLog() {
  const itx = loaderItx();
  const processor = new AgentProcessor({
    getItx: () => itx as never,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  const own = { origin: PATH, processor: { slug: "agent", version: processor.contract.version } };
  const events: StreamEvent[] = [];
  let state = processor.contract.initialState();
  const commit = async (row: Row): Promise<StreamEvent> => {
    const parsed = processor.contract.payloadSchemaFor(row.type)?.safeParse(row.payload || {});
    if (parsed && !parsed.success) throw parsed.error;
    const offset = events.length + 1;
    const event = {
      type: row.type,
      payload: parsed ? parsed.data : row.payload,
      offset,
      createdAt: new Date(Date.parse("2026-10-03T19:00:00Z") + offset * 100).toISOString(),
      path: PATH,
      source: { origin: PATH, ...row.source },
    } as StreamEvent;
    events.push(event);
    const previousState = state;
    state = (processor.reduce({ event, state } as never) as typeof state | undefined) ?? state;
    const emitted: Row[] = [];
    const blocked: Array<() => Promise<unknown>> = [];
    processor.processEvent({
      event,
      state,
      previousState,
      append: async (...rows: Row[]) => {
        emitted.push(...rows.map((emittedRow) => ({ ...emittedRow, source: own })));
        return [];
      },
      blockProcessorWhile: (work: () => Promise<unknown>) => blocked.push(work),
      runInBackground: () => undefined,
      delivery: { caughtUp: false },
    } as never);
    for (const work of blocked) await work();
    for (const emittedRow of emitted) await commit(emittedRow);
    return event;
  };
  /** The model's answer: a script, as the loop stores the `run` call it made. */
  const answer = (script: string) => {
    const call = { callId: `call_${String(events.length + 1)}`, status: "Working", script };
    return commit({
      type: "events.iterate.com/agent/context-added",
      payload: { role: "assistant", content: answerText("", call), llmRequestOffset: 1, call },
      source: own,
    });
  };
  return {
    events,
    commit,
    answer,
    after: (offset: number) => events.filter((event) => event.offset > offset),
    itx,
    get state() {
      return state;
    },
  };
}
