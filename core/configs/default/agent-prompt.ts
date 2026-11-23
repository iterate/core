// agent-prompt.ts — WHAT AN AGENT IS TOLD. No processor of its own: every-event.ts calls
// `agentPrompt` with every event of the mind, and it does one thing:
//
//   IF A NEW AGENT IS CREATED, THEN APPEND ITS SYSTEM PROMPT, IDEMPOTENTLY.
//
// "A new agent is created" is a fact: the start's `agent/configured` with `kind: "agent"`
// (agent/start.ts writes it). The prompt is the agent's instructions: one `agent/configured
// { config: { instructions } }` under a key made from its text, so the same prompt is written once.
// Instructions are no part of the conversation: a summary never replaces them.
//
// A FORK GETS NO PROMPT. Its start brings its parent's instructions in its config (agent-start.ts
// `startSubagent`), and another prompt would end the provider's cache at its first byte. So a start
// whose config has instructions gets none.
//
// TO CHANGE WHAT AN AGENT IS TOLD, CHANGE THIS FILE: `promptOf` is the whole prompt. The agent adds
// its own rule after it: one `<codemode>` block per answer, and how a script runs.
//
// The agent waits `llmRequestDebounceMs` (agent-start.ts sets 250 ms, production's value) between
// an input and its request, so the prompt is there before the first request of an agent that got
// its first words with its start.
import type { RewriteRuleListEntry } from "iterate/api";
import { errorCode, reportIssue } from "iterate/lib";
import { z } from "zod";
import { AGENT_MESSAGES, SUBAGENTS } from "./agent/fragments.ts";
import { PEOPLE, type Itx } from "./agent-start.ts";
import { WEB_MESSAGES } from "./agent-ui.ts";

const T = "events.iterate.com/";
/** A standing file longer than this is cut, with a line that says so (production's limit). */
const FILE_MAX_CHARS = 100_000;

/** The files every agent reads, as the template's agents.ts names them. */
const FILES = ["AGENTS.md", "mind.md"];

/** What the line under a person's words in the Dash is (agent-ui.ts, the transcription). */
const WEB_UI_LINES = [
  "A person's words from the Dash end with a line that the mind writes, not the person:",
  "`— Web UI: <who> wrote this in the Dash.` (`Mobile UI` on a phone), or, for words sent with",
  "`itx.agents.get(path).message()`, `— Agents API: <who> sent this …`. <who> is the platform's stamp",
  "on the raw event, and the line says where that event is.",
].join("\n");

/** The section of AGENTS.md that this file replaces: it teaches the platform's own agents
 *  (`sendMessage`, words beside a script, `itx.agents.create`), which the template's onboarding
 *  agent still is. */
const WAITING_HEADING = "## While a person waits";
const WAITING = [
  WAITING_HEADING,
  "",
  "A person who wrote to you looks at an empty space until you answer. Make that short.",
  "",
  "- **Say first, work second.** Your script's first words to the person come before its work: \"On",
  '  it: the page turns green in a moment." Never put a result there: it does not exist yet.',
  "- **Start things together.** Steps that do not depend on each other run in ONE script with",
  "  `Promise.all`, never one after the other.",
  "- **Say each piece of news when it arrives**, as a short message of its own, between the steps",
  "  of a script or in your next answer. Three short messages over a minute are better than one",
  "  long message at the end.",
  "- **Give anything that is not small to a subagent**, under your own path, and keep talking. Your",
  "  own context stays small: do not read the mind's code into it for a job that a subagent can do.",
].join("\n");

/** AGENTS.md with its section for the platform's agents replaced by this agent's. */
function forThisAgent(file: string, text: string): string {
  if (file !== "AGENTS.md") return text;
  const start = text.indexOf(`${WAITING_HEADING}\n`);
  if (start === -1) return text;
  const end = text.indexOf("\n## ", start + WAITING_HEADING.length);
  return `${text.slice(0, start)}${WAITING}\n${end === -1 ? "" : text.slice(end)}`;
}

/** What changes in a row's description while the capability does not: a commit, a publication. */
const VOLATILE = /\s+at [0-9a-f]{7,40}(?:, publication \d+)?|,?\s*publication \d+/g;

/** The capability tree as the model reads it, in an order and words that change only when a
 *  capability does (core/lib/src/agents/render.ts `stableCapabilityTree`). */
