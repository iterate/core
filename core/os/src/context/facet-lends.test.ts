// context/facet-lends.test.ts — the rules of facet-lends.ts as table rows: what a lend's facts fold
// to, which of a lendee's calls are admitted, which events their subscription is delivered, and
// what a lent facet's class lends. The same rules end to end, through `/api`, are
// test/vitest/os-workers/facet-lends.test.ts.
import { expect, test } from "vitest";
import { parse } from "iterate/expression";
import { errorCode } from "iterate/lib";
import { normalizeControlEvent, reduceCoreEvent, CoreContract } from "../stream/core-processor.ts";
import { assertFacetMethodIsLent } from "./facet-public-methods.ts";
import {
  FacetLend,
  foldedArgs,
  lentFacetCall,
  reachesLendee,
  reduceFacetLend,
  type FacetLends,
} from "./facet-lends.ts";

const LENT = "events.iterate.com/itx/facet-lent";
const REVOKED = "events.iterate.com/itx/facet-lend-revoked";
const ADA = "user_ada";
const lends: FacetLends = { counter: { [ADA]: 4 } };

test.for([
  { name: "a lend", lends: {}, type: LENT, to: ADA, folds: { counter: { [ADA]: 7 } } },
  { name: "the same lend again", lends, type: LENT, to: ADA, folds: undefined },
  {
    name: "a second person",
    lends,
    type: LENT,
    to: "user_bo",
    folds: { counter: { [ADA]: 4, user_bo: 7 } },
  },
  { name: "a revoke of the last lend", lends, type: REVOKED, to: ADA, folds: {} },
  { name: "a revoke of a lend never made", lends, type: REVOKED, to: "user_bo", folds: undefined },
] as const)("$name folds to $folds", ({ lends, type, to, folds }) => {
  expect(reduceFacetLend(lends, type, { facet: "counter", to }, 7)).toEqual(folds);
});

test.for([
  { lend: { facet: "counter", to: ADA }, parses: true },
  { lend: { facet: "project", to: ADA }, parses: false },
  { lend: { facet: "secret", to: ADA }, parses: false },
  { lend: { facet: "core", to: ADA }, parses: false },
  { lend: { facet: "a/b", to: ADA }, parses: false },
  { lend: { facet: "counter", to: "ada@example.com" }, parses: false },
  { lend: { facet: "counter", to: ADA, as: "x" }, parses: false },
])("a lend of $lend.facet to $lend.to parses: $parses", ({ lend, parses }) => {
  expect(FacetLend.safeParse(lend)).toMatchObject({ success: parses });
});

test.for([
  { call: "itx.facets.get('counter').greet()", user: ADA, is: "admitted" },
  { call: "itx.facets.get('counter')", user: ADA, is: "admitted" },
  { call: "itx.facets.get('counter').greet()", user: "user_bo", is: "FORBIDDEN" },
  { call: "itx.facets.get('counter').greet()", user: undefined, is: "FORBIDDEN" },
  { call: "itx.facets.get('other').greet()", user: ADA, is: "FORBIDDEN" },
  { call: "itx.facets.get('counter', { className: 'X' }).greet()", user: ADA, is: "FORBIDDEN" },
  { call: "itx.facets.abort('counter')", user: ADA, is: "FORBIDDEN" },
  { call: "itx.builtins.facets.get('counter').greet()", user: ADA, is: "FORBIDDEN" },
  { call: "itx.readEvents()", user: ADA, is: "FORBIDDEN" },
  { call: "itx.cd('/').facets.get('counter').greet()", user: ADA, is: "FORBIDDEN" },
])("a lendee's $call as $user: $is", ({ call, user, is }) => {
  expect(outcome(() => lentFacetCall(parse(call), lends, user))).toBe(is);
});

test.for([
  { expression: "itx.facets.get('c').greet", args: [], folds: "itx.facets.get('c').greet" },
  { expression: "itx.facets.get('c').greet", args: [1], folds: "itx.facets.get('c').greet(1)" },
])("$expression with $args folds to $folds", ({ expression, args, folds }) => {
  expect(foldedArgs(parse(expression), args)).toEqual(parse(folds));
});

test.for([
  {
    event: { type: "events.iterate.com/itx/live-state-changed", payload: { key: "counter" } },
    to: ADA,
    reaches: true,
  },
  {
    event: { type: "events.iterate.com/itx/live-state-changed", payload: { key: "other" } },
    to: ADA,
    reaches: false,
  },
  {
    event: { type: "events.iterate.com/itx/live-state-changed", payload: { key: "counter" } },
    to: "user_bo",
    reaches: false,
  },
  { event: { type: "events.iterate.com/itx/live-state-changed" }, to: ADA, reaches: false },
  { event: { type: "test/counted", payload: { key: "counter" } }, to: ADA, reaches: false },
])("$event.type of $event.payload.key reaches $to: $reaches", ({ event, to, reaches }) => {
  expect(reachesLendee(event, lends, to)).toBe(reaches);
});

test.for([
  { walk: "liveSnapshot()", lentMethods: [], is: "admitted" },
  { walk: "greet('ada')", lentMethods: ["greet"], is: "admitted" },
  { walk: "greet", lentMethods: [], is: "FORBIDDEN" },
  { walk: "snapshot()", lentMethods: ["greet"], is: "FORBIDDEN" },
  { walk: "fetch()", lentMethods: [], is: "FORBIDDEN" },
])("a lendee's $walk on a class lending $lentMethods: $is", ({ walk, lentMethods, is }) => {
  const steps = parse(`itx.${walk}`).slice(1);
  expect(outcome(() => assertFacetMethodIsLent("counter", lentMethods, steps))).toBe(is);
});

test("the lend facts are durable and checked at the append boundary; the project's mark is a root's", () => {
  const lent = { type: LENT, payload: { facet: "counter", to: ADA } };
  expect(normalizeControlEvent(lent, "/people/ada")).toEqual(lent);
  expect(() => normalizeControlEvent({ ...lent, ephemeral: true }, "/people/ada")).toThrow();
  expect(() =>
    normalizeControlEvent({ type: LENT, payload: { facet: "project", to: ADA } }, "/"),
  ).toThrow();
  const mark = { type: "events.iterate.com/itx/facet-lending-enabled", payload: {} };
  expect(normalizeControlEvent(mark, "/")).toEqual(mark);
  expect(() => normalizeControlEvent(mark, "/people/ada")).toThrow();
  // the fold, and the default a checkpoint written before lends reads as
  const state = CoreContract.initialState();
  expect(state.facetLends).toBeUndefined();
  const event = { ...lent, offset: 9, createdAt: "2026-11-06T00:00:00.000Z", path: "/" };
  expect(reduceCoreEvent({ event, state } as never)).toMatchObject({
    facetLends: { counter: { [ADA]: 9 } },
  });
  expect(reduceCoreEvent({ event: { ...event, ...mark }, state } as never)).toMatchObject({
    lendsFacets: true,
  });
});

// ── helpers ──

/** What `run` comes to: admitted, or the code it was refused with. */
const outcome = (run: () => unknown) => {
  try {
    run();
    return "admitted";
  } catch (error) {
    return errorCode(error) ?? (error as Error).message;
  }
};
