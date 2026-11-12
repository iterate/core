import { expect, test } from "vitest";
import { type ItxExpression, parseItxExpressionPrefix } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import type { ItxExpressionRewriteRule } from "./itx-expression-rewriting.ts";
import { eventsOfARedial } from "./rpc-stubs.ts";

const LEND: ItxExpression = ["itx", "builtins", "rpcStubs", ["get", "itx.bridge"]];
const RULE: StreamEventInput = {
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match: "itx.bridge", target: LEND, description: "a bridge" },
};
const ROUTE: StreamEventInput = {
  type: "events.iterate.com/itx/fetch-route-configured",
  payload: { fetchRouteName: "bridge", target: LEND },
};
test.for([
  { when: "no row holds the name", rules: [], sets: [RULE, ROUTE] },
  { when: "the row is still this lend", rules: [row("itx.bridge", LEND)], sets: [RULE, ROUTE] },
  {
    when: "a row of another name stands",
    rules: [row("itx.other", ["itx", "config", "other"])],
    sets: [RULE, ROUTE],
  },
  {
    when: "someone pointed the name elsewhere",
    rules: [row("itx.bridge", ["itx", "config", "bridge"])],
    sets: [ROUTE],
  },
  { when: "someone masked the name", rules: [row("itx.bridge", null)], sets: [ROUTE] },
])(
  "a redial sets its rule again only where no other row holds the name: $when",
  ({ rules, sets }) => {
    expect(eventsOfARedial([RULE, ROUTE], rules)).toEqual(sets);
  },
);

function row(match: string, target: ItxExpressionRewriteRule["target"]) {
  return { match: parseItxExpressionPrefix(match), target };
}
