// agents/results-preamble.ts — THE SCRIPT ENVELOPE: what the loop sends as `itx/run-requested` around
// the model's script, JavaScript only, since nothing here typechecks: every script sees `results`,
// this agent's newest script outcomes, newest first — a small value inline as `results[i].data`, a
// large one read back from its file with `await results[i].load()`, a failure as `.error` — plus
// each row's `script()` (the source that produced it, read from the log, to edit and run again),
// `setPreamble` (code pinned above every later script), `setSummary` (the agent's own title, what
// it waits for, its description), `sendMessage` (words to the person while the script still runs; a
// voice call speaks them) and a serializer that keeps an Error's message and names binary data
// instead of dumping it. The rows are DERIVED from state for every run (`state.scriptResults`,
// reduced from this loop's own settlements), never stored as code: a result's settlement stays its
// only copy.
//
// PINNED CODE NEVER BRICKS AN AGENT. Pinned code rides every envelope, so one entry that does not
// load fails every later script, including the script that removes it. A template literal is the
// easy way to get there: it turns `/\/Length\s+(\d+)/` into `//Lengths+(d+)/`, a line comment
// that swallows the rest of a one-line function. So:
// - `setPreamble` checks an entry before pinning it: the size limits, then the code loaded on its
//   own in a throwaway worker, where the envelope puts it and as a class's static block (so no
//   top-level await or return, and every bracket closed). Removal is never checked.
// - each entry sits in a block of its own, so entries never collide (a later one may redeclare a
//   name, shadowing it), and a throw while an entry runs names that entry, not the script;
// - the loop checks the composed entries before every run of an agent that has any
//   (`guardPreamble`, one load of a module the Worker Loader keeps warm) and quarantines an entry
//   that would stop the envelope loading, so the script runs without it; an entry that threw is
//   quarantined when its run settles (`pinnedEntryThrew`). Either is the fact
//   `agent/preamble-entry-quarantined`, which keeps the code, and the PINNED PREAMBLE section names
//   it until its key is set again.
// - the reduce pins nothing past PREAMBLE_CEILING_CHARS, however the entry was appended.

import type { RunSettlement } from "../stream/run.ts";

/** How many outcomes `results` keeps; older ones stay in the conversation and the log. */
export const RETAINED_SCRIPT_RESULTS = 10;
/** Compact-JSON size up to which a result rides the envelope inline as `data`; a larger one is
 *  written to its file (processor.ts, before the note that names it) and read back by `load()`.
 *  Small, because every envelope carries every inline row: at most 10 × 4k per run request. */
const INLINE_RESULT_LIMIT = 4_000;
/** A retained error's text cap: errors are context, not payload. */
const RETAINED_ERROR_LIMIT = 2_000;

/** THE PINNED CODE'S LIMITS, which `setPreamble` holds an entry to. Pinned code rides every script's
 *  envelope and every request's head, so it is for helpers, which fit in a few thousand
 *  characters. Data belongs in itx.files or kv, read by a pinned function. */
const PREAMBLE_ENTRY_MAX_CHARS = 8_000;
const PREAMBLE_TOTAL_MAX_CHARS = 16_000;
const PREAMBLE_KEY_MAX_CHARS = 100;
/** THE CEILING no pinned code passes, however it was appended (setPreamble holds new entries far
 *  below it): the reduce pins no entry that would take the total past it, so the state stays well
 *  inside its 2 MB checkpoint cell, the envelope inside the log's 8 MiB event, and the head inside
 *  the model's window. */
export const PREAMBLE_CEILING_CHARS = 400_000;
/** How many quarantined entries the PINNED PREAMBLE section names, newest last. */
const QUARANTINED_KEPT = 5;

/** A pinned entry, and one the loop took out (`agent/preamble-entry-quarantined`). */
export type PreambleEntry = { key: string; code: string };
export type QuarantinedPreambleEntry = { key: string; error: string; offset: number };
/** What `agent/preamble-entry-quarantined` carries: the entry, and why it came out. */
export type PreambleQuarantine = {
  key: string;
  code: string;
  error: string;
  requestOffset?: number;
};
type PreambleState = { preamble: PreambleEntry[]; preambleQuarantined: QuarantinedPreambleEntry[] };

