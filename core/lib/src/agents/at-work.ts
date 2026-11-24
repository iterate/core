// at-work.ts — WHETHER AN AGENT IS AT WORK, by its catalog row: the one rule that the Dash's rows
// share. Nothing here needs a Worker: a browser imports it as `iterate/agents/at-work`.
import { RUN_DEADLINE_MS } from "../stream/run.ts";
import type { AgentListing } from "./api.ts";

/** A row still says `working` or `waiting` this long after its last activity; older, it is stale
 *  (an agent that stopped without saying so, a thread nobody answered) and counts as idle. */
const LIVE_STATUS_MS = 24 * 3_600_000;

/** The row says `working` or `waiting` (within a day), or it says `idle` with an `activity` line
 *  from the last RUN_DEADLINE_MS. The second case is a script at work: the row of the mind's own
 *  agent says `idle` once a model's answer settles, before the script of that answer runs, and its
 *  activity is what that script says it does. A script runs at most RUN_DEADLINE_MS. So an agent
 *  that stopped a moment ago also counts, with its last line, for up to that long. */
export function agentAtWork(
  row: Pick<AgentListing, "status" | "activity" | "lastActivityAt">,
  now: number,
): boolean {
  const since = now - (row.lastActivityAt ? Date.parse(row.lastActivityAt) : 0);
  if (row.status === "working" || row.status === "waiting") return since < LIVE_STATUS_MS;
  return row.status === "idle" && Boolean(row.activity) && since < RUN_DEADLINE_MS;
}
