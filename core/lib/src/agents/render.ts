// render.ts — THE REQUEST AS OPENAI READS IT, built so every request's input is the
// previous request's input plus what happened since: the provider's prompt cache then holds the whole
// conversation, and a turn pays full price only for its new items. Pure: the processor
// (processor.ts) and the replay experiment build inputs with the same functions.
//
// Modelled on Pi 1.0 and Pi Durable (github.com/earendil-works/pi, packages/ai's openai-responses
// and packages/durable's positional system entries):
//
// - ONE TOOL, `run({ status, script })`. A script step is a `function_call` and its result a
//   `function_call_output`. OpenAI places an implicit cache breakpoint after a user message or a
//   tool output, never after a system or developer message, so a script result sent as a system
//   message would freeze the cache for a whole script chain. As a tool output, each step's result
//   is a breakpoint, and the next step reads everything before it from cache.
// - THE STANDING INSTRUCTIONS ARE POSITIONAL. The system prompt, AGENTS.md, the role files, the
//   pinned preamble, the capability tree and the agent's identity are SECTIONS: snapshotted once at
//   the head of the conversation, and when one changes, the change is appended where it happened
//   (a diff against the version above), never rewritten in front of the history (Pi Durable's
//   `pi.system` entries: "Only what changed is sent again, which keeps provider prompt caches warm").
// - NOTHING IN THE PREFIX MOVES. The capability tree is sorted and stripped of what changes on every
//   publication (the config commit and publication number); the agent's own path sits in the last
//   section, after an explicit breakpoint, so agents that share instructions (calls with one person)
//   can share their cached head.
// - THE MODEL'S OWN OUTPUT IS REPLAYED EXACTLY: the response's items (encrypted reasoning, message,
//   function call, with their ids) are stored and sent back as they came (Pi's thinkingSignature
//   replay), so a multi-step answer keeps its reasoning and its prefix. An answer written by another
//   model, or stored as a `<codemode>` block in its text, is converted to plain items without ids.
import { z } from "zod";
import type { RewriteRuleListEntry } from "../api.ts";
import type { FileAttachment } from "./contract.ts";
import { parseCodemodeResponse } from "./codemode-format.ts";

/** The one tool. Strict, so its arguments always parse; the description is the whole contract,
 *  the system prompt says how to use it. */
export const RUN_TOOL = {
  type: "function",
  name: "run",
  description:
    "Run ONE JavaScript script against `itx` (this context's capability tree). Write statements: top-level `await` and `return` are allowed, no TypeScript. Whatever the script returns (JSON-serializable) comes back to you as this call's result; a thrown error comes back the same way. One call per response.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          'A short present-tense label for what the script does, shown while it runs ("Checking your calendar"). A person may see or hear it: write it for them.',
      },
      script: {
        type: "string",
        description: "The JavaScript statements to run.",
      },
    },
    required: ["status", "script"],
    additionalProperties: false,
  },
  strict: true,
} as const;

/** A conversation item as the reduce keeps it (contract.ts `contextItems`). */
export type RenderItem = {
  offset: number;
  role: "system" | "developer" | "user" | "assistant";
  content: string;
  actor?: { type: "user" } | { type: "script"; requestOffset: number } | { type: "agent" };
  llmRequestOffset?: number;
  files?: FileAttachment[];
  from?: string;
  compaction?: { replacesHistoryThrough: number };
  /** The `run` call this answer made (processor.ts, from the response's function_call). */
  call?: { callId: string; status: string; script: string };
  /** The response's output items, verbatim, for exact replay, and the model that wrote them. */
  providerItems?: unknown[];
  providerModel?: string;
  /** A standing-instructions item: the sections it sets (null: removed). `snapshot` marks the
   *  conversation's head copy (the first, or the one a compaction consolidated). */
  sections?: Record<string, string | null>;
  snapshot?: boolean;
  /** The request stamp ("Requested at: …") at a request's own offset. */
  stamp?: boolean;
};

/** One input item of the Responses API, as this loop writes them. */
export type InputItem = Record<string, unknown>;

/** One output item of a response: its type, and every other field kept, since the item is replayed
 *  verbatim. */
export const OutputItem = z.looseObject({ type: z.string() });
export type OutputItem = z.infer<typeof OutputItem>;

/** A message item's text parts. */
const MessageItemContent = z.looseObject({
  content: z
    .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
    .optional()
    .catch(undefined),
});

