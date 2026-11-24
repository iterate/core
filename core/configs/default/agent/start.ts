// start.ts — AN AGENT STARTED BY ONE APPEND. `agentStartEvents` gives the facts that make a context
// run an agent; the caller appends them in one call:
//
//   await itx.cd(path).append(...(await agentStartEvents(path, { config, facets, code })));
//
// There is no RPC method behind it. The facts are what `processors.enable` and `itx.agents.create`
// append today (core/itx/src/context/built-ins.ts), written out:
//
//   1. the parent link `itx` → `itx.cd(<parent>)`, when the caller names a parent: a new context
//      has no `itx.repos` or `itx.ai` of its own. THE LINK IS WRITTEN ONCE, AT THE AGENT'S BIRTH:
//      a later start names no parent and writes no link (see `parent` below);
//   2. the caller's other rows (a catalog's copy rows), as they are;
//   3. `agent/configured`, with the config as given and `kind: "agent"`: the mind's code knows by
//      this fact that the context runs this agent, and reads no processor's row;
//   4. one `itx/subscription-configured` for each facet, in the order the caller gives.
//
// EVERY FACT HAS A KEY. The log refuses the WHOLE batch when a key comes back with another body, so
// a key must change when its fact's body changes. The key of a config or of a row holds a hash of
// its body. The key of a facet's row holds `code.cacheKey` only: THE CALLER'S `cacheKey` MUST CHANGE
// WITH EVERYTHING ELSE IN THAT ROW (`source`, `mainModule`, the class, `consumes`).
// THE PARENT LINK'S KEY HOLDS THE PATH ALONE, ON PURPOSE: the first link stands, and a start that
// names another parent is refused whole. With the body in the key, a later start could link the
// agent to another parent, and the newer rule would win. (A parent link is no jail: a child's own
// table answers for it, core/itx/src/context/parent-rule-and-child.test.ts.)
// So starting twice writes once, and a processor that writes an input (a Slack integration) can send
// these facts with every input: no "is it started" check. A new config, a new version of the code or a
// new row body is a new key for that fact only.
//
// A FORKED SUBAGENT starts with these facts and with `contextCopiedEvents`: its parent's
// conversation in as many `agent/context-copied` facts as the size of one fact needs. The mind's
// worker reads the parent and appends both (agent/subagent-requested, contract.ts).
//
// WHAT AN AGENT IS TOLD is not part of its start. The mind's `worker.ts` appends the system prompt
// when it sees the start's `agent/configured`, and there it can choose by kind (a Slack agent, a
// web agent).
//
// It writes no `itx.agents` rule: who sent an input is the platform's stamp (`source.origin`).
// It is pure: it reads nothing, and calls nothing but `crypto.subtle.digest`.

import type { StreamEventInput } from "iterate/stream/processor";
import type { ConversationItem } from "./llm-request.ts";

