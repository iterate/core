// context-catalog.ts — THE MIND'S CATALOG OF ITS CONTEXTS: one SQLite row per context, in the
// storage of the context that accepts the awake sockets (awake.ts). A row is the newest summary
// its context sent (context-summary.ts). A list joins the rows with the open sockets, so "awake"
// is never stored. The catalog is a copy: every row can be made again from its context's own log.
import { z } from "zod";
import type { ContextListing, ContextListOptions } from "iterate/api";
import { ContextSummary } from "./context-summary.ts";

/** What a context sends: its folded summary, and what it reads off itself at that moment. */
export const ContextSummaryMessage = ContextSummary.extend({
  processors: z.array(z.string()),
  storageBytes: z.number().int().nonnegative(),
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

  /** Keeps `message` as `path`'s row unless the row is of a later offset. A message that is no
   *  summary is refused with a thrown error, which its caller logs. */
  store(path: string, message: string): void {
    const summary = ContextSummaryMessage.parse(JSON.parse(message));
    this.#table();
    this.#sql.exec(
      `INSERT INTO context_catalog (path, through_offset, active_at, summary) VALUES (?, ?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET
         through_offset = excluded.through_offset,
         active_at = excluded.active_at,
         summary = excluded.summary
       WHERE excluded.through_offset >= context_catalog.through_offset`,
      path,
      summary.throughOffset,
      summary.lastActivityAt || summary.lastEventAt || "",
      JSON.stringify(summary),
    );
  }

  /** The contexts that match, the most recently active first. `awake` is the open sockets, by
   *  path. An awake context with no row yet (its first wake) is listed with what is known. */
  list(options: ContextListOptions, awake: ReadonlyMap<string, number>): ContextListing[] {
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
    const listed = rows.map(({ path, summary }): ContextListing => {
      const { throughOffset: _, ...stored } = ContextSummaryMessage.parse(JSON.parse(summary));
      const since = awake.get(path);
      return { path, ...stored, ...(since !== undefined && { awake: { since } }) };
    });
    if (terms.length > 0) return listed;
    // An awake context with no row at all: one that has a row past this page is not one.
    const candidates = [...awake.keys()].filter(matchesPath);
    const stored = new Set(
      this.#sql
        .exec<{ path: string }>(
          "SELECT path FROM context_catalog WHERE path IN (SELECT value FROM json_each(?))",
          JSON.stringify(candidates),
        )
        .toArray()
        .map((row) => row.path),
    );
    const unlisted = candidates
      .filter((path) => !stored.has(path))
      .map((path): ContextListing => ({
        path,
        awake: { since: awake.get(path) ?? Date.now() },
        eventCount: 0,
        eventTypes: {},
        recentTypes: [],
        processors: [],
      }));
    return [...unlisted, ...listed].slice(0, limit);
  }
}
