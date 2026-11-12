import { expect, test } from "vitest";
import { type ItxExpression, parseItxExpressionPrefix } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import type { ItxExpressionRewriteRule } from "./itx-expression-rewriting.ts";
import { appendAtAttach, eventsOfARedial, unsetByClose, type UnsetByClose } from "./rpc-stubs.ts";

const LEND: ItxExpression = ["itx", "builtins", "rpcStubs", ["get", "itx.bridge"]];
const ELSEWHERE: ItxExpression = ["itx", "config", "bridge"];
const RULE: StreamEventInput = {
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match: "itx.bridge", target: LEND, description: "a bridge" },
};
const ROUTE: StreamEventInput = {
  type: "events.iterate.com/itx/fetch-route-configured",
  payload: { fetchRouteName: "bridge", target: LEND },
};
const HEARS: StreamEventInput = {
  type: "events.iterate.com/itx/subscription-configured",
  payload: { name: "bridge-hears", target: LEND },
};
const ALL = [RULE, ROUTE, HEARS];
/** The close un-set all three rows of the lend. */
const UNSET = { rules: ["itx.bridge"], subscriptions: ["bridge-hears"], fetchRoutes: ["bridge"] };
const NOTHING = unsetByClose(undefined);

test.for([
  { when: "the context un-set each row at the close", now: {}, unset: UNSET, sets: ALL },
  {
    when: "each row is still this lend's",
    now: { rule: LEND, route: LEND, hears: LEND },
    unset: NOTHING,
    sets: ALL,
  },
  {
    when: "someone pointed the name elsewhere",
    now: { rule: ELSEWHERE, route: LEND, hears: LEND },
    unset: UNSET,
    sets: [ROUTE, HEARS],
  },
  {
    when: "someone masked the name",
    now: { rule: null, route: LEND, hears: LEND },
    unset: UNSET,
    sets: [ROUTE, HEARS],
  },
  // no row, and the context has no record that it un-set one: somebody removed it
  { when: "someone removed every row", now: {}, unset: NOTHING, sets: [] },
  {
    when: "someone removed the route and the subscription, and the close un-set the rule",
    now: {},
    unset: { ...NOTHING, rules: ["itx.bridge"] },
    sets: [RULE],
  },
  {
    when: "someone gave the route and the subscription another target",
    now: { rule: LEND, route: ELSEWHERE, hears: ELSEWHERE },
    unset: UNSET,
    sets: [RULE],
  },
  {
    when: "the record is another name's, and someone removed this lend's rows",
    now: {},
    unset: { rules: ["itx.other"], subscriptions: ["other"], fetchRoutes: ["other"] },
    sets: [],
  },
])("a redial sets a row again only where it is still its own: $when", ({ now, unset, sets }) => {
  expect(eventsOfARedial(ALL, rows(now), unset)).toEqual(sets);
});

test("a record from before it held more than rules is read as rules alone", () => {
  expect(unsetByClose(["itx.bridge"])).toEqual({
    rules: ["itx.bridge"],
    subscriptions: [],
    fetchRoutes: [],
  });
});

test("an attach that the stream refuses leaves the record of the close, and the redial after it sets the rows again", () => {
  // the close un-set the lend's rows: nothing holds their names, and the record names them
  let record: UnsetByClose | undefined = UNSET;
  const appended: StreamEventInput[][] = [];
  let refuses = true;
  const attach = () =>
    appendAtAttach({
      events: ALL,
      redial: true,
      rows: rows({}),
      record: { read: () => record, end: () => void (record = undefined) },
      append: (events) => {
        if (refuses) throw new Error("the stream is paused");
        appended.push(events);
      },
    });
  expect(attach).toThrow("the stream is paused");
  expect({ record, appended }).toEqual({ record: UNSET, appended: [] });
  refuses = false;
  attach();
  expect({ record, appended }).toEqual({ record: undefined, appended: [ALL] });
});

test("a first dial appends its events as they are and ends an older record", () => {
  let record: UnsetByClose | undefined = { ...NOTHING, rules: ["itx.other"] };
  const appended: StreamEventInput[][] = [];
  appendAtAttach({
    events: [RULE, ROUTE],
    redial: false,
    rows: rows({ rule: ELSEWHERE }),
    record: { read: () => record, end: () => void (record = undefined) },
    append: (events) => void appended.push(events),
  });
  expect({ record, appended }).toEqual({ record: undefined, appended: [[RULE, ROUTE]] });
});

/** A context's rows: the rule at `itx.bridge` (null: a mask), the fetch route `bridge` and the
 *  subscription `bridge-hears`, each only when given. */
function rows(now: {
  rule?: ItxExpressionRewriteRule["target"];
  route?: ItxExpression;
  hears?: ItxExpression;
}) {
  const fetchRouteTargets: Record<string, ItxExpression> = now.route ? { bridge: now.route } : {};
  const subscriptionTargets: Record<string, ItxExpression> = now.hears
    ? { "bridge-hears": now.hears }
    : {};
  return {
    rules:
      "rule" in now ? [{ match: parseItxExpressionPrefix("itx.bridge"), target: now.rule! }] : [],
    fetchRouteTargets,
    subscriptionTargets,
  };
}
