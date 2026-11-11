// The loop guard, explained here only:
// 1. Depth goes up by one only where code runs because of an event or other code (a delivery, a
//    script run), and the clock takes it down (`oneStepDeeper`). Past LOOP_DEPTH_LIMIT code may
//    read, but every act is refused LOOP_LIMIT, and the context records one `itx/loop-limit` per chain.
// 2. One call crosses at most MAX_CONTEXT_HOPS contexts. Hops ride the call, never an event.
// 3. What code writes while it handles a delivery is keyed by it (`writeKey`), so a retry never
//    repeats what an attempt before it did.

import { codedError, errorCode, ITERATE_CAUSE_HEADER, oneStepDeeper } from "iterate/lib";
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

export function causeHeader({ chain, depth, at, hops, parent }: Cause): string {
  return JSON.stringify({
    chain,
    depth,
    at,
    hops: hops ?? 0,
    ...(parent && PRINTABLE_ASCII.test(parent) && { parent }),
  });
}

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
