// script-envelope.ts — THE LOG IS THE AGENT'S NOTEBOOK. A script the model writes runs fresh: no
// variable survives it. What survives is in the log already: the script (`itx/run-requested`) and
// what it returned (`itx/run-settled`). The offset of a result is its NUMBER, and the model reads
// the number at the head of every result. So a later script reads an earlier one from the log:
//
//   await result(45)      the value of result 45, whole, whatever its size (a failed script throws)
//   await script(45)      the source of the script that returned it
//   (no kept code)        a later script that needs a function writes it again: values survive
//                         by number, code does not
//
// IN A FORKED SUBAGENT (start.ts `contextCopiedEvents`) the numbers go on across the lineage. A
// number up to the first ancestor's `throughOffset` is that ancestor's result, at that offset of its
// log; the next ancestor's numbers come after it, and the subagent's own results are its offsets
// plus the sum of all of them. So a `[result N]` that the subagent copied from its parent reads the
// parent's value.
//
// EVERYTHING ELSE A SCRIPT DOES IS A FACT THAT IT APPENDS with `itx.append`, and the scope has no
// wrapper that hides one. Words to a person are a fact of their channel (`agent-ui/message-sent`,
// `slack/message-requested`); words to another agent are `agent/context-added` on its path; a
// subagent is `agent/subagent-requested`; a question on the side is `llm-request/requested` of
// purpose `side` (llm-request.ts). The prompt fragments show each append (fragments.ts). The scope
// holds only reads of the log, `result(n)` and `script(n)`, and `llmRequestOffset`: the offset of
// the request whose response the script is, which a side request names as its base.
//
// The envelope waits for every append before the run settles: on the script's `itx`, on
// `itx.cd(path)` and a `cd` of that. So an append the script does not await is not lost. (Measured on iterate.com's runner,
// 22 November 2026: an append not awaited was lost when the script returned at once or 300 ms later,
// and landed after 1 s.)
//
// This file is the envelope: the code that goes around the model's script (`scriptRunCode`) and the
// words the model reads of a settled run (`scriptRunOutcome`). processor.ts calls both and knows
// nothing more of how a script runs. To run scripts another way, change this file.
//
// THE LOG IS THE ONLY COPY OF A RESULT. No result is kept in the agent's state, copied into a later
// script or written to a file: every result of the agent's life can be read from the log, and a
// script's code carries none. There is no kept code either.

import type { RunSettlement } from "iterate/stream/run";

/** What the model is told about scripts, after the `<codemode>` rule (processor.ts). It says
 *  nothing of how words reach a person: a prompt fragment says that (fragments.ts). */
export const SCRIPT_GUIDE =
  "A script is the body of an async function with `itx` in scope. It runs fresh: no variable " +
  "survives it.\n" +
  "- Words reach someone only when a script appends them: your other instructions say how.\n" +
  "- Make your first line say what you do, for a person to see, with no await: " +
  '`itx.append({ type: "events.iterate.com/agent/summary-updated", payload: { activity: "<a few words>" } });`\n' +
  "- An append you do not await still lands before the script ends.\n" +
  "- Appends you do not await land in no order. When the order matters, as with two messages to a " +
  "person, send them in ONE append, in order: `itx.append(first, second)`.\n" +
  "- `return` a value to read it in your next turn. Return nothing to end your turn.\n" +
  "- To do several things at once, use `Promise.all` in the one script.\n" +
  "What survives a script is in your log, by number:\n" +
  "- Every result begins with its number: `[result 45]`. `await result(45)` gives a later script " +
  "that value, whole, whatever its size. Read it there and return only what you need: never fetch " +
  "or paste a value a second time.\n" +
  "- A result too long to show is shown as its shape; the whole value is still `await result(n)`.\n" +
  "- `await script(45)` is the source of the script that returned result 45.\n" +
  "- No code survives a script: write a function again in the script that needs it.\n" +
  "- Bytes, Blobs and Responses do not survive being returned: store bytes in a file and return " +
  "its path; read a Response with `.text()` or `.json()`.";

/** THE CODE THAT RUNS: what `itx/run-requested` carries. A pure function of the script, the
 *  agent's path and the request: the model's script is an async function, and around it are the
 *  notebook's functions and the serializer. The script's `itx` is the runner's, with one change:
 *  every `append` on it, or on a context it reaches by `cd`, is kept, and the run settles only when
 *  all of them have. */
