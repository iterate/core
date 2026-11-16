// install.ts — what a config repo's init case calls (README.md). Not the runtime, so importing it
// loads none.
import type {} from "./api.ts"; // registers `itx.agents` on InstalledAppRoots
import type { FacetSpec, IterateContextApi } from "../api.ts";

/** Where the catalog lives. Every context under it, at any depth, is an agent (catalog.ts). */
export const AGENTS_PATH = "/agents";

/** The module of a mind's published config that exports the app's two classes, unless the
 *  config names another: to `installAgents`, and on the collection's class, which starts each
 *  agent from it (catalog.ts `module`). */
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

/** Idempotent: enabling the row again appends nothing, the rules are written back if removed, and a
 *  catalog row on the root is disabled once. */
export async function installAgents(
  itx: Pick<IterateContextApi, "append"> & {
    processors: Processors;
    cd(path: string): Pick<IterateContextApi, "append"> & {
      processors: Pick<Processors, "enable">;
    };
  },
  options: { module?: string } = {},
) {
  const spec = agentsFacetSpec("AgentCollectionDurableObject", options.module);
  const agents = itx.cd(AGENTS_PATH);
  await agents.processors.enable("agents", {
    ...spec,
    consumes: [
      "events.iterate.com/itx/child-created",
      "events.iterate.com/agent/deleted",
      "events.iterate.com/agent/listing-updated",
    ],
  });
  // `/agents` has no link to the root. The collection stores the attachments of a message to an
  // agent of another kind through its own itx (message.ts `appendMessage`), so these two names
  // reach the root's.
  await agents.append(
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: "itx.files",
        target: ["itx", ["cd", "/"], "files"],
        description:
          "The mind's files: the agents collection stores here the attachments of a message to an agent of another kind",
      },
    },
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: "itx.r2",
        target: ["itx", ["cd", "/"], "r2"],
        description:
          "The mind's R2: the mind's files are built on it, and call it through this context's rules",
      },
    },
  );
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
