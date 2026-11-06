// context/facet-lends.ts — A PROJECT LENDS A FACET TO A PERSON, pure (no I/O): the lend's facts,
// their fold into the core state, and the two checks that read it. core/os README.md, "A project
// lends a facet to a person", says what a lend is for. THE RULES, rows of facet-lends.test.ts
// beside this file and test/vitest/os-workers/facet-lends.test.ts (end to end, through /api):
//   1. A lend is `itx/facet-lent { facet, to }` on the facet's own context, ended by
//      `itx/facet-lend-revoked`. The core reduce keeps them as `facetLends`, read on every call a
//      lendee makes. A first-party facet and the core reduce are never lent.
//   2. A project's root records once that the project lends (`itx/facet-lending-enabled`), and only
//      the `facets.lend` verb writes it (context/built-ins.ts). A session gives a person who is no
//      member a handle on a project only after that (session.ts `projects.get`): a project that
//      never lent is refused there, and none of its contexts is reached.
//   3. A lendee's call is one expression, `itx.facets.get(name).<step>…`, on a facet lent to them
//      at this context (`lentFacetCall`); anything else is refused FORBIDDEN before the context
//      writes or births anything (iterate-context-durable-object.ts `invoke`). Its first step is
//      one of the class's `lentMethods` or the live state's seed read (context/facet-host.ts).
//   4. A lendee's live-state subscription gets the deltas of the facets lent to them now and no
//      other event (`reachesLendee`, read by the delivery loop on every push).
import { z } from "zod";
import { codedError } from "iterate/lib";
import type { ItxExpression } from "iterate/expression";
import { firstPartyFacetClassOf } from "../first-party-facets.ts";

/** Who each facet of a context is lent to: facet name, then user id, then the offset of the lend. */
export type FacetLends = Record<string, Record<string, number>>;

/** What a lend carries beside the lent methods: the live state's seed read (rule 3). */
export const LENT_LIVE_STATE_METHODS: readonly string[] = ["liveSnapshot"];

/** A lend's payload, both its facts': the facet by its name here, and the person by their id. */
export const FacetLend = z.strictObject({
  facet: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "a facet name is one segment: [A-Za-z0-9_-]+")
    .refine((name) => name !== "core" && !firstPartyFacetClassOf(name), {
      message: "a first-party facet and the core reduce are never lent",
    }),
  to: z.string().startsWith("user_", "a lend names a person by their user id"),
});
export type FacetLend = z.infer<typeof FacetLend>;

/** `lends` after one lend fact, or undefined when it changes nothing. The payload is the one
 *  `FacetLend` checked at the append boundary (core-processor.ts `normalizeControlEvent`). */
export function reduceFacetLend(
  lends: FacetLends,
  type: "events.iterate.com/itx/facet-lent" | "events.iterate.com/itx/facet-lend-revoked",
  { facet, to }: FacetLend,
  offset: number,
): FacetLends | undefined {
  const lent = lends[facet]?.[to] !== undefined;
  if (type === "events.iterate.com/itx/facet-lent") {
    if (lent) return undefined;
    return { ...lends, [facet]: { ...lends[facet], [to]: offset } };
  }
  if (!lent) return undefined;
  const { [to]: _ended, ...rest } = lends[facet]!;
  if (Object.keys(rest).length > 0) return { ...lends, [facet]: rest };
  const { [facet]: _unlent, ...others } = lends;
  return others;
}

/** The facet a lendee's call names and the steps it walks on it (rule 3), or FORBIDDEN. No steps
 *  is the facet itself, answered as the expression that names it (context/dispatch.ts
 *  `itxAnswerDetachedFromSession`), so every call on it comes back through this check. */
export function lentFacetCall(
  expression: ItxExpression,
  lends: FacetLends,
  userId: string | undefined,
): { facet: string; steps: ItxExpression } {
  const call = LentFacetExpression.safeParse(expression);
  if (!call.success)
    throw codedError(
      "FORBIDDEN",
      "a person this project lends to reaches a lent facet's methods alone: itx.facets.get(name).<method>(…)",
    );
  const [, , [, facet], ...steps] = call.data;
  if (!userId || lends[facet]?.[userId] === undefined)
    throw codedError("FORBIDDEN", `facet "${facet}" here is not lent to this session's person`);
  // The steps are the input's own, an ItxExpression's; the schema types them unknown only because
  // it leaves them unchecked.
  return { facet, steps: steps as ItxExpression };
}

/** `expression` with `invoke`'s live `args` applied to the value it names, as one expression: a
 *  final name step becomes the call, and args after a call step call its answer. */
export function foldedArgs(expression: ItxExpression, args: unknown[]): ItxExpression {
  if (args.length === 0) return expression;
  const last = expression.at(-1);
  if (typeof last === "string") return [...expression.slice(0, -1), [last, ...args]];
  return [...expression, ["", ...args]];
}

/** `itx.facets.get(name)` with no spec, then its steps: none names the facet (a client's dotted
 *  `facets.get(name).method()` asks for the handle first), and the facet host's walk checks them. */
const LentFacetExpression = z
  .tuple([z.literal("itx"), z.literal("facets"), z.tuple([z.literal("get"), z.string()])])
  .rest(z.unknown());

/** Whether `event` reaches the person a subscription row is lent to (rule 4): a live-state delta
 *  of a facet lent to them. The delta's key is its processor's slug, which the platform's own
 *  reader takes for the facet's name too (iterate/react `useFacetLiveState`). */
export function reachesLendee(
  event: { type: string; payload?: unknown },
  lends: FacetLends,
  userId: string,
): boolean {
  if (event.type !== "events.iterate.com/itx/live-state-changed") return false;
  const key = LiveStateKey.safeParse(event.payload);
  return key.success && lends[key.data.key]?.[userId] !== undefined;
}

const LiveStateKey = z.object({ key: z.string() });