export function scriptRunCode(run: {
  script: string;
  agentPath: string;
  /** The offset of the request whose response the script is. */
  llmRequestOffset: number;
  /** A forked subagent's ancestors, oldest first: where a result number below its own is. */
  lineage?: { path: string; throughOffset: number }[];
}): string {
  const { script, agentPath, llmRequestOffset, lineage = [] } = run;
  return [
    "async (__itx) => {",
    `  const __agentPath = ${js(agentPath)};`,
    `  const __lineage = ${js(lineage)};`,
    `  const llmRequestOffset = ${js(llmRequestOffset)};`,
    "  const __pending = [];",
    "  // every append is kept, on this context and on a context reached by `cd`",
    "  const __kept = (context) => new Proxy(context, { get(target, key) {",
    "    if (key === 'cd') return (...path) => __kept(target.cd(...path));",
    "    if (key !== 'append') return target[key];",
    "    return (...events) => { const sent = target.append(...events); __pending.push(sent); return sent; };",
    "  } });",
    "  const itx = __kept(__itx);",
    "  try {",
    "    return __json(await (async () => {",
    // the markers around the model's own code, so that `script(n)` and a page read it back out of
    // the envelope: a page that shows a script cuts it out by these markers
    "//#region your script",
    script,
    "//#endregion your script",
    "    })());",
    "  } finally {",
    "    await Promise.allSettled(__pending);",
    "  }",
    "  // ── the notebook (script-envelope.ts): earlier results and scripts by number ──",
    "  async function result(number) {",
    "    const at = __locate(number);",
    "    const settled = await __fact(at.path, at.offset, 'events.iterate.com/itx/run-settled', __noResult(number));",
    "    const { settlement } = settled.payload;",
    "    if (settlement.status === 'failed') throw new Error('the script of result ' + number + ' failed: ' + settlement.error);",
    "    return settlement.result;",
    "  }",
    "  async function script(number) {",
    "    const at = __locate(number);",
    "    const settled = await __fact(at.path, at.offset, 'events.iterate.com/itx/run-settled', __noResult(number));",
    "    const code = String((await __fact(at.path, settled.payload.requestOffset, 'events.iterate.com/itx/run-requested', __noResult(number))).payload.code);",
    "    const open = '//#region' + ' your script';",
    "    const start = code.indexOf(open);",
    "    const end = code.lastIndexOf('//#endregion' + ' your script');",
    "    return start === -1 || end === -1 ? code : code.slice(start + open.length, end).trim();",
    "  }",
    "  // where result `number` is: in an ancestor's log by the lineage, else in this agent's",
    "  function __locate(number) {",
    "    let base = 0;",
    "    for (const { path, throughOffset } of __lineage) {",
    "      if (number <= base + throughOffset) return { path, offset: number - base };",
    "      base += throughOffset;",
    "    }",
    "    return { path: __agentPath, offset: number - base };",
    "  }",
    "  function __noResult(number) {",
    "    return 'no script result has the number ' + number + ': the number is at the head of a result, as [result n]';",
    "  }",
    "  async function __fact(path, offset, type, missing) {",
    "    const page = Number.isInteger(offset) && offset > 0 ? await itx.cd(path).readEvents(offset - 1, 1) : { events: [] };",
    "    const fact = page.events[0];",
    "    if (!fact || fact.offset !== offset || fact.type !== type) throw new Error(missing);",
    "    return fact;",
    "  }",
    "  // what the log can hold of a returned value: JSON, with a note where a value is not JSON",
    "  function __json(value) {",
    "    if (value === undefined) return undefined;",
    "    const json = JSON.stringify(value, (key, v) => {",
    "      if (typeof v === 'bigint') return v.toString();",
    "      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return '[binary: ' + v.byteLength + ' bytes. Store it in a file and return the path]';",
    "      if (typeof Blob !== 'undefined' && v instanceof Blob) return '[Blob: ' + v.size + ' bytes' + (v.type ? ', ' + v.type : '') + '. Store its bytes in a file and return the path]';",
    "      if (typeof Response !== 'undefined' && v instanceof Response) return '[Response ' + v.status + '. Read it with await response.text() or .json() and return what you need]';",
    "      if (v instanceof Error || (v && typeof v === 'object' && typeof v.message === 'string' && (typeof v.stack === 'string' || typeof v.name === 'string')))",
    "        return { name: typeof v.name === 'string' ? v.name : 'Error', message: v.message };",
    "      return v;",
    "    });",
    "    return json === undefined ? undefined : JSON.parse(json);",
    "  }",
    "}",
  ].join("\n");
}

