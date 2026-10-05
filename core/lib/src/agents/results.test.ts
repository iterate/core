// results.test.ts — the script envelope run for real (results-preamble.ts: `results`, `script()`,
// `setPreamble`, the serializer) against a fake `itx`, and the settlement notes the model reads
// next (result-render.ts): inline, written to a file with its shape and preview, lost, failed.

import { expect, test, vi } from "vitest";
import { renderScriptSettlement } from "./result-render.ts";
import { classifyScriptResult, wrapScript, type ScriptResultRow } from "./results-preamble.ts";

const agentPath = "/agents/a";
const big = {
  items: Array.from({ length: 400 }, (_, id) => ({ id, title: `item ${String(id)}` })),
};

const rows = [
  classifyScriptResult({
    agentPath,
    requestOffset: 3,
    offset: 4,
    settlement: { status: "succeeded", result: { users: ["amy", "bob"], __proto__x: 1 } },
  }),
  classifyScriptResult({
    agentPath,
    requestOffset: 5,
    offset: 6,
    settlement: { status: "succeeded", result: big },
  }),
  classifyScriptResult({
    agentPath,
    requestOffset: 7,
    offset: 8,
    settlement: { status: "failed", error: "TypeError: nope", failureKind: "runtime" },
  }),
  classifyScriptResult({
    agentPath,
    requestOffset: 9,
    offset: 10,
    settlement: { status: "succeeded" },
  }),
];

test("classifyScriptResult: small inline, large by its file, a failure's error, nothing returned is done", () => {
  expect(rows.map((row) => row.kind)).toEqual(["data", "large", "error", "done"]);
  expect(rows[1]!).toMatchObject({ path: "/agents/a/script-results/5.json" });
});

test("the envelope: `results` newest first — data inline, a large result loaded from its file (its data throws), errors, done; byOffset; script() reads the source back out of its envelope", async () => {
  const earlier = wrapScript({
    code: "async (itx) => {\nreturn 1\n}",
    agentPath,
    rows: [],
    preamble: [],
  });
  const { itx } = fakeItx(
    { "/agents/a/script-results/5.json": JSON.stringify(big) },
    { 3: earlier },
  );
  const run = envelope(
    `async (itx) => {
      let dataThrew = false;
      try { results[2].data } catch { dataThrew = true }
      return {
        done: results[0].done,
        error: results[1].error,
        loaded: (await results[2].load()).items.length,
        dataThrew,
        small: results[3].data.users,
        byOffset: results.byOffset(4).data.users[0],
        script: await results.byOffset(3).script(),
        rows: JSON.stringify(results),
      };
    }`,
    rows,
  );
  expect(await run(itx)).toEqual({
    done: true,
    error: "TypeError: nope",
    loaded: 400,
    dataThrew: true,
    small: ["amy", "bob"],
    byOffset: "amy",
    script: "async (itx) => {\nreturn 1\n}",
    // `load`, `script` and a large row's `data` are not enumerable: returning a row is safe
    rows: JSON.stringify([
      { offset: 10, requestOffset: 9, done: true },
      { offset: 8, requestOffset: 7, error: "TypeError: nope" },
      { offset: 6, requestOffset: 5 },
      { offset: 4, requestOffset: 3, data: { users: ["amy", "bob"], __proto__x: 1 } },
    ]),
  });
});

test("the envelope: pinned entries are in scope; setPreamble appends the entry; errors keep their message and bytes are named, not dumped; nothing returned stays nothing", async () => {
  const { itx, append } = fakeItx({}, {});
  const run = envelope(
    `async (itx) => {
      await setPreamble({ key: "k", code: "const two = 2" });
      return { sum: one + 1, error: new RangeError("too far"), bytes: new Uint8Array(3), big: 10n };
    }`,
    [],
    [{ key: "one", code: "const one = 1" }],
  );
  expect(await run(itx)).toEqual({
    sum: 2,
    error: { name: "RangeError", message: "too far" },
    bytes:
      "[binary: 3 bytes — store it with itx.files.get(path).put({ contentType, data }) and return the path]",
    big: "10",
  });
  expect(append).toHaveBeenCalledWith({
    type: "events.iterate.com/agent/preamble-entry-set",
    payload: { key: "k", code: "const two = 2" },
  });
  expect(await envelope("async (itx) => {\n}", [])(itx)).toBeUndefined();
});

