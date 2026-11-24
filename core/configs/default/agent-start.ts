// agent-start.ts — ONE WAY TO START AN AGENT: ONE APPEND OF KEYED FACTS. An agent is facts on a
// context: the parent link, `agent/configured`, and one `itx/subscription-configured` row for each
// facet of agent/facets.json (agent/start.ts `agentStartEvents` makes them, and reads nothing).
// Every fact has an idempotency key, so starting twice writes once: the kind sends the start facts
// with every input and asks nothing first.
//
//   startEvents(path, options)               the start facts: `itx.agents.create(path)` appends
//                                            them, and sends them with each message (agents.ts)
//   toAgent(itx, path, events, options)      the start facts and `events` in one append
//                                            (agent-kinds/agent.ts)
//   startSubagent(itx, request)              the answer to `agent/subagent-requested`
//
// EVERY AGENT OF THE MIND STARTS HERE, AT ANY PATH: the onboarding agent, a mail, Slack or X
// thread, a meeting, a subagent. Each of them is `itx.agents.create(path)`, and the platform's
// collection appends `startEvents` (agents.ts hands it the function).
//
// A PERSON STARTS AN AGENT WITH NO METHOD OF THIS FILE: the Dash's New agent appends the kind's own
// start fact, `agent-ui/agent-requested`, as that member (agent-kinds/agent.ts `newAgent`), and the
// kind answers it with `toAgent`.
//
// THE PARENT LINK IS WRITTEN ONCE, BY THE START THAT GIVES BIRTH TO AN AGENT (agent/start.ts): to
// the mind's root, or to the agent that asked for a subagent. Every later start names no parent.
//
// A PARENT LINK IS NOT A JAIL. It says where the child's `itx` names lead. It does not hold the
// child: a context's own `cd` and roots answer from its own table, whatever its parent masks
// (core/itx parent-rule-and-child.test.ts). So an agent that something holds gets no subagent
// here (`startSubagent`): a config that restricts an agent starts its children itself, with the
// same restriction on each.
//
// WHAT AN AGENT IS TOLD is not part of its start. every-event.ts sees the start's
// `agent/configured` and appends the agent's system prompt (agent-prompt.ts). The agent waits
// `llmRequestDebounceMs` between an input and its request, so the prompt is there first.
//
// Under /agents, copy rows list the agent in the /agents catalog as kind `agent`
// (agent-kinds/agent.ts), with its title, activity and status.
import type { IterateContextApi } from "iterate/api";
import { errorCode } from "iterate/lib";
import { z } from "zod";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import agentFiles from "./agent/";
import type { AgentState } from "./agent/contract.ts";
import { agentStartEvents, CONTEXT_PATH, contextCopiedEvents } from "./agent/start.ts";

const T = "events.iterate.com/";
const AGENTS = "/agents";

/** The mind's root, as worker.ts hands it to every hook. */
export type Itx = IterateContextApi;
type Event = { type: string; idempotencyKey?: string; payload?: Record<string, unknown> };

/** Where the facets' code is: this repo's agent/ folder, read when a facet starts. */
const SOURCE = [
  "itx",
  ["cd", "/"],
  "repos",
  ["get", "/repos/config"],
  ["modules", { dir: "agent" }],
];

/** Every facet of facets.json: the agent and the request makers. */
const Facets = z.array(
  z.object({
    name: z.string(),
    className: z.string(),
    consumes: z.array(z.string()),
  }),
);

/** Production's debounce: an input waits this long for more context before its request. The
 *  agent's system prompt arrives in that time (agent-prompt.ts). */
const DEBOUNCE = { llmRequestDebounceMs: 250 };

/** WHAT PAYS FOR AN OPENAI MODEL, IN ORDER: the first of these secrets that is set in the mind
 *  (agent/contract.ts `keys`). With neither set, the mind's AI Gateway pays. Both go straight to
 *  OpenAI's API, and the mind's egress makes the header the secret: no key is in this repo.
 *    1. a ChatGPT plan (`npx iterate chatgpt connect`), the secret /secrets/chatgpt;
 *    2. an OpenAI API key, /secrets/openai: the owner's own, or the one iterate Cloud lends.
 *  A start with a config of its own that names `llmProviders.openai` (a subagent on a provider of
 *  the owner's) replaces this entry: the patch merges one level deep. */
const OPENAI_API = "https://api.openai.com/v1";
const WHAT_PAYS = {
  llmProviders: {
    openai: {
      api: "openai-responses",
      keys: [
        {
          secret: "/secrets/chatgpt",
          baseUrl: OPENAI_API,
          headers: {
            authorization: 'Bearer getSecret("/secrets/chatgpt", { field: "accessToken" })',
          },
        },
        {
          secret: "/secrets/openai",
          baseUrl: OPENAI_API,
          headers: { authorization: 'Bearer getSecret("/secrets/openai")' },
        },
      ],
    },
  },
};

