import type { ItxExpression } from "iterate/expression";
import { expect, test } from "vitest";
import type { Caller } from "../caller.ts";
import { defineItxHost } from "../host.ts";
import {
  admitLoadedCodeRow,
  admitRowsOfCall,
  type ItxExpressionRewriteRule,
  ItxExpressionResolver,
} from "./itx-expression-rewriting.ts";
import { stampCallerHeaders } from "./rpc-stubs.ts";

const ROWS = [
  "events.iterate.com/itx/rewrite-rule-configured",
  "events.iterate.com/itx/subscription-configured",
  // its target answers the next request on the mind's hosts, as the person who makes it
  "events.iterate.com/itx/ingress-configured",
];

test.for(ROWS)("loaded code writes no %s row whose target is a built-in", (type) => {
  for (const target of ["itx.builtins.cd('/').secrets", ["itx", "builtins", "fetch"]])
    expect(() =>
      admitLoadedCodeRow({ type, payload: { match: "itx.x", target } }, "/apps/x"),
    ).toThrow("is not a loaded worker's word");
});

test.for(ROWS)("loaded code writes a %s row whose target is a name of its own context", (type) => {
  expect(() =>
    admitLoadedCodeRow({ type, payload: { match: "itx.x", target: "itx.site.fetch" } }, "/apps/x"),
  ).not.toThrow();
  // no target: the row is taken away, or ingress is off
  expect(() => admitLoadedCodeRow({ type, payload: { target: null } }, "/apps/x")).not.toThrow();
});

// A row whose target is a call that carries a row: the row inside would be written when the outer
// row runs, as the platform's delivery, which checks no row.
const escape = {
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match: "itx.escape", target: "itx.builtins.cd('/')" },
};

test.for([
  ["an event that a call appends", ["itx", ["append", escape]]],
  ["one of several events", ["itx", ["append", { type: "x/said", payload: {} }, escape]]],
  ["an event that a call appends at offsets", ["itx", ["appendOffsets", [escape]]]],
  [
    "an event that a schedule appends",
    ["itx", "schedules", ["set", "later", { at: 1, events: [escape] }]],
  ],
  [
    "a row that another row's call carries",
    [
      "itx",
      [
        "append",
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: { name: "inner", target: ["itx", ["append", escape]] },
        },
      ],
    ],
  ],
] as const)(
  "loaded code writes no subscription whose target carries a row with a built-in target: %s",
  ([, target]) => {
    expect(() =>
      admitLoadedCodeRow(
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: { name: "outer", target },
        },
        "/apps/x",
      ),
    ).toThrow("is not a loaded worker's word");
  },
);

test("a row's target may carry an event that is no row, and a row whose own target is a name of the context", () => {
  for (const carried of [
    { type: "events.iterate.com/x/said", payload: { target: "itx.builtins.cd('/')" } },
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.x", target: "itx.site.fetch" },
    },
  ])
    expect(() =>
      admitLoadedCodeRow(
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: { name: "outer", target: ["itx", ["append", carried]] },
        },
        "/apps/x",
      ),
    ).not.toThrow();
});

// A ROW THAT LOADED CODE SPLITS OVER TWO ROWS: a rule whose target has a hole, and a subscription
// whose target is a call that fills the hole. Each passes the check on a row that loaded code
// writes. The row that the two make exists only when the subscription's target is run.
const RULE = "events.iterate.com/itx/rewrite-rule-configured";
const opensTheRoot = { match: "itx.escape", target: "itx.builtins.cd('/')" };
const SPLIT_ROWS: [how: string, ruleTarget: ItxExpression, call: ItxExpression][] = [
  [
    "the type in the rule and the payload in the call",
    ["itx", ["append", { type: RULE, "...@": true }]],
    ["itx", ["foo", { payload: opensTheRoot }]],
  ],
  [
    "the payload is the hole",
    ["itx", ["append", { type: RULE, payload: { "@": true } }]],
    ["itx", ["foo", opensTheRoot]],
  ],
  [
    "the type in the call and the payload in the rule",
    ["itx", ["append", { payload: opensTheRoot, "...@": true }]],
    ["itx", ["foo", { type: RULE }]],
  ],
];

test.for(SPLIT_ROWS)(
  "a row with a built-in target that loaded code split over a rule and a subscription's call is not written when the subscription's target is run: %s",
  async ([, ruleTarget, call]) => {
    for (const row of [
      { type: RULE, payload: { match: "itx.foo", target: ruleTarget } },
      {
        type: "events.iterate.com/itx/subscription-configured",
        payload: { name: "go", target: call },
      },
    ])
      expect(() => admitLoadedCodeRow(row, "/apps/x")).not.toThrow();
    const mind = mindWith({ "/apps/x": [{ match: ["itx", "foo"], target: ruleTarget }] });

    // as the delivery loop runs a subscription's target, and as a request runs the ingress row
    await expect(mind.run("/apps/x", call, { principal: null, runsRow: true })).rejects.toThrow(
      "is not a loaded worker's word",
    );
    expect(mind).toMatchObject({ written: [] });

    // the same call by code that no row made, the platform's own, writes the row
    await mind.run("/apps/x", call, { principal: null });
    expect(mind).toMatchObject({
      written: [{ at: "/apps/x", type: RULE, payload: opensTheRoot }],
    });
  },
);