/** WHAT THE MODEL READS OF A SETTLED RUN. Pure: the same settlement gives the same words in every
 *  fold. Null when the script returned nothing, which asks for no further request. */
export function scriptRunOutcome(run: {
  settlement: RunSettlement;
  /** The result's number: the offset of the `itx/run-settled` fact, plus a forked subagent's base. */
  resultNumber: number;
  ranMs: number;
  /** Characters of a result that are shown whole. */
  historyLimit: number;
}): string | null {
  const { settlement, resultNumber: resultOffset, historyLimit } = run;
  // a script that ran for a second or more says so: the model learns which calls are slow
  const ran = run.ranMs >= 1_000 ? `, ${(run.ranMs / 1_000).toFixed(1)} s` : "";
  const head = `[result ${resultOffset}${ran}]`;
  if (settlement.status === "failed") {
    const error = cut(settlement.error || "unknown error", historyLimit);
    return `${head} The script failed (${settlement.failureKind}): ${error}\n${FAILED[settlement.failureKind]}`;
  }
  return resultText(head, resultOffset, settlement.result, historyLimit);
}

/** What a failure's kind means for what already ran (iterate/stream/run `RunSettled`): a script can
 *  have acted before it failed. */
const FAILED: Record<Extract<RunSettlement, { status: "failed" }>["failureKind"], string> = {
  runtime: "It threw: anything before the throw ran. Look at the state before you try again.",
  deadline:
    "It did not finish within its 10 minutes: it may have partly run, and it is not run again. Bound slow calls with Promise.race, and split long work.",
  interrupted:
    "The context restarted before it settled: it may have partly run, and it is not run again. Look at the state before you try again.",
};

/** A value as the model reads it. Up to `limit` characters it is shown whole: a string as itself,
 *  anything else as JSON. A longer one is shown as a notebook shows a large table: its shape and
 *  its start, and how to read the rest. */
function resultText(head: string, number: number, result: unknown, limit: number): string | null {
  if (result === undefined) return null;
  const whole = typeof result === "string" ? result : JSON.stringify(result);
  if (whole.length <= limit) return `${head}\n${whole}`;
  const rest = `A later script reads the whole value with \`await result(${number})\`: filter it there, and return only what you need.`;
  if (typeof result === "string") {
    const shown = Math.min(10_000, limit);
    return `${head} A text of ${whole.length} characters. Its first ${shown}:\n${whole.slice(0, shown)}\n${rest}`;
  }
  const shape = cut(JSON.stringify(shapeOf(result, 0), null, 1), Math.min(6_000, limit));
  return `${head} ${whole.length} characters of JSON, too long to show. Its shape, with the long parts cut:\n${shape}\n${rest}`;
}

/** The shape of a value: the first items of an array, the first keys of an object, the start of a
 *  string, and how much more there is of each. */
function shapeOf(value: unknown, depth: number): unknown {
  if (typeof value === "string")
    return value.length > 200 ? `${value.slice(0, 200)}… (${value.length} characters)` : value;
  if (Array.isArray(value)) {
    if (depth >= 5) return `[an array of ${value.length}]`;
    const shown = value.slice(0, 3).map((item) => shapeOf(item, depth + 1));
    return value.length > 3 ? [...shown, `… ${value.length - 3} more`] : shown;
  }
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  if (depth >= 5) return `{an object of ${keys.length} keys}`;
  const shown = keys.slice(0, 40).map((key) => [key, shapeOf(value[key], depth + 1)]);
  return Object.fromEntries(
    keys.length > 40 ? [...shown, ["…", `${keys.length - 40} more keys`]] : shown,
  );
}

const cut = (text: string, limit: number) =>
  text.length > limit
    ? `${text.slice(0, limit)}\n[cut here: ${text.length - limit} more characters]`
    : text;

/** A value as JavaScript source, safe on any line: JSON, with the two line separators that JSON
 *  leaves raw escaped too. */
const js = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && !!value && !Array.isArray(value);
