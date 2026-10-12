// sdk/direct-append.ts — A FACET'S DIRECT APPEND, HELD WHILE USED. Every push a context hands its
// facet carries the context's own `append`, as a function, under the caller the facet's `env.ITX`
// would stamp (core/os iterate-context-durable-object.ts `#directAppendFor`): the facet's engine
// appends through it straight into the context, with no entrypoint invocation and no second hop
// between. A voice agent's speaker frame takes about 0 ms this way, against 4–5 ms at p50 through
// `env.ITX` (measured 2026-10-10), and one sender awaits every frame of a reply.
//
//   • HELD ONLY WHILE USED. A stub handed in a call pins the context's request that exported it for
//     as long as it is held, so a context whose facet kept its append could never be evicted. The
//     facet keeps it DIRECT_APPEND_IDLE_MS past its last use, then lets go; the next push hands it
//     over again.
//   • EACH PUSH'S APPEND REPLACES THE LAST. Every append through one runs in the request that
//     handed it over, and a request's subrequests and CPU are bounded: taking every push's append
//     keeps a request's share to what is appended until the next push. The one it replaces is let
//     go once its own appends settle.

import type { StreamEvent, StreamEventInput } from "../stream/processor.ts";

/** What a context's push hands its facet: its `append`, under why the facet's code runs (`cause`),
 *  answered with the committed events. A Workers-RPC stub of a function, which a call releases when
 *  it ends unless duplicated. */
export type DirectAppend = ((
  cause: unknown,
  events: StreamEventInput[],
) => Promise<StreamEvent[]>) &
  Partial<Disposable> & { dup?(): DirectAppend };

/** How long a facet keeps its direct append past its last use. */
export const DIRECT_APPEND_IDLE_MS = 1_000;

export class DirectAppendHolder {
  /** The append the last push handed in, and how many appends through it are in flight. */
  #held?: { append: DirectAppend; inFlight: number };
  #usedAt = 0;
  #idleCheck?: ReturnType<typeof setTimeout>;

  /** The append a push handed in, in place of the one held: duplicated, as a stub handed in a call
   *  is released when the call ends. The one it replaces goes now, or when its own appends
   *  settle. */
  hold(append: DirectAppend): void {
    const replaced = this.#held;
    this.#held = { append: typeof append.dup === "function" ? append.dup() : append, inFlight: 0 };
    if (replaced?.inFlight === 0) letGo(replaced.append);
    this.#usedAt = Date.now();
    this.#checkWhenIdle();
  }

  /** Whether a push's append is held now. */
  get held(): boolean {
    return this.#held !== undefined;
  }

  /** `events` appended through the held append under `cause`, or undefined when none is held: the
   *  engine then takes its other way. */
  async append(cause: unknown, events: StreamEventInput[]): Promise<StreamEvent[] | undefined> {
    const held = this.#held;
    if (!held) return undefined;
    held.inFlight += 1;
    try {
      return await held.append(cause, events);
    } finally {
      held.inFlight -= 1;
      if (held !== this.#held && held.inFlight === 0) letGo(held.append); // a push replaced it
      this.#usedAt = Date.now();
      this.#checkWhenIdle();
    }
  }

  /** Lets go of the held append once it has been unused for DIRECT_APPEND_IDLE_MS with no append in
   *  flight; an append in flight checks again when it settles. */
  #checkWhenIdle(): void {
    if (this.#idleCheck !== undefined) return;
    this.#idleCheck = setTimeout(
      () => {
        this.#idleCheck = undefined;
        const held = this.#held;
        if (!held || held.inFlight > 0) return;
        if (Date.now() - this.#usedAt < DIRECT_APPEND_IDLE_MS) return this.#checkWhenIdle();
        letGo(held.append);
        this.#held = undefined;
      },
      Math.max(0, this.#usedAt + DIRECT_APPEND_IDLE_MS - Date.now()),
    );
  }
}

const letGo = (append: DirectAppend): void => append[Symbol.dispose]?.();