/** How many of a context's first facts are read for the start's `agent/configured`: the start
 *  writes it within its first ten. */
const FIRST_FACTS = 100;

/** The rows that list the agent on /agents: each copies a fact of the agent's own log there as
 *  `agent/listing-updated`, and the platform's catalog folds the copies (iterate/agents). The kind
 *  is written when the agent is configured. They stand before `agent/configured` in the start's
 *  append, so the row that copies the kind sees it. */
const CATALOG_ROWS = [
  {
    name: "agent-catalog-kind",
    consumes: [`${T}agent/configured`],
    target: { path: AGENTS, type: `${T}agent/listing-updated`, payload: `{ "kind": "agent" }` },
  },
  {
    name: "agent-catalog-summary",
    consumes: [`${T}agent/summary-updated`],
    filter: `$type(payload.title) = "string" or $type(payload.activity) = "string" or $type(payload.waitingFor) = "string" or payload.waitingFor = null or $type(payload.description) = "string"`,
    target: {
      path: AGENTS,
      type: `${T}agent/listing-updated`,
      payload: `{
        "title": $type(payload.title) = "string" ? $substring(payload.title, 0, 120),
        "activity": $type(payload.activity) = "string"
          ? $substring(payload.activity, 0, 200)
          : $type(payload.waitingFor) = "string"
            ? "Waiting for " & $replace(payload.waitingFor, "_", " ")
            : (payload.waitingFor = null ? ""),
        "description": $type(payload.description) = "string" ? $substring(payload.description, 0, 500)
      }`,
    },
  },
  {
    // the first line of a person's words: a transcription's own first line is the mind's
    // (agent-ui.ts: it begins with a dash), so it is passed over
    name: "agent-catalog-first-words",
    consumes: [`${T}agent/context-added`],
    // A call's note ("[call] … joined the call": call.ts `noteEvent`, with `callNote`) is an
    // input of role `user` that nobody wrote: it is no first words, and no title.
    filter: `payload.role = "user" and $not($exists(payload.callNote))`,
    target: {
      path: AGENTS,
      type: `${T}agent/listing-updated`,
      payload: `{
        "title": $substring(($split(payload.content, "\\n").$trim($))[$ != "" and $substring($, 0, 1) != "—"][0], 0, 120),
        "fromWords": true,
        "activity": ""
      }`,
    },
  },
  {
    // an answer request is work; its end is idle (a script's side request and a summary are no turn)
    name: "agent-catalog-status",
    consumes: [`${T}llm-request/requested`, `${T}llm-request/settled`],
    filter: `type = "${T}llm-request/settled" or payload.purpose = "answer"`,
    target: {
      path: AGENTS,
      type: `${T}agent/listing-updated`,
      payload: `{ "status": type = "${T}llm-request/requested" ? "working" : "idle" }`,
    },
  },
];

const text = (content: string | Uint8Array) =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

let version: Promise<string> | undefined;

/** A short name for the folder's code: a hash of every file's path and content. A facet started
 *  under another version is started again with the new code. */
async function versionOf(): Promise<string> {
  const parts = Object.keys(agentFiles)
    .sort()
    .map((path) => `\0${path}\0${text(agentFiles[path])}`);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join(""))),
  );
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** THE FACTS THAT START AN AGENT at `path`, or give a running one a new config or new code. It
 *  reads nothing of the mind: the caller appends them to the context, in one append. `parent` is
 *  for the start that gives birth to the agent (the header). */
export async function startEvents(
  path: string,
  { parent, config = {} }: { parent?: string; config?: Record<string, unknown> } = {},
) {
  const facetsJson = Object.entries(agentFiles).find(([file]) => file.endsWith("facets.json"))?.[1];
  if (!facetsJson) throw new Error("agent/facets.json is missing from this commit");
  return await agentStartEvents(path, {
    config: { ...DEBOUNCE, ...WHAT_PAYS, ...config },
    facets: Facets.parse(JSON.parse(text(facetsJson))),
    code: {
      source: SOURCE,
      mainModule: "facets.ts",
      cacheKey: `agent:${await (version ||= versionOf())}`,
    },
    rows: path.startsWith(`${AGENTS}/`) ? CATALOG_ROWS : [],
    parent,
  });
}

/** A second append with a key that came back with another body: the first stands. */
const firstStands = (error: unknown) => {
  if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
};

