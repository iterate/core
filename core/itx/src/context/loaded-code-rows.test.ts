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

// THE ROWS A PACKAGE'S WORKER WRITES WHEN IT SETS UP A CONTEXT OF ITS OWN: loaded code's to write.
// These are the shapes the voice package provisions a device with (its worker.ts
// `ensureVoiceDevice`), kept here because a package's test cannot name the kernel: the context's
// bare `itx` pointed at the context that asked, a subscription to a facet whose source is the
// root's config, and subscriptions that copy events to another path.
test.for(["/", "/child"])(
  "loaded code writes the rows that set up a context of its own under %s",
  (asker) => {
    const device = "/voice/pin";
    const agent = "/agents/voice/pin";
    const rows: [landsAt: string, row: { type: string; payload: unknown }][] = [
      [
        device,
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match: "itx", target: `itx.cd(${JSON.stringify(asker)})` },
        },
      ],
      [
        device,
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: {
            name: "voice-agent",
            target: [
              "itx",
              "facets",
              [
                "get",
                "voice-agent",
                {
                  className: "VoiceAgentDurableObject",
                  mainModule: "voice.ts",
                  source: ["itx", ["cd", "/"], "config"],
                },
              ],
              "processEventBatch",
            ],
            consumes: ["*"],
          },
        },
      ],
      [
        device,
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: {
            name: "voice-agent-warm-up",
            consumes: ["events.iterate.com/voice-agent/call-started"],
            target: { path: agent, type: "events.iterate.com/agent/warm-up-requested" },
          },
        },
      ],
      [
        agent,
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: {
            name: "voice-relay",
            consumes: ["events.iterate.com/agent/paused"],
            target: { path: device, payload: "payload" },
          },
        },
      ],
    ];
    for (const [landsAt, row] of rows) expect(() => admitLoadedCodeRow(row, landsAt)).not.toThrow();
    // and the same context's `itx` pointed at a built-in is not
    expect(() =>
      admitLoadedCodeRow(
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match: "itx", target: "itx.builtins.cd('/')" },
        },
        device,
      ),
    ).toThrow("is not a loaded worker's word");
  },
);

// A row whose target is a call that carries a row (./itx-expression-rewriting.ts
// `admitLoadedCodeExpression`).
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

// A LENT STUB. When loaded code lends a live object, `provide` writes a rule for it and
// `subscribe` a subscription, each with the stub as its target (../iterate-context.ts).
const RULE_ROW = "events.iterate.com/itx/rewrite-rule-configured";
const SUBSCRIPTION = "events.iterate.com/itx/subscription-configured";

test("loaded code writes the row of its own lend: a rule at the stub under the rule's match, and a subscription at the stub under its name", () => {
  for (const row of [
    {
      type: RULE_ROW,
      payload: { match: "itx.tools.browser", target: stubAt("itx.tools.browser") },
    },
    // the key is the match as `provide` spells it, whichever way the row spells the match
    {
      type: RULE_ROW,
      payload: { match: ["itx", "tools", "browser"], target: stubAt("itx.tools.browser") },
    },
    {
      type: RULE_ROW,
      payload: {
        match: "itx.tools.browser",
        target: "itx.builtins.rpcStubs.get('itx.tools.browser')",
      },
    },
    { type: SUBSCRIPTION, payload: { name: "live", target: stubAt("subscription:live") } },
  ])
    expect(() => admitLoadedCodeRow(row, "/apps/x")).not.toThrow();
});

test.for([
  [
    "a rule at the stub of another name",
    { type: RULE_ROW, payload: { match: "itx.mine", target: stubAt("itx.whatsapp.jo") } },
  ],
  [
    "a rule at a callback's stub",
    { type: RULE_ROW, payload: { match: "itx.mine", target: stubAt("subscription:live") } },
  ],
  [
    "a rule with a step after the stub",
    { type: RULE_ROW, payload: { match: "itx.mine", target: stubAt("itx.mine", "send") } },
  ],
  [
    "a rule with one more argument in the get",
    {
      type: RULE_ROW,
      payload: {
        match: "itx.mine",
        target: ["itx", "builtins", "rpcStubs", ["get", "itx.mine", {}]],
      },
    },
  ],
  ["a rule whose match is no name", { type: RULE_ROW, payload: { match: 7, target: stubAt("7") } }],
  [
    "a subscription at the stub of another subscription",
    { type: SUBSCRIPTION, payload: { name: "mine", target: stubAt("subscription:live") } },
  ],
  [
    "a subscription at a lent name's stub",
    { type: SUBSCRIPTION, payload: { name: "mine", target: stubAt("itx.whatsapp.jo") } },
  ],
  [
    "a subscription with a step after the stub",
    { type: SUBSCRIPTION, payload: { name: "mine", target: stubAt("subscription:mine", "push") } },
  ],
  [
    "a subscription with no name",
    { type: SUBSCRIPTION, payload: { target: stubAt("subscription:undefined") } },
  ],
  [
    "an ingress row at a stub",
    {
      type: "events.iterate.com/itx/ingress-configured",
      payload: { target: stubAt("itx.whatsapp.jo") },
    },
  ],
] as const)("loaded code writes no row at a lent stub but its own lend's: %s", ([, row]) => {
  expect(() => admitLoadedCodeRow(row, "/apps/x")).toThrow("is not a loaded worker's word");
});

// Rows in two parts, a rule with a hole and the call that fills it: `admitRowsOfCall` in
// ./itx-expression-rewriting.ts says what the two make.
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

test("a call's { source } that is no itx expression is the callee's data", () => {
  for (const source of [
    "window.report(JSON.stringify({ at: location.href }))",
    "console.log(1)",
    ["window", "report"],
  ])
    for (const spec of [{ source }, { source, cacheKey: "k" }])
      expect(() =>
        admitLoadedCodeRow(
          {
            type: ROWS[0]!,
            payload: {
              match: "itx.x",
              target: ["itx", "chrome", ["cdp", 1, "Page.addScriptToEvaluateOnNewDocument", spec]],
            },
          },
          "/apps/x",
        ),
      ).not.toThrow();
});

test("a call's { source } that is an itx expression is still walled as a worker's name or producer", () => {
  const row = (spec: object) => ({
    type: ROWS[0]!,
    payload: { match: "itx.x", target: ["itx", "workers", ["get", spec]] },
  });
  expect(() =>
    admitLoadedCodeRow(row({ source: "itx.builtins.cd('/').config" }), "/apps/x"),
  ).toThrow("a worker's name only reads rules");
  expect(() =>
    admitLoadedCodeRow(row({ source: ["itx", "builtins", "secrets"], cacheKey: "k" }), "/apps/x"),
  ).toThrow("is not a loaded worker's word");
  expect(() => admitLoadedCodeRow(row({ source: "itx.cd('/').config" }), "/apps/x")).not.toThrow();
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

/** A lent stub as a row's target: the stub under `key`, and what a row may spell after it. */
function stubAt(key: string, ...after: unknown[]): unknown[] {
  return ["itx", "builtins", "rpcStubs", ["get", key], ...after];
}
