// backend.ts — THE TELEMETRY APP'S BACKEND: THE DAY'S BUDGET OF THE PAGE RECORDS FROM OUTSIDE, for the whole mind
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
// WHY THIS FILE IS backend.ts: a publication offers a facet's class only from a module at the
// config's root or from an app's `backend.ts` (core/mind-worker/src/mind/publication.ts
// `publishedModules`, apps.md "A backend class"). From any other file the facet fails at its first
// call ("publishes no module"), and every record from outside is dropped. page-events.ts names it
// (`OUTSIDE_DAYS`); worker.ts imports nothing of it.
//
// IT EXPORTS THE CLASS ALONE: workerd takes every export of a facet Worker's main module as an
// entrypoint and does not start a Worker whose main module exports a number ("Incorrect type for
// map entry OUTSIDE_A_DAY", the home lab, 22 Nov 2026). The budget and its statement are in
// ./day-budget.ts. core/mind-worker/src/context/telemetry-facet.test.ts starts this file in workerd.
import { FacetDurableObject } from "iterate/sdk";
import { OUTSIDE_A_DAY, reserveDay } from "./day-budget.ts";

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