/** `agent/preamble-entry-set`, reduced: entries keep first-set order, setting a key again replaces
 *  its code in place, `null` removes it; either ends a quarantine note for that key. An entry that
 *  would take the pinned total past the ceiling is not pinned: it is noted as quarantined at its own
 *  offset, since the set event already keeps its code. */
export function preambleEntrySet(
  state: PreambleState,
  payload: { key: string; code: string | null },
  offset: number,
): PreambleState {
  const { key, code } = payload;
  const preambleQuarantined = state.preambleQuarantined.filter((entry) => entry.key !== key);
  const rest = state.preamble.filter((entry) => entry.key !== key);
  if (!code) return { preamble: rest, preambleQuarantined };
  const total = rest.reduce((sum, entry) => sum + entry.code.length, code.length);
  if (total > PREAMBLE_CEILING_CHARS)
    return {
      preamble: rest,
      preambleQuarantined: [
        ...preambleQuarantined,
        {
          key,
          offset,
          error: `too large: pinned code would come to ${String(total)} characters, past the ${String(PREAMBLE_CEILING_CHARS)} ceiling`,
        },
      ].slice(-QUARANTINED_KEPT),
    };
  const at = state.preamble.findIndex((entry) => entry.key === key);
  const preamble = [...state.preamble];
  if (at === -1) preamble.push({ key, code });
  else preamble[at] = { key, code };
  return { preamble, preambleQuarantined };
}

/** `agent/preamble-entry-quarantined`, reduced: the entry is removed, and noted for the section. */
export function preambleEntryQuarantined(
  state: PreambleState,
  payload: { key: string; error: string },
  offset: number,
): PreambleState {
  const { key, error } = payload;
  return {
    preamble: state.preamble.filter((entry) => entry.key !== key),
    preambleQuarantined: [
      ...state.preambleQuarantined.filter((entry) => entry.key !== key),
      { key, error: error.length <= 500 ? error : `${error.slice(0, 500)}…`, offset },
    ].slice(-QUARANTINED_KEPT),
  };
}

/** THE PINNED PREAMBLE section of the standing instructions: the pinned code (its wording must not
 *  change, or every agent's cached head would), then the entries the loop took out and why.
 *  Undefined when there is neither. */
