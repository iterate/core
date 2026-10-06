// context/critical-section-deadline.ts — a deadline that holds inside `blockConcurrencyWhile`: what
// bounds a facet start (FacetHost `#restartAll`) and a root's question to the control plane at its
// first birth (IterateContextDurableObject `#refuseBirthOfDeletedProjectRoot`).

import { WorkerEntrypoint } from "cloudflare:workers";

/** THE CLOCK inside `blockConcurrencyWhile`: the answer to a request through `ctx.exports`, `?ms=`
 *  after it was sent. No timer of the object can be that clock. workerd arms only an object's
 *  earliest timer, and a timer set before `blockConcurrencyWhile` that comes due inside it waits for
 *  the input lock and holds every later one (io-context.c++ `setTimeoutImpl`, `resetTimerTask`),
 *  until the runtime resets the object at 30 s. A request the critical section sent is I/O, which
 *  reaches it whatever the timers do. Remove with the `createFailing` pin in
 *  test/vitest/os-workers/facet-restart-watchdog-starved.test.ts. */
export class CriticalSectionDeadline extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const ms = Number(new URL(request.url).searchParams.get("ms"));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return new Response(null, { status: 204 });
  }
}

/** `ms` from now, as `CriticalSectionDeadline`'s answer through `exports` (the object's
 *  `ctx.exports`). Async, so a missing export rejects in here and never throws into the critical
 *  section's callback. A request that fails, or answers other than 204, is logged, and a timer of
 *  the object ends the window: a bound that can starve. `done` aborts it once the wait it bounds is
 *  over, which is no failure. `name` is the object's, for the log. */
export async function criticalSectionDeadline(
  exports: DurableObjectState["exports"],
  ms: number,
  done: AbortSignal,
  name: string,
): Promise<void> {
  const until = Date.now() + ms;
  try {
    // The cast: `Cloudflare.Exports` is `{}` without a generated `GlobalProps`, and worker.ts
    // exports `CriticalSectionDeadline`, a `WorkerEntrypoint`, whose loopback stub is a Fetcher.
    const { CriticalSectionDeadline: clock } = exports as unknown as {
      CriticalSectionDeadline: Fetcher;
    };
    const response = await clock.fetch(`https://critical-section-deadline.internal/?ms=${ms}`, {
      signal: done,
    });
    if (response.status === 204) return;
    throw new Error(`the clock answered ${response.status}`);
  } catch (error) {
    if (done.aborted) return;
    console.warn({
      event: "critical-section-deadline.platform-failure-fetch",
      namespace: "iterate-context",
      name,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, until - Date.now());
    done.addEventListener("abort", () => clearTimeout(timer));
  });
}
