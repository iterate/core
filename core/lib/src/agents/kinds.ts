// agents/kinds.ts — KINDS OF AGENT. An agent kind is one file in a project's config repo
// (`agent-kinds/<kind>.ts` by convention) whose default export is an `AgentKind`: what its agents
// are called in the catalog, its server half (the shape of an `Integration`'s `processEvent`), what
// the Agents app reads of an agent's log, and its chat view. A config repo's worker names its kinds,
//
//   import { makeAgentKind } from "iterate/agents/kinds";
//   const agentKinds = [makeAgentKind(import.meta, () => import("./agent-kinds/iterate.ts"))];
//
// runs each kind's `processEvent` beside the integrations, and calls `publishAgentKinds` on every
// publish (core/configs/default/worker.ts). The view is the Agents
// app's business: it runs in a sandboxed frame there, and `@iterate-com/ui/agent-kind-view` gives
// `View` its React type. Nothing here needs React or `cloudflare:workers`, so a browser's code can
// name these types too.
import type { IterateContextApi } from "../api.ts";
import type { StreamEvent } from "../stream/processor.ts";

export type AgentKind<View = unknown> = {
  /** The catalog's `kind` for these agents: the Agents app finds this file by it. */
  kind: string;
  /** The server half: every durable event of the project, after the project's own cases. A kind
   *  answers its own: sets up an agent's rows when it starts, hands a `message-received` on one of
   *  its paths to whatever runs it, or does the work itself. Keyed appends: an event can come more
   *  than once. A kind whose agents run elsewhere (iterate's, in the platform) has none. */
  processEvent?: (args: { event: StreamEvent; itx: IterateContextApi }) => Promise<void>;
  /** The ephemeral event types its view reads besides the agent's whole durable log (which the
   *  Agents app always reads: the Events tab shows it), e.g. an answer's streamed frames. A
   *  wildcard never matches an ephemeral event, so each is named. */
  ephemeralEvents?: string[];
  /** The chat, which only the Agents app's frame calls. */
  view: View;
};

/** A kind file, from a function written exactly `() => import("./path/to/kind.ts")`. `path` is the
 *  file's place in the config repo: the import, resolved against `meta`, the calling file's
 *  `import.meta`. The platform gives each module that reads `import.meta` a `url` of
 *  `file:///<its path in the repo>`, and keeps the import as written but for `.ts` → `.js`
 *  (`publishAgentKinds` checks which the repo has). Under Vite (a test) both are the checkout's
 *  absolute paths, so `path` is too. */
export function makeAgentKind(meta: { url?: string }, load: () => Promise<{ default: AgentKind }>) {
  const specifier = load
    .toString()
    .match(/^\(\)\s*=>\s*[\w$]*import[\w$]*\(\s*(["'])([^"']+)\1\s*\)$/)?.[2];
  if (!specifier)
    throw new Error(
      `makeAgentKind takes () => import("./path/to/kind.ts") and nothing else, not ${load.toString()}`,
    );
  if (!meta.url) throw new Error("makeAgentKind takes its file's import.meta, which has no url");
  const url = new URL(specifier.replace(/^\/@fs\//, "/"), meta.url);
  return { path: decodeURIComponent(url.pathname).slice(1), load };
}

/** Writes `{ <kind>: <path> }` to the project's KV under `agent-kinds`, where the Agents app reads
 *  which file has a kind's chat view. A path the repo doesn't have (`x.js`, as the platform loads
 *  it) is the `.ts` it was written as. */
export async function publishAgentKinds(
  itx: IterateContextApi,
  agentKinds: ReturnType<typeof makeAgentKind>[],
) {
  const repo = itx.repos.get("/repos/config");
  const paths: Record<string, string> = {};
  for (const { path, load } of agentKinds) {
    const { default: kind } = await load();
    paths[kind.kind] = (await repo.readFile(path)) === null ? path.replace(/\.js$/, ".ts") : path;
  }
  await itx.kv.put("agent-kinds", JSON.stringify(paths));
}
