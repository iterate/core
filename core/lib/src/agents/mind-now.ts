// mind-now.ts — the text of the mind-now note (processor.ts `#noteTheMind` says when it is
// written), made from the catalog's rows, and `agentAtWork`, the one rule for whether a row's
// agent is at work, which the note and the Agents app's rows share. The model reads many of these
// notes, so the shape is compact and stays the same. Nothing here needs a Worker: a browser imports
// it as `iterate/agents/mind-now`.
import { RUN_DEADLINE_MS } from "../stream/run.ts";
import type { AgentListing } from "./api.ts";

/** At most this many rows; the rest are counted. */
const MAX_ROWS = 12;
/** Each row is cut to about this many characters: the title and the activity are cut, never the path. */
const ROW_CHARS = 160;
const HOUR_MS = 3_600_000;
/** A row still says `working` or `waiting` this long after its last activity; older, it is stale
 *  (an agent that stopped without saying so, a thread nobody answered) and counts as idle. */
const LIVE_STATUS_MS = 24 * HOUR_MS;

/** WHETHER AN AGENT IS AT WORK, by its catalog row: it says `working` or `waiting` (within a day),
 *  or it says `idle` with an `activity` line from the last RUN_DEADLINE_MS. The second case is a
 *  script at work: an iterate agent's row says `idle` once a model answer settles, before the
 *  script that answer called runs, and its activity is that script's status label (collection.ts
 *  `catalog-status`, `catalog-summary`). A script runs at most RUN_DEADLINE_MS. So a turn that ended
 *  a moment ago also counts, with its last line, for up to that long. */
export function agentAtWork(
  row: Pick<AgentListing, "status" | "activity" | "lastActivityAt">,
  now: number,
): boolean {
  const since = now - (row.lastActivityAt ? Date.parse(row.lastActivityAt) : 0);
  if (row.status === "working" || row.status === "waiting") return since < LIVE_STATUS_MS;
  return row.status === "idle" && Boolean(row.activity) && since < RUN_DEADLINE_MS;
}

/** The note's text for the agent at `self`, from the catalog's rows: the other agents at work
 *  (`agentAtWork`) first, then the others active in the last hour, newest first in each group. Each
 *  row shows the catalog's own status. Null when no other agent was active in the last hour: then
 *  there is nothing to say. */
export function mindNowNote(
  rows: AgentListing[],
  { self, now }: { self: string; now: number },
): string | null {
  const at = (row: AgentListing) => (row.lastActivityAt ? Date.parse(row.lastActivityAt) : 0);
  const live = (row: AgentListing) => agentAtWork(row, now);
  const others = rows.filter((row) => row.path !== self);
  if (!others.some((row) => now - at(row) < HOUR_MS)) return null;
  const shown = others
    .filter((row) => live(row) || now - at(row) < HOUR_MS)
    .sort((a, b) => Number(live(b)) - Number(live(a)) || at(b) - at(a));
  const active = shown.filter(live).length;
  const lines = [
    `[the mind now, ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC] ${String(active)} other ${active === 1 ? "agent is" : "agents are"} at work. \`await itx.agents.list()\` is this list, live; \`await itx.agents.get(path).recent()\` is what one of them did lately.`,
    ...shown.slice(0, MAX_ROWS).map((row) => mindNowRow(row, now)),
  ];
  if (shown.length > MAX_ROWS)
    lines.push(`…and ${String(shown.length - MAX_ROWS)} more that were active in the last hour.`);
  return lines.join("\n");
}

/** One row: status, whole path, who runs it when that is not iterate, then the title and activity,
 *  cut so the row stays about ROW_CHARS long, and how long ago it was active. */
function mindNowRow(row: AgentListing, now: number): string {
  const runner =
    row.kind && row.kind !== "iterate" ? `  ${row.kind}${row.host ? ` on ${row.host}` : ""}` : "";
  const head = `${(row.status || "idle").padEnd(8)} ${row.path}${runner}`;
  const tail = row.lastActivityAt ? ` (${ago(now - Date.parse(row.lastActivityAt))})` : "";
  const body = [row.title && `"${oneLine(row.title)}"`, row.activity && oneLine(row.activity)]
    .filter(Boolean)
    .join(": ");
  const room = ROW_CHARS - head.length - tail.length - 2;
  if (!body || room < 8) return head + tail;
  return `${head}  ${body.length > room ? `${body.slice(0, room - 1)}…` : body}${tail}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function ago(ms: number): string {
  if (ms < 60_000) return "now";
  if (ms < HOUR_MS) return `${String(Math.floor(ms / 60_000))} min ago`;
  return `${String(Math.floor(ms / HOUR_MS))} h ago`;
}