/** THE START FACTS AND `events` IN ONE APPEND to the agent at `path`. */
export async function toAgent(
  itx: Itx,
  path: string,
  events: Event[],
  options: {
    parent?: string;
    config?: Record<string, unknown>;
    /** What to do when the context has a link to ANOTHER parent since its birth, so the log
     *  refuses the whole append. "refuse": throw, and nothing is written (a subagent: its brief
     *  and its parent's conversation must not land on an agent of another parent). None: the
     *  first link stands, and the start goes again without a parent, so that a person's words to
     *  that agent are not lost with the link. */
    anotherParent?: "refuse";
  } = {},
) {
  const context = itx.cd(path);
  const { parent, config, anotherParent } = options;
  try {
    await context.append(...(await startEvents(path, { parent, config })), ...events);
  } catch (error) {
    firstStands(error);
    if (!parent) return;
    if (anotherParent === "refuse")
      throw new Error(`${path} is an agent with another parent: it is not yours to start`, {
        cause: error,
      });
    await context.append(...(await startEvents(path, { config })), ...events).catch(firstStands);
  }
}

/** THE AGENT AT A CONTEXT, or null where this agent does not run:
 *  - `asked`: the Dash asked for one here, with `agent-ui/agent-requested` among the context's
 *    first facts. Events reach a kind in no order (iterate/sdk `Integration.processEvent`), so a
 *    person's first words can be handled before the request that the Dash appended ahead of
 *    them. The words' own append then gives birth to the agent, and the request's handling
 *    writes the same keyed facts.
 *  - `fork`: its start brought instructions, its parent's (`startSubagent`). A fork keeps them.
 *  Its start facts stand among the first facts of a context that was born as an agent, and at the
 *  END of the log of a context that the platform's old agent ran before (`itx.agents` takes such
 *  a context over). So the second look is at the rows: the processor `agent` is this agent's
 *  facet. */
export async function agentAt(
  itx: Itx,
  path: string,
): Promise<{ asked: boolean; fork: boolean } | null> {
  const context = itx.cd(path);
  const { events } = await context.readEvents(0, FIRST_FACTS);
  const asked = events.some((event) => event.type === `${T}agent-ui/agent-requested`);
  const starts = events.flatMap((event) => {
    const start = event.type === `${T}agent/configured` && StartConfigured.safeParse(event.payload);
    return start && start.success ? [start.data] : [];
  });
  const fork = starts.some((start) => typeof start.config?.instructions === "string");
  if (asked || starts.length > 0) return { asked, fork };
  const rows = await context.processors.list();
  return rows.some((row) => row.name === "agent" && row.hostedFacet?.className === AGENT_FACET)
    ? { asked, fork }
    : null;
}

/** The class of the agent's own facet (agent/facets.json), as its row names it. */
const AGENT_FACET = "AgentFacet";

/** A SUBAGENT IS FOR AN AGENT THAT NOTHING HOLDS. This worker answers the request with the
 *  mind's whole reach, and the child's link to its parent holds nothing (the header). So the
 *  request is refused where the agent is restricted, by the two signs a restriction leaves:
 *  - the request was appended by ANOTHER context's code (the platform's stamp, `source.origin`):
 *    an agent whose scripts run in a jail's context does not write on its own log itself;
 *  - the agent's own table masks a name (a rule with no target).
 *  A config that restricts an agent in another way must refuse this fact itself. */
async function refuseAHeldAgent(itx: Itx, request: { path: string; source?: { origin?: string } }) {
  if (request.source?.origin !== request.path)
    throw new Error(
      "a subagent is asked for by the agent's own script, on its own context: this request was written from elsewhere",
    );
  const rules = await itx.cd(request.path).rewriteRules.list();
  if (rules.some((rule) => rule.context === request.path && !rule.target))
    throw new Error(
      "this agent's context masks names, so it is restricted: the mind's own code starts the subagents of a restricted agent",
    );
}

/** The start's `agent/configured` (agent/start.ts): the one that says the context runs this agent. */
const StartConfigured = z.object({
  kind: z.literal("agent"),
  // optional: the start of an agent that is no fork has no such key
  config: z.object({ instructions: z.unknown().optional() }).optional(),
});

/** The payload of `agent/subagent-requested` (agent/contract.ts). */
const SubagentRequested = z.object({
  path: z.string(),
  brief: z.string().optional(),
  model: z.string().optional(),
  copyContext: z.boolean().optional(),
});

