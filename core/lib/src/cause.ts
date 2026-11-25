// cause.ts — the SDK's half of the loop guard, INTERNAL: no export names it and no signature takes
// it (core/itx/src/cause.ts explains the guard). A host's `callWithCause` (every loaded entrypoint
// has one, sdk/loaded-worker.ts), and its `fetch` under a Request's mark, run their code under the
// cause the platform handed them, and this carries that cause, unread, to every `getItx` scope
// and, in a loaded isolate, every outbound `fetch`.
// Any other code runs, in a loaded isolate, under the newest cause its isolate saw, and in the
// platform's own, shared by every mind, under none. Shared by name
// (`Symbol.for("iterate.cause")`), so every copy of the SDK in an isolate reaches the same one.

// The SDK is typed against the Cloudflare types, never Node's: workerd hands this module to loaded
// workers under `nodejs_als` alone (core/mind-worker/src/context/worker-loader.ts), Node to the unit tests.
// @ts-ignore -- without Node's types the import has none; it is typed right below
import { AsyncLocalStorage as NodeAsyncLocalStorage } from "node:async_hooks";
import { ITERATE_CAUSE_HEADER, loopLimitOf } from "./lib.ts";

type Carrier = {
  run<T>(cause: unknown, code: () => T, newest?: "clear"): T;
  current(): unknown;
  carryOnFetch(): void;
};

const carrier = ((globalThis as Record<symbol, Carrier | undefined>)[
  Symbol.for("iterate.cause")
] ??= newCarrier());

function newCarrier(): Carrier {
  const AsyncLocalStorage = NodeAsyncLocalStorage as new <T>() => {
    run<R>(store: T, code: () => R): R;
    getStore(): T | undefined;
  };
  const running = new AsyncLocalStorage<{ cause: unknown }>();
  /** Set in a loaded isolate (`carryOnFetch`): only there is the newest cause kept. */
  let loaded = false;
  let newest: unknown;
  const current = () => {
    const store = running.getStore();
    return store ? store.cause : newest;
  };
  return {
    run(cause, code, clear) {
      // what a call needs only for itself (its hops, the delivery its writes are keyed by) is not
      // kept; the cause is carried unread (`unknown`), so only the fields kept are named
      const { chain, depth, at, parent } = (cause ?? {}) as {
        chain?: unknown;
        depth?: unknown;
        at?: unknown;
        parent?: unknown;
      };
      if (loaded) newest = clear || chain === undefined ? undefined : { chain, depth, at, parent };
      return running.run({ cause }, code);
    },
    current,
    carryOnFetch() {
      if (loaded) return;
      loaded = true;
      const outbound = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const mark = causeMarkOf(current());
        if (mark) request.headers.set(ITERATE_CAUSE_HEADER, mark);
        const answer = await outbound(request);
        // a request refused past the loop limit answers 508, marked: it throws as the refusal it is
        const refused = await loopLimitOf(answer);
        if (refused) throw refused;
        return answer;
      };
    },
  };
}

/** THE MARK OF `cause` that a Request carries in `ITERATE_CAUSE_HEADER`, or none. The cause is
 *  carried unread, so its fields are read here alone: the mark, never what only a call needs (the
 *  delivery its writes are keyed by). A header is bytes, so a parent in other characters than
 *  printable ASCII stays behind. */
export function causeMarkOf(cause: unknown): string | undefined {
  // the cast: a cause is the platform's object, carried unread (`Carrier.current`)
  const carried = cause as
    | { chain?: unknown; depth?: unknown; at?: unknown; hops?: unknown; parent?: unknown }
    | undefined;
  if (!carried) return undefined;
  const { chain, depth, at, hops, parent } = carried;
  const ascii = typeof parent === "string" && /^[\x20-\x7e]*$/.test(parent);
  return JSON.stringify({ chain, depth, at, hops, ...(ascii && { parent }) });
}

/** Run `code` under `cause` — the platform's word for why, or none (the platform then begins a
 *  chain for what it does). `"clear"`: a request's fetch leaves no newest cause behind, so code
 *  outside any call after it runs under none (a visitor's request and the mind's own alike). */
export const runCausedBy = <T>(cause: unknown, code: () => T, newest?: "clear"): T =>
  carrier.run(cause, code, newest);

/** The cause the running code runs under, for the platform. */
export const currentCause = (): unknown => carrier.current();

/** In a LOADED isolate: every outbound `fetch` carries the cause it runs under (the platform's
 *  egress turns it into our mark) — installed before any of the loaded code's own module runs
 *  (sdk/loaded-worker.ts); the platform's isolate never is. */
export const carryCauseOnFetch = (): void => carrier.carryOnFetch();

/** The cause a Request carries, or none. */
export function causeOfRequest(request: Request): unknown {
  try {
    return JSON.parse(request.headers.get(ITERATE_CAUSE_HEADER) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}
