// day-budget.ts — THE DAY'S BUDGET OF THE PAGE RECORDS FROM OUTSIDE, and the one statement that
// reserves a batch in it: the facet `outside-days` (./backend.ts) runs it on its own SQLite. It is
// a module of its own because backend.ts is a facet Worker's main module, and workerd takes every
// export of a main module as an entrypoint: a number or a plain function exported there stops the
// Worker from starting ("Incorrect type for map entry OUTSIDE_A_DAY", the home lab, 22 Nov 2026).

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