/** THE ANSWER TO `agent/subagent-requested` on the context `request.path` (contract.ts). ONE
 *  append to the child: the start facts with the model, and for `copyContext` the parent's
 *  instructions, model and cache key with the copy of its conversation at its head; then the brief.
 *  ONE append to the parent: `agent/subagent-started` or `agent/subagent-failed`, under one key,
 *  and a note to its model. The child must be under the parent's own path: a path that is not
 *  fails before any read and writes nothing to any child. Every key names the request, so a second
 *  call writes nothing new: the first stands. */
export async function startSubagent(
  itx: Itx,
  request: {
    path: string;
    offset: number;
    payload?: unknown;
    /** The platform's stamp: `origin` is the context whose code appended the request. */
    source?: { origin?: string };
  },
) {
  const parsed = SubagentRequested.safeParse(request.payload);
  const child = parsed.success ? parsed.data.path : "";
  const key = `${request.path}@${request.offset}`;
  let answer: Event;
  let note: string;
  // a start needs no turn of the parent; a failure does, after the current one
  let behaviour = "dont-trigger-request";
  try {
    if (!parsed.success) throw new Error(`the request is malformed: ${parsed.error.message}`);
    await refuseAHeldAgent(itx, request);
    const { brief, model, copyContext } = parsed.data;
    if (!child.startsWith(`${request.path}/`) || !CONTEXT_PATH.test(child))
      throw new Error(
        `${JSON.stringify(child)} is not under your own path: name one such as ${request.path}/<job>`,
      );
    const llm = model ? { model } : {};
    let config: Record<string, unknown> = model ? { llm } : {};
    let copied: Event[] = [];
    let copiedItems = 0;
    if (copyContext) {
      // A cast, safe and needed: the facet `agent` on this context is agent/facet.ts `AgentFacet`,
      // whose snapshot is its processor's state, and `facets.get` types no facet of a context.
      const { offset, state } = await itx
        .cd(request.path)
        .facets.get<{ snapshot(): Promise<{ offset: number; state: AgentState }> }>("agent")
        .snapshot();
      const items = [...state.copiedItems, ...state.items];
      config = {
        instructions: state.config.instructions,
        llm: {
          model: state.config.llm.model,
          promptCacheKey: state.config.llm.promptCacheKey || state.path,
          ...llm,
        },
      };
      copied = contextCopiedEvents(
        { path: request.path, throughOffset: offset, lineage: state.lineage, items },
        key,
      );
      copiedItems = items.length;
    }
    // WHO THE CHILD IS. A fork has its parent's instructions and conversation, which say that it is
    // the parent (measured on a real mind on 23 November 2026: a fork with a bare brief answered as
    // its parent, to the parent's person). So the brief says first who the child is and to whom
    // it reports.
    const words = brief || "(no task was given)";
    const report = `\`itx.cd(${JSON.stringify(request.path)}).append({ type: "events.iterate.com/agent/context-added", payload: { role: "user", content: "<your report>" } })\``;
    const briefed = [
      {
        type: `${T}agent/context-added`,
        idempotencyKey: `agent/subagent-brief:${key}`,
        payload: {
          role: "developer",
          content:
            copyContext === true
              ? `[fork] From here on you are a forked subagent at ${child}. Everything above is a copy of your parent's conversation. Your parent is the agent at ${request.path}: where your instructions name that path as yours, yours is ${child}. No person reads your feed. Report to your parent with ${report}. Your task:\n${words}`
              : `[subagent] You are a subagent at ${child}, started by the agent at ${request.path}. No person reads your feed. Report to that agent with ${report}. Your task:\n${words}`,
        },
      },
    ];
    // The child's `itx` is linked to its parent. A path where an agent of ANOTHER parent runs
    // is refused: the brief and the copied conversation land on no agent but this one's child.
    await toAgent(itx, child, [...copied, ...briefed], {
      config,
      parent: request.path,
      anotherParent: "refuse",
    });
    answer = {
      type: `${T}agent/subagent-started`,
      payload: { requestOffset: request.offset, path: child, copiedItems },
    };
    note = `[subagent] Your subagent at ${child} has started.`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    answer = {
      type: `${T}agent/subagent-failed`,
      payload: { requestOffset: request.offset, error: reason },
    };
    note = `[subagent] No subagent started at ${JSON.stringify(child)}: ${reason}`;
    behaviour = "after-current-request";
  }
  await itx
    .cd(request.path)
    .append(
      { ...answer, idempotencyKey: `agent/subagent-answered:${request.offset}` },
      {
        type: `${T}agent/context-added`,
        idempotencyKey: `agent/subagent-note:${request.offset}`,
        payload: { role: "developer", content: note, llmRequestPolicy: { behaviour } },
      },
    )
    .catch(firstStands);
}