const T = "events.iterate.com/";
/** A context path: `/agents/<name>`, one or more parts. */
export const CONTEXT_PATH = /^(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

/** One facet of the agent: the processor's name, the class its module exports, what it consumes. */
export type FacetRow = { name: string; className: string; consumes: string[] };

export type AgentStartOptions = {
  /** THE CONTEXT THE AGENT'S `itx` LEADS TO: `/`, or the agent that started this one (so that what
   *  holds that agent holds its child too). Name it at the agent's birth ONLY. With none, the start
   *  writes no link: the one on the log stands. */
  parent?: string;
  /** A partial AgentConfig. */
  config?: Record<string, unknown>;
  facets: FacetRow[];
  /** Where the facets' code is and its version. */
  code: { source: unknown; mainModule: string; cacheKey: string };
  /** Other subscription rows for the context (a catalog's copy rows): payloads, written as they are. */
  rows?: { name: string; [key: string]: unknown }[];
};

/** A fact of the start: every one has a key. */
export type AgentStartEvent = StreamEventInput & {
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

export async function agentStartEvents(
  path: string,
  options: AgentStartOptions,
): Promise<AgentStartEvent[]> {
  if (!CONTEXT_PATH.test(path))
    throw new Error(
      `an agent runs on a context: a path such as /agents/<name>, not ${JSON.stringify(path)}`,
    );
  const { code, config = {}, rows = [] } = options;
  if (options.parent && options.parent !== "/" && !CONTEXT_PATH.test(options.parent))
    throw new Error(
      `an agent's parent is a context: "/" or a path such as /agents/<name>, not ${JSON.stringify(options.parent)}`,
    );

  const parent: AgentStartEvent[] = options.parent
    ? [
        {
          type: `${T}itx/rewrite-rule-configured`,
          idempotencyKey: `agent-parent:${path}`,
          payload: { match: "itx", target: `itx.cd(${JSON.stringify(options.parent)})` },
        },
      ]
    : [];

  const rowEvents = await Promise.all(
    rows.map(async (row): Promise<AgentStartEvent> => ({
      type: `${T}itx/subscription-configured`,
      idempotencyKey: `agent-row:${row.name}:${path}:${await hexOf(JSON.stringify(row), 12)}`,
      payload: row,
    })),
  );

  const configured: AgentStartEvent = {
    type: `${T}agent/configured`,
    idempotencyKey: `agent-configured:${path}:${await hexOf(JSON.stringify(config), 16)}`,
    payload: { kind: "agent", config },
  };

  const facetEvents = options.facets.map((facet): AgentStartEvent => ({
    type: `${T}itx/subscription-configured`,
    idempotencyKey: `agent-facet:${facet.name}:${path}:${code.cacheKey}`,
    payload: {
      name: facet.name,
      target: [
        "itx",
        "facets",
        [
          "get",
          facet.name,
          {
            source: code.source,
            cacheKey: code.cacheKey,
            className: facet.className,
            mainModule: code.mainModule,
          },
        ],
        "processEventBatch",
      ],
      consumes: facet.consumes,
    },
  }));

  return [...parent, ...rowEvents, configured, ...facetEvents];
}

/** THE SIZE OF ONE `agent/context-copied`: the JSON of its items, in characters. The platform's
 *  ceiling for one event is 8 MiB of JSON (core/itx/src/stream/stream.ts `EVENT_BODY_MAX_CHARS`);
 *  this is far under it, as the request maker's own fact is (llm-api.ts `MAX_INPUT_ITEMS_CHARS`). */
export const COPY_PART_MAX_CHARS = 1_000_000;

/** THE SIZE OF THE WHOLE COPY. The child's facts go in one append, and Workers RPC carries at most
 *  32 MiB in one message. */
const COPY_MAX_CHARS = 24 * 1024 * 1024;

/** A FORKED SUBAGENT'S COPY OF ITS PARENT'S CONVERSATION: `items` (the parent's copied items, then
 *  its own) in parts, each at most `COPY_PART_MAX_CHARS` unless one item is larger alone, and at
 *  least one part, so that the lineage is written. The lineage is the parent's, then the parent
 *  through `throughOffset`. `key` names the request, so a second call for it writes nothing new. */
export function contextCopiedEvents(
  parent: {
    path: string;
    /** The offset of the parent's log through which `items` are its conversation. */
    throughOffset: number;
    /** The parent's own ancestors, oldest first: empty for an agent that is no fork. */
    lineage: { path: string; throughOffset: number }[];
    items: ConversationItem[];
  },
  key: string,
): AgentStartEvent[] {
  const total = JSON.stringify(parent.items).length;
  if (total > COPY_MAX_CHARS)
    throw new Error(
      `the conversation is ${total} characters: a fork copies at most ${COPY_MAX_CHARS} in its one append`,
    );
  const parts: ConversationItem[][] = [[]];
  let chars = 0;
  for (const item of parent.items) {
    const size = JSON.stringify(item).length + 1;
    if (chars + size > COPY_PART_MAX_CHARS && parts[parts.length - 1].length > 0) {
      parts.push([]);
      chars = 0;
    }
    parts[parts.length - 1].push(item);
    chars += size;
  }
  const lineage = [...parent.lineage, { path: parent.path, throughOffset: parent.throughOffset }];
  return parts.map((items, part) => ({
    type: `${T}agent/context-copied`,
    idempotencyKey: `agent/context-copied:${key}:${part}`,
    payload: { lineage, part, parts: parts.length, items },
  }));
}

/** The first `length` hex characters of the SHA-256 of `text`. */
async function hexOf(text: string, length: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}