function capabilityTree(rows: RewriteRuleListEntry[]): string | null {
  const visible = rows.filter((row) => row.target && row.match !== "itx");
  if (visible.length === 0) return null;
  const contexts = [...new Set(visible.map((row) => row.context))].sort();
  return [
    "`itx` is this context's capability tree (`await itx.rewriteRules.list()`). Your scripts can spell every name below, and nothing else:",
    ...contexts.flatMap((context) => [
      `from ${context}:`,
      ...visible
        .filter((row) => row.context === context)
        .map(
          (row) =>
            `${row.match} — ${(row.description || "").replace(VOLATILE, "").trim() || `⇒ ${JSON.stringify(row.target)}`}`,
        )
        .sort(),
    ]),
  ].join("\n");
}

/** THE SYSTEM PROMPT of the agent at `path`: how it says words, the mind's AGENTS.md and mind.md,
 *  its capability tree and who it is. A part that cannot be read is left out. */
async function promptOf(itx: Itx, path: string): Promise<string> {
  const agent = itx.cd(path);
  const repo = itx.repos.get("/repos/config");
  const [files, tree, identity] = await Promise.all([
    Promise.all(
      FILES.map(async (file) => {
        const read = await repo.readFile(file).catch(() => null);
        if (!read) return null;
        const text = forThisAgent(file, read);
        const shown =
          text.length <= FILE_MAX_CHARS
            ? text
            : `${text.slice(0, FILE_MAX_CHARS)}\n\n[${file} is cut here: it has ${text.length} characters, and at most ${FILE_MAX_CHARS} are shown.]`;
        return { file, part: `── ${file} (/repos/config) ──\n${shown}` };
      }),
    ),
    agent.rewriteRules
      .list()
      .then(capabilityTree)
      .catch(() => null),
    Promise.resolve(agent.whoami())
      .then(
        (who) =>
          `You are the agent at ${path}. \`await itx.whoami()\` answers:\n${JSON.stringify(who)}`,
      )
      .catch(() => `You are the agent at ${path}.`),
  ]);
  const shown = files.flatMap((file) => (file ? [file] : []));
  return [
    "You are an agent on the iterate platform. Everything you do, you do by a script: JavaScript " +
      "with this context's `itx`.",
    WEB_MESSAGES,
    WEB_UI_LINES,
    AGENT_MESSAGES,
    SUBAGENTS,
    `Below, as they were when you started: ${[...shown.map(({ file }) => file), "your capability tree", "who you are"].join(", ")}.`,
    ...shown.map(({ part }) => part),
    ...(tree ? [`── capability tree ──\n${tree}`] : []),
    `── identity ──\n${identity}\n${MODEL}`,
  ].join("\n\n");
}

/** What an agent is told of its model. Measured on a real mind on 23 November 2026: asked "which
 *  model are you", an agent with no such line searched the repository for six requests. */
const MODEL =
  "You cannot see from inside which model answers for you: it is in your config, and anyone can " +
  "change it between two requests. If a person asks which model you are, say that in one line. " +
  "Do not search for it.";

/** The start's `agent/configured` with no instructions (agent/start.ts): an agent that is no fork
 *  starts there. */
const StartWithoutInstructions = z.object({
  kind: z.literal("agent"),
  config: z.object({ instructions: z.undefined() }).optional(),
});

async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Any event of the mind (every-event.ts runs it beside the integrations). Never throws: a failure
 *  is reported (`config.agent-prompt`, on /exceptions), and the agent then runs on its default
 *  instructions. */
export async function agentPrompt(
  itx: Itx,
  event: { type: string; path: string; payload?: unknown },
) {
  if (event.type !== `${T}agent/configured` || !event.path.startsWith(PEOPLE)) return;
  if (!StartWithoutInstructions.safeParse(event.payload).success) return;
  try {
    const instructions = await promptOf(itx, event.path);
    await itx
      .cd(event.path)
      .append({
        type: `${T}agent/configured`,
        idempotencyKey: `agent-prompt:${event.path}:${await shortHash(instructions)}`,
        payload: { config: { instructions } },
      })
      .catch((error: unknown) => {
        if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
      });
  } catch (error) {
    reportIssue("config.agent-prompt", error, { path: event.path });
  }
}
