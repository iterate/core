// install.ts — what a config repo's init case calls (README.md). Not the runtime, so importing it
// loads none.
import type {} from "./api.ts"; // registers `itx.agents` on InstalledAppRoots
import type { FacetSpec, IterateContextApi } from "../api.ts";

/** Where the catalog lives. Every context under it, at any depth, is an agent (catalog.ts). */
export const AGENTS_PATH = "/agents";

/** The module of a mind's published config that exports the app's two classes, unless the
 *  config says another (`apps/agents/backend.ts`): to `installAgents`, and on the collection's
 *  class, which starts each agent from it (catalog.ts `module`). */
export const AGENTS_MODULE = "agents.ts";

/** One of the app's facets: `className` from `module` of the mind's published config. */
export function agentsFacetSpec(
  className: "AgentCollectionDurableObject" | "AgentDurableObject",
  module = AGENTS_MODULE,
): FacetSpec {
  return { className, mainModule: module, source: ["itx", ["cd", "/"], "config"] };
}

/** The processor verbs installing calls. `list` is read only for each row's name, and answers
 *  through a promise over the wire. */
type Processors = Pick<IterateContextApi["processors"], "enable" | "disable"> & {
  list(): readonly { name: string }[] | PromiseLike<readonly { name: string }[]>;
};

/** Idempotent: enabling the row again appends nothing, the rule is written back if removed, and a
 *  catalog row on the root is disabled once. */
export async function installAgents(
  itx: Pick<IterateContextApi, "append"> & {
    processors: Processors;
    cd(path: string): { processors: Pick<Processors, "enable"> };
  },
  options: { module?: string } = {},
) {
  const spec = agentsFacetSpec("AgentCollectionDurableObject", options.module);
  await itx.cd(AGENTS_PATH).processors.enable("agents", {
    ...spec,
    consumes: [
      "events.iterate.com/itx/child-created",
      "events.iterate.com/agent/deleted",
      "events.iterate.com/agent/listing-updated",
    ],
  });
  await itx.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.agents",
      target: ["itx", ["cd", AGENTS_PATH], "facets", ["get", "agents", spec]],
      description:
        "The mind's installed agents app, every context under /agents: list(), create(path), get(path).message(text), delete(path)",
    },
  });
  // A catalog on the root is read by nothing, and would fold every copy an agent still sends to `/`.
  const rows = await itx.processors.list();
  if (rows.some((row) => row.name === "agents")) await itx.processors.disable("agents");
}
