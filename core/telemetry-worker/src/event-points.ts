// event-points.ts — A MIND'S EVENTS AS POINTS OF THE STACK'S ANALYTICS ENGINE DATASET: one
// `event.committed` point for each context path and event type of a batch, in the kernel's layout
// (core/itx/src/metrics.ts), so `metrics` counts the mind's events with no token.
import type { EventsRow } from "./events-row.ts";

// Analytics Engine takes 250 data points an invocation, and loses the rest with a throw
export const EVENT_POINTS_MAX = 200;

export const OTHER_TYPES = "(other)";

type Group = { path: string; type: string; count: number; bytes: number };

/** The busiest groups first. Past EVENT_POINTS_MAX, the quietest groups of a path fold into one
 *  `(other)` point of that path; past that, the quietest fold points are dropped. */
export function eventPoints(rows: Pick<EventsRow, "path" | "type" | "payload_bytes">[]) {
  const groups = summed(rows.map((row) => ({ ...row, count: 1, bytes: row.payload_bytes })));
  if (groups.length <= EVENT_POINTS_MAX) return { points: groups.map(point), dropped: 0 };
  // the most groups kept whole, so that they and the fold points of the rest fit
  const pathsFrom = distinctPathsOfEachSuffix(groups);
  let whole = EVENT_POINTS_MAX;
  while (whole > 0 && whole + pathsFrom[whole]! > EVENT_POINTS_MAX) whole--;
  const folded = summed(groups.slice(whole).map((group) => ({ ...group, type: OTHER_TYPES })));
  const kept = folded.slice(0, EVENT_POINTS_MAX - whole);
  const dropped = folded.slice(kept.length).reduce((sum, group) => sum + group.count, 0);
  return { points: [...groups.slice(0, whole), ...kept].map(point), dropped };
}

/** Never throws: the stream's send is what a delivery waits on, and a lost point only undercounts. */
export function writeEventPoints(
  dataset: Pick<AnalyticsEngineDataset, "writeDataPoint">,
  rows: Pick<EventsRow, "path" | "type" | "payload_bytes">[],
) {
  const { points, dropped } = eventPoints(rows);
  let lost = dropped;
  let error: string | undefined;
  for (const each of points) {
    try {
      dataset.writeDataPoint(each);
    } catch (thrown) {
      lost += each.doubles[0]!;
      error ||= String(thrown);
    }
  }
  if (lost > 0)
    console.warn({
      event: "telemetry.event-points-dropped",
      message: `events past ${EVENT_POINTS_MAX} points a call, or whose write threw, are not counted in metrics`,
      count: lost,
      error,
    });
}

function summed(groups: Group[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const { path, type, count, bytes } of groups) {
    const key = JSON.stringify([path, type]);
    const group = byKey.get(key);
    if (group) {
      group.count += count;
      group.bytes += bytes;
    } else byKey.set(key, { path, type, count, bytes });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

/** At index i, how many paths the groups from i to the end have. */
function distinctPathsOfEachSuffix(groups: Group[]) {
  const counts = Array.from<number>({ length: groups.length + 1 }).fill(0);
  const seen = new Set<string>();
  for (let index = groups.length - 1; index >= 0; index--) {
    seen.add(groups[index]!.path);
    counts[index] = seen.size;
  }
  return counts;
}

function point({ path, type, count, bytes }: Group) {
  return { indexes: [path], blobs: ["event.committed", path, type], doubles: [count, bytes] };
}
