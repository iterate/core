// agent-catalog.ts — WHICH CONTEXT IS AN AGENT: the catalog on /agents, read in one call, and the
// test of one path against it. api.ts `taskDeps` uses both, since a follower's row writes
// to the path it names.
// @ts-expect-error -- a plain browser module of the Dash, with no types; this file uses `agentPathOf` alone
import { agentPathOf } from "./public/share-links.js";

/** Whether `path` is an agent in the catalog on /agents (its live state `{ agents: { [path]: row } }`):
 *  a row that said what runs it or what it is called. A row with neither is a folder
 *  (@iterate-com/ui lib/agent-summary.ts `folderTest`), and the root and any path outside /agents/
 *  are refused before (`agentPathOf`). */
export function isAgentOf(catalog: unknown, path: string): boolean {
  if (!agentPathOf(path)) return false;
  // the catalog's live state is `unknown` to its reader: iterate/agents writes `agents` as a map
  // from a path to its row, and a state of any other shape has no row for the path
  const agents = (
    catalog as { agents?: Record<string, { kind?: string; title?: string } | null> } | null
  )?.agents;
  const row = agents && Object.hasOwn(agents, path) ? agents[path] : null;
  return Boolean(row && (row.kind || row.title));
}

/** What `agentCatalogOf` reaches of the mind: the catalog's facet on /agents. */
export type CatalogItx = {
  cd(path: string): {
    facets: { get(name: string): { liveSnapshot(): Promise<{ state: unknown }> } };
  };
};

/** The catalog on /agents (its live state), or null. It touches /agents alone. */
export async function agentCatalogOf(itx: CatalogItx): Promise<unknown> {
  try {
    return (await itx.cd("/agents").facets.get("agents").liveSnapshot()).state;
  } catch {
    return null;
  }
}
