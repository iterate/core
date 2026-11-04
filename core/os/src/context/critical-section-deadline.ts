// context/critical-section-deadline.ts — a deadline inside `blockConcurrencyWhile`: what bounds a
// facet start (FacetHost `#restartAll`) and a root's question to the control plane at its first
// birth (IterateContextDurableObject `#refuseBirthOfDeletedProjectRoot`).

/** `ms` from now, a timer of the object; `done` clears it once the wait it bounds is over. A timer
 *  set inside `blockConcurrencyWhile` fires there even while an older timer of the object waits for
 *  the input lock (cloudflare/workerd#7698). A runtime without that starves the timer until it
 *  resets the object at 30 s. Pinned by test/vitest/os-workers/facet-restart-watchdog-starved.test.ts. */
export function criticalSectionDeadline(ms: number, done: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    done.addEventListener("abort", () => clearTimeout(timer));
  });
}