/** The text of a message output item: its `output_text` parts, joined. */
export function messageText(item: OutputItem): string {
  return (MessageItemContent.parse(item).content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("");
}

/** The sections that are this agent's own (its tree, its pinned code, its path). They come last in
 *  the head, after the explicit cache breakpoint: everything before it is the same for agents with
 *  the same instructions (two calls with one person), so they can share its cache. */
const OWN_SECTIONS = new Set(["capability-tree", "preamble", "identity"]);

// ── the capability tree, stable ──

/** What changes in a row's description without the capability changing: the config commit and
 *  the publication number (`/repos/config at 72de7b20aae9, publication 5326`). */
const VOLATILE_DESCRIPTION = /\s+at [0-9a-f]{7,40}(?:, publication \d+)?|,?\s*publication \d+/g;

/** The agent's table as the model reads it, in an order and wording that only change when a
 *  capability does: contexts and rows sorted, volatile text stripped. Null when nothing is
 *  spellable. */
export function stableCapabilityTree(rows: RewriteRuleListEntry[]): string | null {
  const visible = rows.filter((row) => row.target && row.match !== "itx");
  if (visible.length === 0) return null;
  const contexts = [...new Set(visible.map((row) => row.context))].sort();
  const body = contexts.flatMap((context) => [
    `from ${context}:`,
    ...visible
      .filter((row) => row.context === context)
      .map((row) => {
        const description = (row.description || "").replace(VOLATILE_DESCRIPTION, "").trim();
        return `${row.match} — ${description || `⇒ ${JSON.stringify(row.target)}`}`;
      })
      .sort(),
  ]);
  return [
    "`itx` IS THIS CONTEXT'S CAPABILITY TREE (`await itx.rewriteRules.list()`) — every name below is one your scripts can spell; nothing else resolves. When it changes, the change appears later in this conversation:",
    ...body,
  ].join("\n");
}

// ── sections and their updates ──

/** A line diff (longest common subsequence), as [op, line] pairs: " " kept, "-" removed, "+" added. */
function lineDiff(before: string, after: string): Array<[" " | "-" | "+", string]> {
  const a = before.split("\n");
  const b = after.split("\n");
  // trim the common head and tail first: an append or a one-line edit is then a tiny table
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const n = x.length;
  const m = y.length;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * (m + 1) + j] =
        x[i] === y[j]
          ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
  const middle: Array<[" " | "-" | "+", string]> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      middle.push([" ", x[i]!]);
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i * (m + 1) + j + 1]! >= lcs[(i + 1) * (m + 1) + j]!)) {
      middle.push(["+", y[j]!]);
      j++;
    } else {
      middle.push(["-", x[i]!]);
      i++;
    }
  }
  return [
    ...a.slice(0, head).map((line): [" ", string] => [" ", line]),
    ...middle,
    ...a.slice(a.length - tail).map((line): [" ", string] => [" ", line]),
  ];
}

/** The diff as a reader needs it: changed lines with two lines of context, unchanged runs elided. */
function compactDiff(before: string, after: string, context = 2): string {
  const ops = lineDiff(before, after);
  const keep = ops.map((_, index) =>
    ops.slice(Math.max(0, index - context), index + context + 1).some(([op]) => op !== " "),
  );
  const out: string[] = [];
  let skipped = 0;
  ops.forEach(([op, line], index) => {
    if (!keep[index]) {
      skipped++;
      return;
    }
    if (skipped > 0) out.push(`… (${String(skipped)} unchanged lines)`);
    skipped = 0;
    out.push(`${op === " " ? " " : op}${line}`);
  });
  if (skipped > 0) out.push(`… (${String(skipped)} unchanged lines)`);
  return out.join("\n");
}

/** How a changed section reads at the point it changed: what was removed, added or rewritten. A
 *  small change is a diff against the version above it in the conversation; a large one is the new
 *  text in full. */
export function renderSectionUpdate(
  name: string,
  previous: string | undefined,
  next: string | null,
): string {
  if (!next) return `[standing instructions] "${name}" no longer applies.`;
  if (!previous) return `[standing instructions] new section "${name}":\n\n${next}`;
  const diff = compactDiff(previous, next);
  if (diff.length < next.length / 2)
    return `[standing instructions] "${name}" changed. The diff against the version above (lines starting "-" are gone, "+" are new; the rest is unchanged and still applies):\n\`\`\`diff\n${diff}\n\`\`\``;
  return `[standing instructions] "${name}" was rewritten. It now reads:\n\n${next}`;
}

/** The sections that differ between what the model has been shown and what is current, as one
 *  update: null when nothing changed. Order: as `current` lists them; a removed section last. */
export function sectionChanges(
  shown: Record<string, string>,
  current: Record<string, string>,
): { sections: Record<string, string | null>; content: string } | null {
  const sections: Record<string, string | null> = {};
  const parts: string[] = [];
  for (const [name, text] of Object.entries(current)) {
    if (shown[name] === text) continue;
    sections[name] = text;
    parts.push(renderSectionUpdate(name, shown[name], text));
  }
  for (const name of Object.keys(shown)) {
    if (name in current) continue;
    sections[name] = null;
    parts.push(renderSectionUpdate(name, shown[name], null));
  }
  return parts.length === 0 ? null : { sections, content: parts.join("\n\n") };
}