test("a row's run that crosses to another context is a row's run there too", async () => {
  const mind = mindWith({
    "/apps/x": [
      {
        match: ["itx", "foo"],
        target: ["itx", ["cd", "/apps/y"], ["append", { type: RULE, "...@": true }]],
      },
    ],
    "/apps/y": [],
  });
  const call: ItxExpression = ["itx", ["foo", { payload: opensTheRoot }]];

  await expect(mind.run("/apps/x", call, { principal: null, runsRow: true })).rejects.toThrow(
    "is not a loaded worker's word",
  );
  expect(mind).toMatchObject({
    written: [],
    crossedAs: [{ principal: null, runsRow: true, path: "/apps/x" }],
  });
});

test("a row's run writes a row whose target is a name of the context, and an event that is no row", async () => {
  const mind = mindWith({
    "/apps/x": [{ match: ["itx", "foo"], target: ["itx", ["append", { "@": true }]] }],
  });
  const row = { type: RULE, payload: { match: "itx.x", target: "itx.site.fetch" } };
  const said = { type: "events.iterate.com/x/said", payload: { target: "itx.builtins.cd('/')" } };

  for (const event of [row, said]) {
    const call: ItxExpression = ["itx", ["foo", event]];
    await mind.run("/apps/x", call, { principal: null, runsRow: true });
  }

  expect(mind).toMatchObject({
    written: [
      { at: "/apps/x", ...row },
      { at: "/apps/x", ...said },
    ],
  });
});

test("a call that is neither loaded code's nor a row's run is not checked: a member's and the platform's own rows are theirs to write", () => {
  const row = [{ type: RULE, payload: opensTheRoot }];
  for (const caller of [
    { principal: null },
    { principal: { actor: "user_1", email: "jo@example.net" } },
    { principal: null, platform: true as const },
  ])
    expect(() => admitRowsOfCall(caller, row, "/")).not.toThrow();
  for (const caller of [
    { principal: null, app: true as const },
    { principal: null, runsRow: true as const },
    // the ingress row's target is run as the person who asks
    { principal: { actor: "user_1", email: "jo@example.net" }, runsRow: true as const },
  ])
    expect(() => admitRowsOfCall(caller, row, "/")).toThrow("is not a loaded worker's word");
});

test("a row's run says so to the context that a fetch goes on to, and no request brings the mark by itself", () => {
  const marked = new Headers();
  stampCallerHeaders(marked, { principal: null, runsRow: true });
  // what a request from outside set is dropped: the caller alone says it
  const claimed = new Headers({ "x-itx-runs-row": "1" });
  stampCallerHeaders(claimed, { principal: null });

  expect({
    marked: marked.get("x-itx-runs-row"),
    claimed: claimed.get("x-itx-runs-row"),
  }).toEqual({ marked: "1", claimed: null });
});

// the resolver asks the host for the gate of held acts: this mind has none
defineItxHost({ firstPartyFacets: {} });

/** A mind of contexts with these rows. `append` in each is the kernel's check of a call's rows
 *  and then a list: what was written, and where. */
function mindWith(tables: Record<string, ItxExpressionRewriteRule[]>) {
  const written: { at: string; type: string; payload?: unknown }[] = [];
  const crossedAs: Caller[] = [];
  const at = (path: string, caller: Caller): ItxExpressionResolver =>
    new ItxExpressionResolver({
      path,
      caller: () => caller,
      rewriteRules: () => tables[path] || [],
      builtIns: {
        append: (...events: { type: string; payload?: unknown }[]) => {
          admitRowsOfCall(caller, events, path);
          written.push(...events.map((event) => ({ at: path, ...event })));
        },
      },
      reach: {
        recordLoopLimit: () => undefined,
        snapshotOf: async (there) => ({
          rules: tables[there] || [],
          readAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
        located: (there, expression, args, callerThere) => {
          crossedAs.push(callerThere);
          return at(there, callerThere).invoke(expression, ...args);
        },
        workersOf: () => ({}),
      },
    });
  return {
    written,
    crossedAs,
    /** As the delivery loop reads a target that is a call: the call runs then. */
    run: (path: string, call: ItxExpression, caller: Caller) => at(path, caller).evaluate(call),
  };
}
