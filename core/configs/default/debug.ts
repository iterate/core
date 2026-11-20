// debug.ts — `!debug`: a member's quick look at an agent, with no model call. An entry point that
// sees a person's message exactly `!debug` (slack.ts `slackMessageOf`) answers with `debugAnswer`
// where the agent's own replies go, and gives the agent nothing: no turn, no new agent.
//
// What it reads is cheap, and wakes no agent: the mind's address, the agents' catalog, the
// contexts' catalog, and the config repo's tip. The agent's model and its log's head offset are
// left out: only the agent's own state holds them, and a read of that is the whole conversation.

/** The command, as a person types it: the whole message, nothing before or after it. */
export const DEBUG_COMMAND = "!debug";

/** THE ONE LINK TO AN AGENT IN THE DASH: `https://dash.<apex><agent path>`, each segment encoded.
 *  The Dash's addresses are paths (its index.html says `data-addresses="paths"`); when they change,
 *  this function changes, and every entry point follows. */
// Coming form (the Dash route work, not live yet): `https://dash.<apex>/agents?contextPath=<path>`.
export function dashAgentLink(apex: string, agentPath: string) {
  return `https://dash.${apex}${agentPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** How many rows the catalog read asks for: the agent's own row and the contexts below it. */
const CATALOG_ROWS = 50;

/** What `debugAnswer` reads of the mind: the mind's root `itx`. */
type DebugItx = {
  url(): Promise<string>;
  agents: {
    list(): Promise<
      {
        path: string;
        kind: string | null;
        status: string | null;
        createdAt: string;
        lastActivityAt: string | null;
      }[]
    >;
  };
  contexts: {
    list(options: {
      under: string;
      limit: number;
    }): Promise<{ path: string; eventCount: number; lastEventAt?: string }[]>;
  };
  repos: { get(path: string): { tip(): Promise<string | null> } };
};

/** THE ANSWER TO `!debug` FOR ONE AGENT, as plain lines. Each read stands alone: one that fails
 *  says so on its own line, and the others still answer. */
export async function debugAnswer(itx: DebugItx, agentPath: string): Promise<string> {
  const [url, agents, catalog, tip] = await Promise.allSettled([
    itx.url(),
    itx.agents.list(),
    // the catalog, never the context: a read of a context that does not exist makes it
    itx.contexts.list({ under: agentPath, limit: CATALOG_ROWS }),
    itx.repos.get("/repos/config").tip(),
  ]);
  for (const read of [url, agents, catalog, tip])
    if (read.status === "rejected")
      console.warn({ event: "config.debug-read-failed", agentPath, error: String(read.reason) });
  const apex = url.status === "fulfilled" ? new URL(url.value).hostname : null;
  return [
    "Debug info",
    `Agent: \`${agentPath}\``,
    ...agentLines(agentPath, apex, agents, catalog),
    `Mind: ${apex || "(read failed)"}`,
    `Config: ${tip.status === "fulfilled" ? tip.value?.slice(0, 7) || "no commit" : "(read failed)"}`,
  ].join("\n");
}

type ContextRows = Awaited<ReturnType<DebugItx["contexts"]["list"]>>;

/** The lines about the agent itself: its Dash link, its catalog row and its log's size. */
function agentLines(
  agentPath: string,
  apex: string | null,
  agents: PromiseSettledResult<Awaited<ReturnType<DebugItx["agents"]["list"]>>>,
  catalog: PromiseSettledResult<ContextRows>,
): string[] {
  if (agents.status === "rejected") return ["Kind: (read failed)"];
  const agent = agents.value.find((row) => row.path === agentPath);
  if (!agent) return ["No agent here yet: the path above is the one it would have."];
  const kind = [
    agent.kind || "unknown",
    agent.status && `status ${agent.status}`,
    `created ${agent.createdAt}`,
    agent.lastActivityAt && `last active ${agent.lastActivityAt}`,
  ];
  return [
    ...(apex ? [`Dash: ${dashAgentLink(apex, agentPath)}`] : []),
    `Kind: ${kind.filter(Boolean).join(" · ")}`,
    logLine(agentPath, catalog),
  ];
}

/** The agent's log as the contexts' catalog lists it. The catalog lags its contexts: a row it
 *  does not hold yet is no proof of an empty log, so that says "not listed yet", never 0. */
function logLine(agentPath: string, catalog: PromiseSettledResult<ContextRows>) {
  if (catalog.status === "rejected") return "Log: (read failed)";
  const row = catalog.value.find((context) => context.path === agentPath);
  if (!row) return "Log: not listed yet";
  return `Log: ${row.eventCount} events${row.lastEventAt ? `, last event ${row.lastEventAt}` : ""}`;
}
