// The loop guard, explained here only:
// 1. Depth goes up by one only where code runs because of an event or other code (a delivery, a
//    script run), and the clock takes it down (`oneStepDeeper`). Past LOOP_DEPTH_LIMIT code may
//    read, but every act is refused LOOP_LIMIT, and the context records one `itx/loop-limit` per chain.
// 2. One call crosses at most MAX_CONTEXT_HOPS contexts. Hops ride the call, never an event.
// 3. What code writes while it handles a delivery is keyed by it (`writeKey`), so a retry never
//    repeats what an attempt before it did.
// 4. At a mind's edge the kernel reads one mark: the mind's own request to one of its hosts
//    resumes the chain (`causeOfOwnRequest`). A request from outside begins a chain, though one
//    that leaves carries ours (iterate/lib `leavingTheStack`).

import {
  codedError,
  errorCode,
  ITERATE_CAUSE_HEADER,
  ITX_OWN_HEADER,
  oneStepDeeper,
} from "iterate/lib";
import { z } from "zod";

export type Cause = {
  chain: string;
  depth: number;
  at?: number;
  /** `<path>@<offset>` of the event whose handling this work runs for. */
  parent?: string;
  hops?: number;
  // Call-only, never from a mark or stored.
  writeKey?: string;
  onBehalfOf?: string;
};

const LOOP_DEPTH_LIMIT = 16;
const MAX_CONTEXT_HOPS = 16;
// Printable ASCII, so the mark is plain JSON on any header. The origin names what began the chain,
// never who. The mark is unsigned: forging it can only make the forger's own request deeper.
export function newChain(origin: string): Cause {
  const nonce = Math.random().toString(36).slice(2, 7);
  return {
    chain: `${new Date().toISOString()} with ${origin.slice(0, 200).replace(/[^\x20-\x7e]/g, "?")} ~${nonce}`,
    depth: 0,
    at: Date.now(),
  };
}

/** THE CAUSE OF THE MIND'S OWN REQUEST to one of its hosts (`ITX_OWN_HEADER`, the boundary's
 *  word) that its code's fetch NAMED: our mark one step deeper, so the chain that sent it goes on.
 *  The kernel's egress writes the host it sends to into the mark (`to`), and only that host resumes.
 *  THE TWO WAYS A REDIRECT IS FOLLOWED DIFFER. Over the kernel's `itx.fetch`, the Door's binding
 *  follows it with a second call that carries the first leg's mark, so it resumes nothing, also
 *  from one own host to another (an apex to its www). Over a loaded Worker's own global `fetch`,
 *  the runtime follows it with a second fetch of the context (`ItxEntrypoint.fetch`): that is a
 *  fetch the code made, its context's rule for `itx.fetch` decides it, and it resumes at the true
 *  depth plus one. On neither path can the host that answers state a depth, a chain or a parent.
 *  Any other request, and a mark of any other form, with no chain or for another host, has none,
 *  and begins a chain as before: the boundary and the mind Worker take a caller's mark off
 *  (core/boundary-worker/src/stamp.ts, core/mind-worker/src/http.ts `hostRequestOf`), so no
 *  visitor's mark goes in. A count past the limit is cut to the limit plus one, and a time ahead of the clock to
 *  now, so no mark stops the clock or overflows.
 *  KNOWN: inside one mind a cause is its code's own word, so code that may fetch an own host can
 *  make the app's handler there work at a depth of its choosing. An event that the app stores at
 *  the limit has its delivery refused, and the batch rule can then skip its neighbours' reactions
 *  on the app's contexts. Calls could do this before (a cause rides a call); own requests now can
 *  too. The batch rule is the fault, and its change belongs to the next design.
 *  NOT ENDED: an app whose handler is a plain WorkerEntrypoint, not one of the SDK's two classes,
 *  runs its fetch outside a scope, so a chain through it begins again (the config worker's apps
 *  are fetch modules behind the SDK's entrypoint, and are counted). The SDK's fetch leaves no
 *  newest cause in its isolate (iterate/lib `runCausedBy`), so an own request's depth stays with
 *  its own handling. */
export function causeOfOwnRequest(headers: Headers, host: string): Cause | undefined {
  if (headers.get(ITX_OWN_HEADER) !== "1") return undefined;
  const written = headers.get(ITERATE_CAUSE_HEADER);
  if (!written || written.length > OWN_MARK_LENGTH_LIMIT) return undefined;
  let fields: unknown;
  try {
    fields = JSON.parse(written);
  } catch {
    return undefined;
  }
  const mark = parseCause(fields);
  if (!mark?.chain) return undefined;
  // the cast: the mark parsed as `WrittenCause`, a zod object, so `fields` is an object
  const { to } = fields as { to?: unknown };
  if (typeof to !== "string" || sameHost(to) !== sameHost(host)) return undefined;
  // A request is a new call, so its hops begin at 0: they ride one call alone. The parent goes
  // into the events that the app appends, so it is taken only as `causeHeader` writes it.
  const { chain, parent } = mark;
  const now = Date.now();
  return oneStepDeeper({
    chain,
    depth: Math.min(mark.depth, LOOP_DEPTH_LIMIT + 1),
    at: Math.min(mark.at ?? now, now),
    parent: parent && PRINTABLE_ASCII.test(parent) ? parent : undefined,
  });
}

/** The longest own mark read. Ours is under 2,500 characters even when every character of its
 *  chain and parent (512 each) is escaped, with a hostname of 253 and its counts. */
