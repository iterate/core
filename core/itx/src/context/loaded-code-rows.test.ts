import { expect, test } from "vitest";
import { admitLoadedCodeRow } from "./itx-expression-rewriting.ts";

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
