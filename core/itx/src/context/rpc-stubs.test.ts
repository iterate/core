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

test.for([
  { lender: "a member's sign-in", lentBy: "grant:member" },
  { lender: "another key", lentBy: "key:k2" },
])(
  "a first dial that takes the name only from itself is refused where $lender lends the name, and changes nothing",
  ({ lentBy }) => {
    const attach = attachOnlyFromKeyOne({ rows: rows({ rule: LEND, lentBy }) });
    expect(attach.run).toThrow(
      expect.objectContaining({
        code: "FORBIDDEN",
        message:
          "itx.bridge is lent by another lender, and this lend takes the name only from itself: stop that lend, then lend again",
      }),
    );
    expect(attach.state()).toEqual({ record: UNSET, appended: [] });
  },
);

test.for([
  { when: "the key itself lends the name", now: { rule: LEND, lentBy: "key:k1" } },
  { when: "the name's lend records no lender", now: { rule: LEND } },
  { when: "no row holds the name", now: {} },
  {
    when: "the row at the name is no lend of it",
    now: { rule: ELSEWHERE, lentBy: "grant:member" },
  },
])("a first dial that takes the name only from itself appends where $when", ({ now }) => {
  const attach = attachOnlyFromKeyOne({ rows: rows(now) });
  attach.run();
  expect(attach.state()).toEqual({ record: undefined, appended: [ALL] });
});

test("a redial is not refused where another lender's row holds the name", () => {
  const attach = attachOnlyFromKeyOne({
    redial: true,
    rows: rows({ rule: LEND, lentBy: "grant:member", route: LEND, hears: LEND }),
  });
  attach.run();
  expect(attach.state()).toEqual({ record: undefined, appended: [ALL] });
});

test("a lend that takes the name from anyone (a member's) takes it from another lender", () => {
  let record: UnsetByClose | undefined = UNSET;
  const appended: StreamEventInput[][] = [];
  appendAtAttach({
    events: ALL,
    redial: false,
    rows: rows({ rule: LEND, lentBy: "key:k1" }),
    record: { read: () => record, end: () => void (record = undefined) },
    append: (events) => void appended.push(events),
  });
  expect({ record, appended }).toEqual({ record: undefined, appended: [ALL] });
});

/** An attach of all three rows by the key `key:k1`, which takes the name only from itself. */
function attachOnlyFromKeyOne(input: { rows: ReturnType<typeof rows>; redial?: boolean }) {
  let record: UnsetByClose | undefined = UNSET;
  const appended: StreamEventInput[][] = [];
  const run = () =>
    appendAtAttach({
      events: ALL,
      redial: input.redial === true,
      onlyFrom: "key:k1",
      rows: input.rows,
      record: { read: () => record, end: () => void (record = undefined) },
      append: (events) => void appended.push(events),
    });
  return { run, state: () => ({ record, appended }) };
}

/** A context's rows: the rule at `itx.bridge` (null: a mask) with its lender, the fetch route
 *  `bridge` and the subscription `bridge-hears`, each only when given. */
function rows(now: {
  rule?: ItxExpressionRewriteRule["target"];
  lentBy?: string;
  route?: ItxExpression;
  hears?: ItxExpression;
}) {
  const fetchRouteTargets: Record<string, ItxExpression> = now.route ? { bridge: now.route } : {};
  const subscriptionTargets: Record<string, ItxExpression> = now.hears
    ? { "bridge-hears": now.hears }
    : {};
  return {
    rules:
      "rule" in now
        ? [
            {
              match: parseItxExpressionPrefix("itx.bridge"),
              target: now.rule!,
              lentBy: now.lentBy,
            },
          ]
        : [],
    fetchRouteTargets,
    subscriptionTargets,
  };
}
