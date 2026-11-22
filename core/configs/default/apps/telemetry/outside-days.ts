// outside-days.ts — THE DAY'S BUDGET OF THE PAGE RECORDS FROM OUTSIDE, for the whole mind
// (page-events.md, "Bounds"): the facet `outside-days` on /pages, a SQLite table of its own with
// one row for each UTC day. page-events.ts asks it before it appends ANY record from someone who
// is no member, on both paths: what a page sends (`pageEventsRoute`) and a page counted from its
// request (`pageRequested`).
//
// ONE STATEMENT reserves a batch: it adds the batch's records to the day's sum only when the sum
// stays at most `OUTSIDE_A_DAY`, and answers whether it did. A Durable Object runs one call at a
// time and SQLite runs the statement whole, so two batches at once are counted one after the
// other and none overwrites the other's count: the day NEVER passes the budget, however many
// isolates send. A batch that does not fit is refused whole. Rows of days before yesterday are
// deleted as a batch is counted. The same statement as the auth Worker's
// (core/auth-worker/src/page-events.ts `outsideReserved`), in this mind's own storage.
//
// Nothing loads this file but the platform, when page-events.ts names it (`OUTSIDE_DAYS` there):
// worker.ts imports nothing of it.
import { FacetDurableObject } from "iterate/sdk";

/** THE DAY'S BUDGET of the outside's records, for the whole mind. */
export const OUTSIDE_A_DAY = 20_000;

/** What this file needs of a Durable Object's SQLite (`ctx.storage.sql`). */
export type Sql = {
  exec(query: string, ...bindings: (string | number)[]): { toArray(): unknown[] };
};

/** Reserve `records` records in the budget of `day` (`YYYY-MM-DD`), at most `most` a day: true
 *  when they fit, and then they are counted. */
export function reserveDay(sql: Sql, day: string, records: number, most: number): boolean {
  sql.exec(
    "create table if not exists outside_days (day text primary key, records integer not null)",
  );
  const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  sql.exec("delete from outside_days where day < ?", yesterday);
  return (
    sql
      .exec(
        `insert into outside_days (day, records)
         select ?, ? where ? <= ?
         on conflict (day) do update set records = records + excluded.records
           where records + excluded.records <= ?
         returning records`,
        day,
        records,
        records,
        most,
        most,
      )
      .toArray().length > 0
  );
}

export class OutsideDaysDurableObject extends FacetDurableObject {
  static override publicMethods = [...super.publicMethods, "reserve"];

  /** Reserve `records` (a whole number, 1 to 1,000) in today's budget: true when they fit. Any
   *  other count is refused. */
  reserve(records: unknown): boolean {
    if (typeof records !== "number" || !Number.isInteger(records) || records < 1 || records > 1_000)
      return false;
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    return reserveDay(this.ctx.storage.sql, day, records, OUTSIDE_A_DAY);
  }
}