export function preambleSection(
  preamble: readonly PreambleEntry[],
  quarantined: readonly QuarantinedPreambleEntry[],
): string | undefined {
  const parts: string[] = [];
  if (preamble.length > 0)
    parts.push(
      `PINNED PREAMBLE — this code runs above every script you write, so its names are in scope (\`setPreamble({ key, code: null })\` removes an entry):\n\n${preamble.map((entry) => `// ${entry.key}\n${entry.code}`).join("\n\n")}`,
    );
  if (quarantined.length > 0)
    parts.push(
      `PINNED ENTRIES THE LOOP REMOVED because they broke your scripts (each one's code stays in your log, in the event at its offset: \`(await itx.cd(yourPath).readEvents(offset - 1, 1)).events[0].payload.code\`). Fix one before pinning it again; setting or clearing its key ends its line here:\n${quarantined.map((entry) => `- ${JSON.stringify(entry.key)} @${String(entry.offset)}: ${entry.error}`).join("\n")}`,
    );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** A JSON value as JavaScript source, safe on any line: JSON, with the two line separators JSON
 *  leaves raw escaped too (a raw U+2028 would end a `//` comment, and a key is written in one). */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** One retained outcome — a row of `results`. `offset` is the settlement's, `requestOffset` the run
 *  request's (the id a result note names). */
export type ScriptResultRow = {
  offset: number;
  requestOffset: number;
  kind: "data" | "large" | "error" | "done";
  /** `data`: the result's compact JSON. */
  json?: string;
  /** `large`: the file holding the whole result (`itx.files`), and whether it is raw text. */
  path?: string;
  text?: boolean;
  /** `error`: the failure, capped. */
  error?: string;
};

/** Where a large result is written: one file per run, so a replay overwrites idempotently. */
function scriptResultPath(agentPath: string, requestOffset: number, text: boolean): string {
  return `${agentPath}/script-results/${String(requestOffset)}.${text ? "txt" : "json"}`;
}

/** The row a settlement becomes: pure, so a re-reduce agrees with what the note said. */
export function classifyScriptResult(input: {
  agentPath: string;
  requestOffset: number;
  offset: number;
  settlement: RunSettlement;
}): ScriptResultRow {
  const { agentPath, requestOffset, offset, settlement } = input;
  const base = { offset, requestOffset };
  if (settlement.status === "failed")
    return {
      ...base,
      kind: "error",
      error:
        settlement.error.length <= RETAINED_ERROR_LIMIT
          ? settlement.error
          : `${settlement.error.slice(0, RETAINED_ERROR_LIMIT)}…`,
    };
  if (settlement.result === undefined) return { ...base, kind: "done" };
  const json = JSON.stringify(settlement.result) ?? "null";
  if (json.length <= INLINE_RESULT_LIMIT) return { ...base, kind: "data", json };
  const text = typeof settlement.result === "string";
  return {
    ...base,
    kind: "large",
    path: scriptResultPath(agentPath, requestOffset, text),
    ...(text && { text: true }),
  };
}

/** The markers around the model's own code in an envelope, so `script()` reads it back out. The
 *  envelope's helpers spell them in two pieces, so their own text never contains a marker. */
const SCRIPT_START = "//#region your script";

/** How the envelope words a pinned entry's throw: `pinned preamble entry "<key>" threw before your
 *  script ran: <its message>` (`pinnedEntryThrew` reads it back). */
const PINNED_THREW = "pinned preamble entry";

/** setPreamble's check, in the envelope: the limits, then the code loaded on its own in a throwaway
 *  worker, once where the envelope puts it and once as a class's static block, which refuses what an
 *  entry must not do at its top level (await, return) and any bracket it leaves open. A context
 *  that cannot ask the loader lets the entry through: the loop's guard checks it before the next
 *  script runs. */
function pinCheck(preamble: readonly PreambleEntry[]): string[] {
  const sizes = jsLiteral(preamble.map((entry) => [entry.key, entry.code.length]));
  return String.raw`  async function __checkPinned(key, code) {
    const refuse = (why) => { throw new Error('setPreamble: ' + JSON.stringify(key) + ' was not pinned: ' + why); };
    if (key.length > ${String(PREAMBLE_KEY_MAX_CHARS)} || /[\u0000-\u001f\u2028\u2029]/.test(key)) refuse('a key is one line of at most ${String(PREAMBLE_KEY_MAX_CHARS)} characters');
    if (code.length > ${String(PREAMBLE_ENTRY_MAX_CHARS)}) refuse('it is ' + code.length + ' characters, and an entry holds at most ${String(PREAMBLE_ENTRY_MAX_CHARS)}: pinned code rides every script and every request. Keep data in itx.files or kv, and pin only the small function that reads it.');
    let total = code.length;
    for (const [other, chars] of ${sizes}) if (other !== key) total += chars;
    if (total > ${String(PREAMBLE_TOTAL_MAX_CHARS)}) refuse('pinned code would come to ' + total + ' characters in all, and it holds at most ${String(PREAMBLE_TOTAL_MAX_CHARS)}. Remove an entry first (setPreamble({ key, code: null })), or keep data in itx.files or kv.');
    if (code.includes('//#region' + ' your script') || code.includes('//#endregion' + ' your script')) refuse('it holds the envelope\'s own script markers');
    const source = {
      'package.json': '{"main":"worker.js"}',
      'worker.js': 'export default { fetch() { return new Response("ok"); } };\nconst __inEnvelope = async (itx) => { {\n' + code + '\n;} };\nfunction __onItsOwn() { class __Pinned { static {\n' + code + '\n} } }\n',
    };
    let response;
    try {
      response = await itx.workers.get({ source }).fetch(new Request('https://preamble.invalid/'));
    } catch {
      return;
    }
    if (response.status === 200) return;
    const error = (await response.text()).replace(/^expression fetch error: /, '').trim() || 'status ' + response.status;
    refuse('it does not load (' + error + '). Pinned code is declarations, constants and functions, that load on their own: no await or return at its top level, and every bracket closed. A template literal loses its backslashes (\\d becomes d, and /\\/x/ becomes //x, a comment): define the function in your script and pin String(fn) instead.');
  }`.split("\n");
}

/** The model's script, wrapped. Its code comes first (after `results` and any pinned entries, which
 *  must be in scope before it runs), so the Agents app's Script tab still reads as the script; the
 *  envelope's helpers are hoisted function declarations at the bottom. Each pinned entry opens a
 *  block of its own and the script runs in the innermost: an entry sees the ones before it, a later
 *  one may redeclare a name (it shadows it, never a "has already been declared"), and while an
 *  entry runs `__pinnedEntry` names it, so its throw is reported as its own (`pinnedEntryThrew`).
 *  Every line after an entry starts with `;` or `}`, so an entry's last statement never runs on
 *  into the envelope's. */
export function wrapScript(input: {
  code: string;
  agentPath: string;
  rows: ScriptResultRow[];
  preamble: readonly PreambleEntry[];
}): string {
  const { code, agentPath, rows, preamble } = input;
  const newestFirst = [...rows].reverse();
  const pinned = preamble.length > 0;
  return [
    "async (itx) => {",
    "  const results = __results(itx);",
    ...(pinned
      ? [
          "  let __pinnedEntry = null;",
          "  try {",
          ...preamble.flatMap((entry) => [
            `  // ── preamble entry ${jsLiteral(entry.key)} (setPreamble) ──`,
            `  ;__pinnedEntry = ${jsLiteral(entry.key)}; {`,
            entry.code,
          ]),
          "  ;__pinnedEntry = null;",
        ]
      : []),
    "  return __json(await (",
    SCRIPT_START,
    code,
    "//#endregion your script",
    "  )(itx));",
    ...(pinned
      ? [
          `  ${"}".repeat(preamble.length)}`,
          "  } catch (error) {",
          "    if (__pinnedEntry !== null) throw __pinnedThrew(__pinnedEntry, error);",
          "    throw error;",
          "  }",
          "  function __pinnedThrew(key, error) {",
          "    const message = error && typeof error.message === 'string' ? error.message : String(error);",
          `    return new Error('${PINNED_THREW} ' + JSON.stringify(key) + ' threw before your script ran: ' + message);`,
          "  }",
        ]
      : []),
    "  // ── the agent loop's envelope (results-preamble.ts): `results`, setSummary, sendMessage, setPreamble, the result's serialization ──",
    "  function __results(itx) {",
    "    const scriptOf = async (requestOffset) => {",
    `      const [event] = (await itx.cd(${JSON.stringify(agentPath)}).readEvents(requestOffset - 1, 1)).events;`,
    "      const code = (event && event.payload && event.payload.code) || '';",
    "      const open = '//#region' + ' your script';",
    "      const start = code.indexOf(open);",
    "      const end = code.lastIndexOf('//#endregion' + ' your script');",
    "      return start === -1 || end === -1 ? code : code.slice(start + open.length, end).trim();",
    "    };",
    "    const row = (index, fields, path, text) => Object.defineProperties(fields, {",
    "      load: { value: path",
    "        ? async () => { const s = new TextDecoder().decode(await itx.files.get(path).bytes()); return text ? s : JSON.parse(s); }",
    "        : async () => fields.data },",
    "      script: { value: () => scriptOf(fields.requestOffset) },",
    "      ...(path && { data: { get() { throw new Error('Large result: use `await results[' + index + '].load()` instead'); } } }),",
    "    });",
    "    const rows = [",
    ...newestFirst.map((entry, index) => `      ${renderRow(entry, index)},`),
    "    ];",
    "    return Object.assign(rows, {",
    "      byOffset(offset) {",
    "        const match = rows.find((r) => r.offset === offset || r.requestOffset === offset);",
    "        if (!match) throw new Error('no retained script result at offset ' + offset + ' (only the newest " +
      String(RETAINED_SCRIPT_RESULTS) +
      " are kept)');",
    "        return match;",
    "      },",
    "    });",
    "  }",
    "  async function setSummary(fields) {",
    "    const payload = {};",
    "    for (const key of ['title', 'description', 'activity']) if (typeof fields[key] === 'string' && fields[key]) payload[key] = fields[key];",
    "    if (fields.waitingFor !== undefined) payload.waitingFor = fields.waitingFor;",
    `    await itx.cd(${JSON.stringify(agentPath)}).append({ type: "events.iterate.com/agent/summary-updated", payload });`,
    "  }",
    "  async function sendMessage(message) {",
    "    if (typeof message !== 'string' || !message.trim()) throw new Error('sendMessage needs the words to send');",
    `    await itx.cd(${JSON.stringify(agentPath)}).append({ type: "events.iterate.com/agent/web-message-sent", payload: { message } });`,
    "  }",
    "  async function setPreamble({ key, code }) {",
    "    if (typeof key !== 'string' || !key) throw new Error('setPreamble needs a key');",
    "    if (code != null) await __checkPinned(key, String(code));",
    `    await itx.cd(${JSON.stringify(agentPath)}).append({ type: "events.iterate.com/agent/preamble-entry-set", payload: { key, code: code == null ? null : String(code) } });`,
    "  }",
    ...pinCheck(preamble),
    "  function __json(value) {",
    "    if (value === undefined) return undefined;",
    "    const json = JSON.stringify(value, (key, v) => {",
    "      if (typeof v === 'bigint') return v.toString();",
    "      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return '[binary: ' + v.byteLength + ' bytes — store it with itx.files.get(path).put({ contentType, data }) and return the path]';",
    "      if (typeof Blob !== 'undefined' && v instanceof Blob) return '[Blob: ' + v.size + ' bytes' + (v.type ? ', ' + v.type : '') + ' — store its bytes with itx.files and return the path]';",
    "      if (typeof Response !== 'undefined' && v instanceof Response) return '[Response ' + v.status + ' — read it with await response.text() or .json() and return what you need]';",
    "      if (v instanceof Error || (v && typeof v === 'object' && typeof v.message === 'string' && (typeof v.stack === 'string' || typeof v.name === 'string')))",
    "        return { name: typeof v.name === 'string' ? v.name : 'Error', message: v.message };",
    "      return v;",
    "    });",
    "    return json === undefined ? undefined : JSON.parse(json);",
    "  }",
    "}",
  ].join("\n");
}

function renderRow(entry: ScriptResultRow, index: number): string {
  const base = `offset: ${String(entry.offset)}, requestOffset: ${String(entry.requestOffset)}`;
  switch (entry.kind) {
    case "data":
      // JSON.parse of a string literal, never the JSON as code: a "__proto__" key stays a key
      return `row(${String(index)}, { ${base}, data: JSON.parse(${JSON.stringify(entry.json || "null")}) })`;
    case "large":
      return `row(${String(index)}, { ${base} }, ${JSON.stringify(entry.path)}, ${String(Boolean(entry.text))})`;
    case "error":
      return `row(${String(index)}, { ${base}, error: ${JSON.stringify(entry.error || "")} })`;
    case "done":
      return `row(${String(index)}, { ${base}, done: true })`;
  }
}

/** Whether an envelope LOADS as the context's runner will load it (core/os library.ts
 *  `runScriptModule` splices the script into `const script =\n…\n;` of worker.js; the loader lexes the
 *  module with es-module-lexer, then V8 parses it, both at the worker's first call): null when it
 *  does, else the loader's words. A module the loader has seen is warm, keyed by its text: measured
 *  live on 2026-10-03, 12 to 29 ms cold and 0 ms warm, and a broken one answers in 0 to 16 ms. */
export type LoadEnvelope = (code: string) => Promise<string | null>;

export function envelopeLoader(itx: {
  workers: { get(spec: { source: Record<string, string> }): unknown };
}): LoadEnvelope {
  return async (code) => {
    // `itx.workers.get` hands back an invoke handle, whose dotted `fetch` dispatches to the fetch
    // handler of the module below; the handle's type cannot name that member.
    const worker = itx.workers.get({
      source: {
        "package.json": '{"main":"worker.js"}',
        "worker.js": `const script =\n${code}\n;\nexport default { fetch() { return new Response("ok"); } };\n`,
      },
    }) as { fetch(request: Request): Promise<Response> };
    const response = await worker.fetch(new Request("https://preamble.invalid/"));
    if (response.status === 200) return null;
    const text = (await response.text()).replace(/^expression fetch error: /, "").trim();
    return text.slice(0, 500) || `status ${String(response.status)}`;
  };
}

/** How long one load may take before the guard gives up and the script runs as composed. */
const GUARD_LOAD_TIMEOUT_MS = 10_000;

/** THE GUARD before a script runs with pinned entries: which entries its envelope keeps, and which
 *  it quarantines because the envelope would not load with them. One load of the entries composed
 *  around an empty script (warm while they stay the same); only when that fails, the bare envelope
 *  (which must load, or the fault is not the entries') and then the entries one by one in pinned
 *  order, each kept if the ones kept so far still load with it. A loader that fails or stalls
 *  quarantines nothing: the script runs as composed, as before the guard. */
export async function guardPreamble(
  load: LoadEnvelope,
  agentPath: string,
  preamble: readonly PreambleEntry[],
): Promise<{ keep: PreambleEntry[]; quarantined: PreambleQuarantine[] }> {
  const all = { keep: [...preamble], quarantined: [] };
  if (preamble.length === 0) return all;
  const probe = async (entries: PreambleEntry[]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        load(wrapScript({ code: "async () => undefined", agentPath, rows: [], preamble: entries })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("the loader did not answer")),
            GUARD_LOAD_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    if ((await probe(all.keep)) === null) return all;
    if ((await probe([])) !== null) return all;
    const keep: PreambleEntry[] = [];
    const quarantined: PreambleQuarantine[] = [];
    for (const entry of preamble) {
      const error = await probe([...keep, entry]);
      if (!error) keep.push(entry);
      else
        quarantined.push({
          ...entry,
          error: `the script envelope does not load with it: ${error}`,
        });
    }
    return { keep, quarantined };
  } catch {
    return all;
  }
}

/** The entry a failed run names as having thrown before the script began (the envelope's words,
 *  `__pinnedThrew`), as its quarantine: undefined for any other failure, or an entry no longer pinned. */
export function pinnedEntryThrew(
  settlement: RunSettlement,
  preamble: readonly PreambleEntry[],
  requestOffset: number,
): PreambleQuarantine | undefined {
  if (settlement.status !== "failed") return undefined;
  const match = /^pinned preamble entry ("(?:[^"\\]|\\.)*") threw before your script ran: /.exec(
    settlement.error,
  );
  if (!match) return undefined;
  let key: unknown;
  try {
    key = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  const entry = preamble.find((candidate) => candidate.key === key);
  return entry && { ...entry, error: settlement.error.slice(0, 500), requestOffset };
}

/** A failed run's note when a pinned entry threw: the note, then what the loop did about it. */
export function pinnedEntryThrewNote(content: string, quarantine: PreambleQuarantine): string {
  return `${content}\nThe loop removed the pinned entry ${JSON.stringify(quarantine.key)} (agent/preamble-entry-quarantined keeps its code), so it cannot break another script. Your script itself never started: run it again, without that entry, and pin a fixed version only once it works.`;
}