const OWN_MARK_LENGTH_LIMIT = 4096;

export function deepestCause(causes: readonly (Cause | undefined)[]): Cause | undefined {
  let deepest: Cause | undefined;
  for (const cause of causes)
    if (cause && (!deepest || cause.depth > deepest.depth)) deepest = cause;
  return deepest;
}

export function causeOfDelivery(
  events: readonly { path?: string; offset?: number; source?: { cause?: Cause } }[],
): Cause {
  let deepest = events[0];
  for (const event of events)
    if ((event.source?.cause?.depth ?? -1) > (deepest?.source?.cause?.depth ?? -1)) deepest = event;
  const cause = deepest?.source?.cause || newChain("an event that names no cause");
  const parent =
    deepest?.path && deepest.offset ? `${deepest.path}@${deepest.offset}` : cause.parent;
  const { depth, at } = oneStepDeeper(cause);
  return { chain: cause.chain, depth, at, parent };
}

// No `parent` key without one, so an event reads the same live as stored.
export function storedCause({ chain, depth, at, parent }: Cause): Cause {
  const stored: Cause = { chain, depth };
  if (at !== undefined) stored.at = at;
  if (parent) stored.parent = parent;
  return stored;
}

export function refuseActPastLimit(cause: Cause | undefined, act: string): void {
  if (cause && cause.depth > LOOP_DEPTH_LIMIT)
    throw codedError(
      "LOOP_LIMIT",
      `${act} refused: it is ${cause.depth} steps into a chain of reactions that began ${cause.chain}${cause.writeKey ? `, handed on by the row "${cause.writeKey.split(":")[0]}"` : ""}. Past ${LOOP_DEPTH_LIMIT} steps, code that reacts to other code may read but not act — something here reacts to its own output`,
      { chain: cause.chain, depth: cause.depth } satisfies Refusal,
    );
}

type Refusal = { chain: string; depth: number; recorded?: true };

export function recordRefusal(
  error: unknown,
  record: (cause: Cause, message: string) => void,
): void {
  if (errorCode(error) !== "LOOP_LIMIT") return;
  // Marked in place, so the same error met again is recorded no more. The SDK's carries no chain.
  const refusal = (error as { data?: Refusal }).data;
  if (!refusal?.chain || refusal.recorded) return;
  record(
    { chain: refusal.chain, depth: refusal.depth },
    error instanceof Error ? error.message : String(error),
  );
  refusal.recorded = true;
}

// A plain failure, not the loop's end: a delivery through looping rules is tried again.
export function crossingOneMore(cause: Cause, into: string, contexts = 1): Cause {
  const hops = (cause.hops ?? 0) + contexts;
  if (hops > MAX_CONTEXT_HOPS)
    throw new Error(
      `${into} refused: one call crossed more than ${MAX_CONTEXT_HOPS} contexts in the chain that began ${cause.chain} — rules, rows or requests that lead back into each other`,
    );
  return { ...cause, hops };
}

/** `to`: the host that egress sends the request to, for `causeOfOwnRequest` alone. */
export function causeHeader({ chain, depth, at, hops, parent }: Cause, to?: string): string {
  return JSON.stringify({
    chain,
    depth,
    at,
    hops: hops ?? 0,
    ...(parent && PRINTABLE_ASCII.test(parent) && { parent }),
    to,
  });
}

/** A hostname as DNS compares it: in any letter case, with or without its trailing dot. */
const sameHost = (host: string) => host.toLowerCase().replace(/\.$/, "");

export function requestCausedBy(request: Request, cause: Cause): Request {
  const headers = new Headers(request.headers);
  headers.set(ITERATE_CAUSE_HEADER, causeHeader(cause));
  return new Request(request, { headers });
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const CauseCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// A chain the platform mints is printable ASCII, so any other is forged.
const WrittenCause = z.object({
  chain: z.string().max(512).regex(PRINTABLE_ASCII),
  depth: CauseCount,
  at: CauseCount.optional().catch(undefined),
  parent: z.string().max(512).optional().catch(undefined),
  hops: CauseCount.nullish(),
  writeKey: z.string().max(512).optional().catch(undefined),
  onBehalfOf: z.string().max(4096).optional().catch(undefined),
});

// Anyone may write a cause, so a malformed one is none, and a mark keys no writes.
export function parseCause(value: unknown): Cause | undefined {
  const mark = typeof value === "string";
  let fields = value;
  if (mark)
    try {
      fields = JSON.parse(value);
    } catch {
      return undefined;
    }
  const written = WrittenCause.safeParse(fields);
  if (!written.success) return undefined;
  const { chain, depth, at, parent, hops, writeKey, onBehalfOf } = written.data;
  return {
    chain,
    depth,
    at,
    parent,
    hops: hops || 0,
    ...(!mark && writeKey && { writeKey }),
    ...(!mark && onBehalfOf && { onBehalfOf }),
  };
}

const sdkCarrier = () =>
  (globalThis as Record<symbol, SdkCarrier | undefined>)[Symbol.for("iterate.cause")];
type SdkCarrier = { run<T>(cause: unknown, code: () => T): T; current(): unknown };

export function runningCause(): Cause | undefined {
  return parseCause(sdkCarrier()?.current());
}

export function runningUnder<T>(cause: Cause | undefined, work: () => T): T {
  const carrier = sdkCarrier();
  return carrier ? carrier.run(cause, work) : work();
}
