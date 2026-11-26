// context-catalog.ts — THE MIND'S CATALOG OF ITS CONTEXTS: one SQLite row per context, in the
// storage of the context that accepts the awake sockets (awake.ts). A row is the newest summary
// its context sent (context-summary.ts). A list joins the rows with the open sockets, so "awake"
// and live `activities` are never stored in SQLite: when a socket closes, both vanish at once.
import { z } from "zod";
import type { ContextListing, ContextListOptions } from "iterate/api";
import type { AwakeContextState } from "./awake.ts";
import { activeContextActivities, ContextActivity } from "./context-activity-stack.ts";
import { ContextSummary } from "./context-summary.ts";

/** Durable fields stored in SQLite `context_catalog.summary` (never live `activities`). */
const StoredContextSummary = ContextSummary.extend({
  processors: z.array(z.string()),
  storageBytes: z.number().int().nonnegative(),
});

/** What a context sends over its awake socket: its durable summary plus live in-memory activities. */
export const ContextSummaryMessage = StoredContextSummary.extend({
  activities: z.array(ContextActivity).optional(),
});
export type ContextSummaryMessage = z.infer<typeof ContextSummaryMessage>;

export class ContextCatalog {
  readonly #sql: SqlStorage;
  #tableMade = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #table(): void {
    if (this.#tableMade) return;
    // `active_at` is what a list sorts by: the newest activity, or the newest event without one
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS context_catalog (
         path TEXT PRIMARY KEY,
         through_offset INTEGER NOT NULL,
         active_at TEXT NOT NULL,
         summary TEXT NOT NULL
       )`,
    );
    this.#sql.exec(
      "CREATE INDEX IF NOT EXISTS context_catalog_active_at ON context_catalog (active_at DESC)",
    );
    this.#tableMade = true;
  }

  /** Keeps the durable part of `message` as `path`'s row unless the row is of a later offset, and
   *  returns the live `activities` carried on the message so the caller can attach them to the
   *  open awake socket (never SQLite). A message that is no summary is refused with a thrown error. */
  store(path: string, message: string): ContextActivity[] | undefined {
    const { activities, ...durable } = ContextSummaryMessage.parse(JSON.parse(message));
    this.#table();
    this.#sql.exec(
      `INSERT INTO context_catalog (path, through_offset, active_at, summary) VALUES (?, ?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET
         through_offset = excluded.through_offset,
         active_at = excluded.active_at,
         summary = excluded.summary
       WHERE excluded.through_offset >= context_catalog.through_offset`,
      path,
      durable.throughOffset,
      durable.lastActivityAt || durable.lastEventAt || "",
      JSON.stringify(durable),
    );
    return activities;
  }

  /** The contexts that match, the most recently active first. `awake` is the open sockets, by
   *  path, with their live in-memory activities. Sleeping contexts never carry `activities`. */
  list(
    options: ContextListOptions,
    awake: ReadonlyMap<string, AwakeContextState>,
    now = Date.now(),
  ): ContextListing[] {
    this.#table();
    const limit = Math.min(Math.max(1, options.limit ?? 200), 1_000);
    const terms = (options.search || "").toLowerCase().split(/\s+/).filter(Boolean);
    const under = options.under && options.under !== "/" ? options.under : undefined;
    const matchesPath = (path: string) => !under || path === under || path.startsWith(`${under}/`);
    const where: string[] = [];
    const bindings: (string | number)[] = [];
    if (under) {
      where.push("(path = ? OR substr(path, 1, ?) = ?)");
      bindings.push(under, under.length + 1, `${under}/`);
    }
    for (const term of terms) {
      where.push("(instr(lower(path), ?) > 0 OR instr(lower(summary), ?) > 0)");
      bindings.push(term, term);
    }
    if (options.awake) {
      const paths = [...awake.keys()].filter(matchesPath);
      if (paths.length === 0) return [];
      where.push(`path IN (SELECT value FROM json_each(?))`);
      bindings.push(JSON.stringify(paths));
    }
    const rows = this.#sql
      .exec<{ path: string; summary: string }>(
        `SELECT path, summary FROM context_catalog
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY active_at DESC, path LIMIT ?`,
        ...bindings,
        limit,
      )
      .toArray();
    const toListing = (path: string, summaryJson: string): ContextListing => {
      const { throughOffset: _, ...stored } = StoredContextSummary.parse(JSON.parse(summaryJson));
      const awakeState = awake.get(path);
      if (!awakeState) return { path, ...stored };
      const liveActivities = activeContextActivities(awakeState.activities, now);
      return {
        path,
        ...stored,
        awake: { since: awakeState.since },
        ...(liveActivities.length > 0 && { activities: liveActivities }),
      };
    };
    const toUnlistedAwake = (path: string): ContextListing => {
      const awakeState = awake.get(path);
      const liveActivities = activeContextActivities(awakeState?.activities, now);
      return {
        path,
        awake: { since: awakeState?.since ?? now },
        eventCount: 0,
        eventTypes: {},
        recentTypes: [],
        processors: [],
        ...(liveActivities.length > 0 && { activities: liveActivities }),
      };
    };
    const listed = rows.map(({ path, summary }) => toListing(path, summary));
    const candidates = [...awake.keys()].filter(matchesPath);
    if (candidates.length === 0) return listed;

    const storedRows = this.#sql
      .exec<{ path: string; summary: string }>(
        "SELECT path, summary FROM context_catalog WHERE path IN (SELECT value FROM json_each(?))",
        JSON.stringify(candidates),
      )
      .toArray();
    const storedByPath = new Map(storedRows.map((row) => [row.path, row.summary]));

    if (terms.length > 0) {
      const listedPaths = new Set(listed.map((row) => row.path));
      const extraAwakeMatches: ContextListing[] = [];
      for (const path of candidates) {
        if (listedPaths.has(path)) continue;
        const storedSummary = storedByPath.get(path);
        const candidateListing = storedSummary
          ? toListing(path, storedSummary)
          : toUnlistedAwake(path);
        const haystack = [
          path,
          storedSummary || "",
          ...(candidateListing.activities || []).flatMap((item) => [
            item.text,
            item.key,
            ...(item.tags || []),
          ]),
        ]
          .join(" ")
          .toLowerCase();
        if (terms.every((term) => haystack.includes(term))) {
          extraAwakeMatches.push(candidateListing);
        }
      }
      return [...extraAwakeMatches, ...listed].slice(0, limit);
    }

    // An awake context with no row at all: one that has a row past this page is not one.
    const unlisted = candidates.filter((path) => !storedByPath.has(path)).map(toUnlistedAwake);
    return [...unlisted, ...listed].slice(0, limit);
  }
}