// ── the conversation ──

/** Words from another agent: who, and how to answer. */
function fromLine(from: string): string {
  return `[from ${from} — it cannot see this conversation; answer by appending to its log: \`await itx.cd(${JSON.stringify(from)}).append({ type: "events.iterate.com/agent/context-added", payload: { role: "user", content } })\`]`;
}

/** How a non-image (or gone) attachment is named to the model. */
function fileHintLine(file: FileAttachment): string {
  return `[Attached file: ${file.filename} (${file.contentType}, ${String(file.size)} bytes) — read it with \`await itx.files.get(${JSON.stringify(file.path)}).bytes()\`]`;
}

/** The arguments of a `run` call, as the model wrote them. */
function runArguments(status: string, script: string): string {
  return JSON.stringify({ status, script });
}

/** A `<codemode>` answer of the previous loop, or one this loop rendered for the event log, as items. */
function legacyAnswerItems(item: RenderItem): {
  items: InputItem[];
  callId?: string;
} {
  const outcome = parseCodemodeResponse(item.content);
  if (outcome.kind === "script") {
    const wrapped = outcome.code.startsWith("async (itx) => {\n") && outcome.code.endsWith("\n}");
    const body = wrapped ? outcome.code.slice("async (itx) => {\n".length, -2) : outcome.code;
    const callId = `call_${String(item.offset)}`;
    return {
      callId,
      items: [
        ...(outcome.prose ? [{ role: "assistant", content: outcome.prose }] : []),
        {
          type: "function_call",
          call_id: callId,
          name: RUN_TOOL.name,
          arguments: runArguments(outcome.status || "", body),
        },
      ],
    };
  }
  return { items: item.content.trim() ? [{ role: "assistant", content: item.content }] : [] };
}

/** An answer of this loop: replayed verbatim when the same model wrote it (reasoning included),
 *  else rebuilt from its call and prose without ids. */
