// install.ts — what a config repo's init case calls (README.md). Not the runtime, so importing it
// loads none.
import type {} from "./api.ts"; // registers `itx.agents` on InstalledAppRoots
import type { FacetSpec, IterateContextApi } from "../api.ts";

/** Where the catalog lives. Every context under it, at any depth, is an agent (catalog.ts). */
export const AGENTS_PATH = "/agents";

/** One of the app's facets: `className` from `agents.ts` of the project's published config. */
export function agentsFacetSpec(
  className: "AgentCollectionDurableObject" | "AgentDurableObject",
): FacetSpec {
  return { className, mainModule: "agents.ts", source: ["itx", ["cd", "/"], "config"] };
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
) {
  const spec = agentsFacetSpec("AgentCollectionDurableObject");
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
        "The project's installed agents app, every context under /agents: list(), create(path), get(path).message(text), delete(path)",
    },
  });
  // A catalog on the root is read by nothing, and would fold every copy an agent still sends to `/`.
  const rows = await itx.processors.list();
  if (rows.some((row) => row.name === "agents")) await itx.processors.disable("agents");
}
