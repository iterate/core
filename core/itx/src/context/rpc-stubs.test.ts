import { expect, test } from "vitest";
import { type ItxExpression, parseItxExpressionPrefix } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import type { ItxExpressionRewriteRule } from "./itx-expression-rewriting.ts";
import { appendAtAttach, eventsOfARedial } from "./rpc-stubs.ts";

const LEND: ItxExpression = ["itx", "builtins", "rpcStubs", ["get", "itx.bridge"]];
const RULE: StreamEventInput = {
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match: "itx.bridge", target: LEND, description: "a bridge" },
};
const ROUTE: StreamEventInput = {
  type: "events.iterate.com/itx/fetch-route-configured",
  payload: { fetchRouteName: "bridge", target: LEND },
};
const UNSET = new Set(["itx.bridge"]);
test.for([
  {
    when: "the context un-set the rule at the close",
    rules: [],
    unset: UNSET,
    sets: [RULE, ROUTE],
  },
  {
    when: "the row is still this lend",
    rules: [row("itx.bridge", LEND)],
    unset: new Set<string>(),
    sets: [RULE, ROUTE],
  },
  {
    when: "a row of another name stands",
    rules: [row("itx.other", ["itx", "config", "other"])],
    unset: UNSET,
    sets: [RULE, ROUTE],
  },
  {
    when: "someone pointed the name elsewhere",
    rules: [row("itx.bridge", ["itx", "config", "bridge"])],
    unset: UNSET,
    sets: [ROUTE],
  },
  {
    when: "someone masked the name",
    rules: [row("itx.bridge", null)],
    unset: UNSET,
    sets: [ROUTE],
  },
  // no row, and the context has no record that it un-set one: somebody removed it
  { when: "someone removed the row", rules: [], unset: new Set<string>(), sets: [ROUTE] },
  {
    when: "the context un-set another name's rule, and someone removed this one",
    rules: [],
    unset: new Set(["itx.other"]),
    sets: [ROUTE],
  },
])(
  "a redial sets its rule again only where the name is still its own: $when",
  ({ rules, unset, sets }) => {
    expect(eventsOfARedial([RULE, ROUTE], rules, unset)).toEqual(sets);
  },
);

test("an attach that the stream refuses leaves the record of the close, and the redial after it sets the rule again", () => {
  // the close un-set the lend's rule: no row holds the name, and the record names it
  let record: string[] | undefined = ["itx.bridge"];
  const appended: StreamEventInput[][] = [];
  let refuses = true;
  const attach = () =>
    appendAtAttach({
      events: [RULE],
      redial: true,
      rules: [],
      record: { read: () => record, end: () => void (record = undefined) },
      append: (events) => {
        if (refuses) throw new Error("the stream is paused");
        appended.push(events);
      },
    });
  expect(attach).toThrow("the stream is paused");
  expect({ record, appended }).toEqual({ record: ["itx.bridge"], appended: [] });
  refuses = false;
  attach();
  expect({ record, appended }).toEqual({ record: undefined, appended: [[RULE]] });
});

test("a first dial appends its events as they are and ends an older record", () => {
  let record: string[] | undefined = ["itx.other"];
  const appended: StreamEventInput[][] = [];
  appendAtAttach({
    events: [RULE, ROUTE],
    redial: false,
    rules: [row("itx.bridge", ["itx", "config", "bridge"])],
    record: { read: () => record, end: () => void (record = undefined) },
    append: (events) => void appended.push(events),
  });
  expect({ record, appended }).toEqual({ record: undefined, appended: [[RULE, ROUTE]] });
});

function row(match: string, target: ItxExpressionRewriteRule["target"]) {
  return { match: parseItxExpressionPrefix(match), target };
}
