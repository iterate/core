// wake-events.ts — WHAT A HOST WANTS ON EVERY CONTEXT, ALSO ON ONE THAT WAS BORN BEFORE IT WANTED
// IT. A birth event reaches a context once, when it is born (stream.ts `appendBirthRecord`). So
// what a host starts to want later never reaches the contexts that exist: a mind whose telemetry
// was turned on had the row that sends a context's events on the few contexts born after it. A
// wake event is asked for at every wake and lands once: its idempotency key says that the context
// has had it. A context that never wakes again has no new events either.
import type { StreamEventInput } from "iterate/stream/processor";

/**
 * The host's wake events that this wake appends. `hasKey` reads the context's own log.
 * - One whose key the log holds is not appended again. So a row that its owner removed afterwards
 *   stays removed: the host asks once, and the owner has the last word.
 * - A subscription that stands under the same name is not set again: setting a row again starts
 *   its delivery again from the row's first offset. This is a context that got the row at its
 *   birth, with no key. (Its key stays unspent: if its owner removes that row, the next wake sets
 *   it once more, and a second removal stays.)
 * - A paused context is owed nothing: a paused stream takes only its own records, and refuses a
 *   batch that holds anything else. The key stays unspent, so the event lands at the first wake
 *   after the resume.
 *
 * The key alone says that a context has had an event: a host that changes an event's payload
 * under the same key reaches no context that has it. A new payload needs a new key.
 */
export function eventsOwedAtWake(
  events: readonly StreamEventInput[],
  hasKey: (idempotencyKey: string) => boolean,
  subscriptions: readonly string[],
  paused = false,
): StreamEventInput[] {
  if (paused) return [];
  return events.filter((event) => {
    if (!event.idempotencyKey)
      throw new Error(
        `a wake event needs an idempotencyKey, or every wake appends it: ${event.type}`,
      );
    if (hasKey(event.idempotencyKey)) return false;
    const name = Object(event.payload).name;
    return !(
      event.type === "events.iterate.com/itx/subscription-configured" &&
      subscriptions.includes(name)
    );
  });
}