test("the envelope: setSummary appends only the fields it is given, and sendMessage sends words while the script runs", async () => {
  const { itx, append } = fakeItx({}, {});
  await envelope(
    `async (itx) => {
      await setSummary({ title: "Weekly shop", waitingFor: null, bogus: 1 });
      await sendMessage("On it — checking the trolley now.");
    }`,
    [],
  )(itx);
  expect(append.mock).toMatchObject({
    calls: [
      [
        {
          type: "events.iterate.com/agent/summary-updated",
          payload: { title: "Weekly shop", waitingFor: null },
        },
      ],
      [
        {
          type: "events.iterate.com/agent/web-message-sent",
          payload: { message: "On it — checking the trolley now." },
        },
      ],
    ],
  });
  await expect(envelope("async (itx) => sendMessage('  ')", [])(itx)).rejects.toThrow(
    "sendMessage needs the words to send",
  );
});

test("renderScriptSettlement: a small result renders inline with its duration and the member its row has", async () => {
  const note = await renderScriptSettlement({
    settlement: { status: "succeeded", result: { n: 1 } },
    row: rows[0]!,
    durationMs: 1_234,
    historyLimit: 30_000,
    write: async () => undefined,
  });
  expect(note).toBe(
    'Your script returned (in 1.2s):\n```json\n{\n  "n": 1\n}\n```\nThis result is available to your next script as `results[0].data` (the `results` array, newest first).',
  );
});

test("renderScriptSettlement: a result over the limit is written whole to its file first, and renders as its type, a preview and the recipe", async () => {
  const write = vi.fn(async () => undefined);
  const note = await renderScriptSettlement({
    settlement: { status: "succeeded", result: big },
    row: rows[1]!,
    historyLimit: 1_000,
    write,
  });
  expect(write).toHaveBeenCalledWith("/agents/a/script-results/5.json", JSON.stringify(big));
  expect(note).toContain("chars of JSON — over the ~1,000-char inline limit. Inferred type:");
  expect(note).toContain("items: Array<{");
  expect(note).toContain("[truncated 397 items");
  expect(note).toContain("await results[0].load()");
});

test("renderScriptSettlement: a large result whose file could not be written says so; a failure says what may have run; nothing returned renders nothing", async () => {
  const lost = await renderScriptSettlement({
    settlement: { status: "succeeded", result: big },
    row: rows[1]!,
    historyLimit: 1_000,
    write: async () => {
      throw new Error("r2 down");
    },
  });
  expect(lost).toContain("… truncated (");
  expect(lost).toContain("could not be saved");
  expect(
    await renderScriptSettlement({
      settlement: { status: "failed", error: "boom", failureKind: "deadline" },
      row: rows[2]!,
      durationMs: 600_000,
      historyLimit: 30_000,
      write: async () => undefined,
    }),
  ).toBe(
    "Your script failed (deadline, after 10m):\n```\nboom\n```\nIt did not finish within its 10 minutes; it may have partly run, and it is not run again. Bound slow calls with Promise.race and split long work.",
  );
  expect(
    await renderScriptSettlement({
      settlement: { status: "succeeded" },
      row: rows[3]!,
      historyLimit: 30_000,
      write: async () => undefined,
    }),
  ).toBeNull();
});

/** An envelope as the context would run it: its text evaluated to the function it spells. */
function envelope(
  code: string,
  rows: ScriptResultRow[],
  preamble: { key: string; code: string }[] = [],
) {
  // the envelope is source text, run here as the context runs it
  return (0, eval)(wrapScript({ code, agentPath, rows, preamble })) as (
    itx: unknown,
  ) => Promise<unknown>;
}

function fakeItx(files: Record<string, string>, log: Record<number, string>) {
  const append = vi.fn(async () => ({}));
  const itx = {
    append,
    cd: (path: string) => {
      expect(path).toBe(agentPath);
      return {
        append,
        readEvents: async (afterOffset: number) => ({
          events: log[afterOffset + 1] ? [{ payload: { code: log[afterOffset + 1] } }] : [],
        }),
      };
    },
    files: {
      get: (path: string) => ({ bytes: async () => new TextEncoder().encode(files[path]) }),
    },
  };
  return { itx, append };
}
