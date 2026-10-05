// agents/result-render.ts — A SCRIPT'S SETTLEMENT AS THE MODEL READS IT NEXT. A result up to the
// history limit renders inline, with how long the script ran; a bigger one is written whole to its
// file in `itx.files` and renders as an inferred type plus an elided preview (or, for text, its
// first 10,000 characters) and the recipe to read it back through `results` — so the model filters
// it in its next script instead of re-fetching it, and the conversation never carries megabytes of
// JSON.
import type { RunSettlement } from "../stream/run.ts";
import { inferJsonType } from "./infer-json-type.ts";
import type { ScriptResultRow } from "./results-preamble.ts";
import { previewJson } from "./truncate-json.ts";

const OVERSIZED_JSON_PREVIEW_MAX_BYTES = 8_000;

/** A returned string renders as itself (JSON.stringify would escape every newline into one
 *  unreadable line); anything else as pretty-printed JSON. */
function stringifyScriptResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

/** Inline truncation at the history limit, with the advice the model sees past the cut. */
function truncateScriptResult(text: string, historyLimit: number): string {
  if (text.length <= historyLimit) return text;
  return `${text.slice(0, historyLimit)}\n… truncated (${String(text.length)} chars total; up to ${String(historyLimit)} render inline — return less: slice arrays, pick fields)`;
}

/** Human-scale script duration: "840ms", "1.8s", "2m 5s". */
export function formatScriptDuration(durationMs: number): string {
  if (durationMs < 1000) return `${String(Math.round(durationMs))}ms`;
  if (durationMs < 120_000) return `${String(Math.round(durationMs / 100) / 10)}s`;
  // whole seconds BEFORE splitting into minutes: rounding the leftover turns 179.7s into "2m 60s"
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds)}s`;
}

/** What a failure kind means for what already ran (iterate/stream/run `RunSettled`). */
const FAILURE_NOTES: Record<Extract<RunSettlement, { status: "failed" }>["failureKind"], string> = {
  runtime: "The script threw; anything before the throw ran — inspect state before retrying.",
  deadline:
    "It did not finish within its 10 minutes; it may have partly run, and it is not run again. Bound slow calls with Promise.race and split long work.",
  interrupted:
    "The context restarted before it settled; it may have partly run, and it is not run again. Inspect state before retrying.",
};

/** The note a settlement becomes, or null when the script returned nothing: that ends the turn.
 *  `row` is the settlement's `results` row (results-preamble.ts): the note names the member the
 *  next script's row really has. A `large` row's file is written here, before the note that names
 *  it; `write` failing falls back to inline truncation. */
export async function renderScriptSettlement(input: {
  settlement: RunSettlement;
  row: ScriptResultRow;
  durationMs?: number;
  historyLimit: number;
  write: (path: string, text: string) => Promise<void>;
}): Promise<string | null> {
  const { settlement, row, historyLimit } = input;
  const ranIn = input.durationMs === undefined ? "" : formatScriptDuration(input.durationMs);
  if (settlement.status === "failed")
    return [
      `Your script failed (${settlement.failureKind}${ranIn && `, after ${ranIn}`}):`,
      "```",
      truncateScriptResult(settlement.error || "unknown error", historyLimit),
      "```",
      FAILURE_NOTES[settlement.failureKind],
    ].join("\n");
  if (settlement.result === undefined) return null;
  const header = `Your script returned${ranIn && ` (in ${ranIn})`}:`;
  const text = stringifyScriptResult(settlement.result);
  const isRawText = typeof settlement.result === "string";
  const fence = isRawText ? "```" : "```json";
  const access = row.kind === "large" ? "load" : "data";
  const note =
    access === "data"
      ? "This result is available to your next script as `results[0].data` (the `results` array, newest first)."
      : "The full result is available to your next script via `await results[0].load()` (the `results` array, newest first).";
  let written = false;
  if (row.kind === "large" && row.path) {
    try {
      // the file holds the value itself: compact JSON, or the raw text
      await input.write(row.path, isRawText ? text : JSON.stringify(settlement.result));
      written = true;
    } catch (error) {
      console.error("[agent] failed to write an oversized script result", {
        error,
        path: row.path,
      });
    }
  }
  if (text.length <= historyLimit)
    return `${header}\n${fence}\n${text}\n\`\`\`\n${written || access === "data" ? note : LOST_NOTE}`;
  if (!written)
    return `${header}\n${fence}\n${truncateScriptResult(text, historyLimit)}\n\`\`\`\n${access === "data" ? note : LOST_NOTE}`;
  if (isRawText) {
    const shown = Math.min(10_000, historyLimit);
    return [
      header,
      "```",
      text.slice(0, shown),
      "```",
      `…truncated: showing the first ${shown.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} chars. The full text is available to your next script through \`results\` — don't re-fetch:`,
      "```js",
      "const text = await results[0].load(); // newest first — the full string",
      `return text.slice(${String(shown)}, ${String(shown * 4)}); // page/regex to return only what you need`,
      "```",
      `(The file is ${JSON.stringify(row.path)}.)`,
    ].join("\n");
  }
  let typeText: string | null = null;
  try {
    typeText = inferJsonType(settlement.result, {
      maxChars: Math.min(3_000, historyLimit),
    });
  } catch (error) {
    console.error("[agent] failed to infer the type of an oversized script result", { error });
  }
  let preview: string;
  try {
    preview = JSON.stringify(
      previewJson(settlement.result, {
        maxArrayItems: 3,
        maxBytes: Math.min(OVERSIZED_JSON_PREVIEW_MAX_BYTES, historyLimit),
        maxDepth: 5,
        maxStringChars: 500,
      }).value,
      null,
      2,
    );
  } catch (error) {
    console.error("[agent] failed to preview an oversized script result", { error });
    preview = `${text.slice(0, Math.min(OVERSIZED_JSON_PREVIEW_MAX_BYTES, historyLimit))}\n… (cut mid-document)`;
  }
  return [
    `Your script returned ${text.length.toLocaleString("en-US")} chars of JSON${ranIn && ` (in ${ranIn})`} — over the ~${historyLimit.toLocaleString("en-US")}-char inline limit.${typeText ? " Inferred type:" : ""}`,
    ...(typeText ? ["```ts", `type Result = ${typeText}`, "```"] : []),
    "Preview (long arrays/strings elided):",
    "```json",
    preview,
    "```",
    "The full result is available to your next script through `results` — don't re-fetch:",
    "```js",
    "const data = await results[0].load(); // newest first — the full result",
    "// filter/pick with plain JavaScript and return only what you need",
    "```",
    `(The file is ${JSON.stringify(row.path)}.)`,
  ].join("\n");
}

/** A large result whose file could not be written: `results[0].load()` would fail. */
const LOST_NOTE =
  "The full result could not be saved, so `results[0].load()` will fail for it: re-run the script returning less if you need more of it.";