function answerItems(
  item: RenderItem,
  model: string,
  replayReasoning: boolean,
): { items: InputItem[]; callIds: string[] } {
  if (!item.call && !item.providerItems) {
    const legacy = legacyAnswerItems(item);
    return { items: legacy.items, callIds: legacy.callId ? [legacy.callId] : [] };
  }
  // The response's own output items, as the provider sent them.
  const provider = (item.providerItems || []).flatMap((raw) => {
    const parsed = OutputItem.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const exact = replayReasoning && item.providerModel === model && provider.length > 0;
  const items: InputItem[] = [];
  const callIds: string[] = [];
  for (const raw of provider) {
    if (raw.type === "reasoning") {
      if (exact && raw.encrypted_content)
        items.push({
          type: "reasoning",
          id: raw.id,
          summary: raw.summary ?? [],
          encrypted_content: raw.encrypted_content,
        });
    } else if (raw.type === "message") {
      const text = messageText(raw);
      if (!text) continue;
      items.push(
        exact
          ? {
              type: "message",
              role: "assistant",
              id: raw.id,
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            }
          : { role: "assistant", content: text },
      );
    } else if (raw.type === "function_call") {
      callIds.push(String(raw.call_id));
      items.push({
        type: "function_call",
        ...(exact && !!raw.id && { id: raw.id }),
        call_id: raw.call_id,
        name: raw.name,
        arguments: raw.arguments,
      });
    }
  }
  if (provider.length === 0 && item.call) {
    const prose = item.content.split(/\n?<codemode/)[0]!.trim();
    if (prose) items.push({ role: "assistant", content: prose });
    items.push({
      type: "function_call",
      call_id: item.call.callId,
      name: RUN_TOOL.name,
      arguments: runArguments(item.call.status, item.call.script),
    });
    callIds.push(item.call.callId);
  }
  return { items, callIds };
}

/** The output a call shows when its result did not come back before the conversation moved on
 *  (still running, or never run). Fixed text, so a later request renders it the same way. */
const NO_RESULT_YET =
  "No result had come back when the conversation moved on. If the script finishes, its result arrives later as its own message.";

export type BuildInputArgs = {
  /** The conversation through the request (contract.ts `contextItems`, offset order). */
  items: RenderItem[];
  /** Image bytes by path, for the user items that attach them. */
  images: Map<string, { contentType: string; base64: string }>;
  /** Which call each of this loop's script runs answered: run request offset → call id. */
  runs: Record<string, { callId: string }>;
  /** The model the request goes to: its own earlier output is replayed exactly. */
  model: string;
  /** This agent's path (its scripts run there too): words it sent itself carry no "[from …]" line. */
  ownPath: string;
  /** Replay encrypted reasoning items (off for the one retry after the provider refused them). */
  replayReasoning?: boolean;
};

/** THE INPUT: the head snapshot of the sections, then the conversation in log order, each call
 *  followed by its result. Append-only by construction: an item's rendering depends only on items
 *  at or before the next request's stamp, so request N+1's input begins with request N's. */
export function buildResponsesInput(args: BuildInputArgs): InputItem[] {
  const { items, images, runs, model, ownPath } = args;
  const replayReasoning = args.replayReasoning ?? true;
  const out: InputItem[] = [];

  // the head: the snapshot's sections, each its own developer message; the explicit breakpoint
  // closes the part agents with the same instructions share
  const head = items.find((item) => item.sections && item.snapshot);
  if (head?.sections) {
    const names = Object.keys(head.sections).filter((name) => head.sections![name] !== null);
    const sharedEnd = names.findLastIndex((name) => !OWN_SECTIONS.has(name));
    names.forEach((name, index) => {
      const text = head.sections![name]!;
      out.push(
        index === sharedEnd
          ? {
              role: "developer",
              content: [
                { type: "input_text", text, prompt_cache_breakpoint: { mode: "explicit" } },
              ],
            }
          : { role: "developer", content: text },
      );
    });
  }

  const resultByRun = new Map<number, RenderItem>();
  for (const item of items)
    if (item.actor?.type === "script") resultByRun.set(item.actor.requestOffset, item);
  const runByCall = new Map<string, number>();
  for (const [run, { callId }] of Object.entries(runs)) runByCall.set(callId, Number(run));
  const stamps = items.filter((item) => item.stamp).map((item) => item.offset);
  const placed = new Set<number>();

  for (const item of items) {
    if (item === head || placed.has(item.offset)) continue;
    if (item.role === "system") {
      if (item.content) out.push({ role: "developer", content: item.content });
      continue;
    }
    if (item.role === "assistant") {
      const answer = answerItems(item, model, replayReasoning);
      let calls = 0;
      for (const input of answer.items) {
        out.push(input);
        if (input.type !== "function_call") continue;
        const callId = String(input.call_id);
        // only a response's first call runs; any other is answered as not run (decided by position
        // alone, fixed by the log, so every later request renders it alike)
        if (calls++ > 0) {
          out.push({
            type: "function_call_output",
            call_id: callId,
            output: "Not run: only the first `run` call of a response runs.",
          });
          continue;
        }
        // the result is the call's output only when no request was made between the answer and
        // the result: a request in between showed "no result yet", and so must every later one
        const run = runByCall.get(callId);
        const result = run === undefined ? undefined : resultByRun.get(run);
        const late =
          !result || stamps.some((stamp) => stamp > item.offset && stamp < result.offset);
        if (!late) {
          out.push({ type: "function_call_output", call_id: callId, output: result.content });
          placed.add(result.offset);
        } else out.push({ type: "function_call_output", call_id: callId, output: NO_RESULT_YET });
      }
      continue;
    }
    const trusted = !item.compaction && (!item.actor || item.actor.type !== "user");
    if (item.role === "developer" && item.actor?.type === "script") {
      // a result whose call is not in this conversation (compacted away) or came back late
      out.push({
        role: "user",
        content: `[the result of your script @${String(item.actor.requestOffset)}, which came back after the conversation moved on]\n${item.content}`,
      });
      continue;
    }
    if (item.role === "developer" && trusted) {
      out.push({ role: "developer", content: item.content });
      continue;
    }
    // a person's words, third-party data, a compaction summary: user role, never instructions
    const own = item.from === ownPath;
    const text = item.from && !own ? `${fromLine(item.from)} ${item.content}` : item.content;
    const parts: InputItem[] = [];
    const hints: string[] = [];
    for (const file of item.files || []) {
      const image = images.get(file.path);
      if (image)
        parts.push({
          type: "input_image",
          image_url: `data:${image.contentType};base64,${image.base64}`,
          detail: "auto",
        });
      else hints.push(fileHintLine(file));
    }
    const body = [text, ...hints].filter(Boolean).join("\n");
    out.push(
      parts.length === 0
        ? { role: "user", content: body }
        : { role: "user", content: [{ type: "input_text", text: body }, ...parts] },
    );
  }
  return out;
}

/** The answer as the event log spells it (the previous loop's format, which the Agents app, the
 *  relays and voice read): the prose, then the call as a `<codemode>` block. */
export function answerText(prose: string, call?: { status: string; script: string }): string {
  if (!call) return prose;
  const status = call.status.replace(/"/g, "'").replace(/\n/g, " ");
  return [prose, `<codemode status="${status}">\n${call.script}\n</codemode>`]
    .filter(Boolean)
    .join("\n\n");
}
