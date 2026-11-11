import { ActRule } from "iterate/acts";
import type { ItxExpression } from "iterate/expression";
import { expect, test } from "vitest";
import { heldVerbOf } from "./held-verbs.ts";

// where the mind's rule `itx.whatsapp` points: the stub a bridge lent
const STUB: ItxExpression = ["itx", "builtins", "rpcStubs", ["get", "k1"]];

test("a call of the verb a rule names is held, with its arguments", () => {
  expect(
    held(["itx.whatsapp.sendMessage"], [...STUB, ["sendMessage", "jo", { text: "hi" }]]),
  ).toEqual({
    act: "itx.whatsapp.sendMessage",
    args: ["jo", { text: "hi" }],
  });
  // arguments that come beside the expression are the call's too
  expect(held(["itx.whatsapp.sendMessage"], [...STUB, "sendMessage"], ["jo"])).toEqual({
    act: "itx.whatsapp.sendMessage",
    args: ["jo"],
  });
});

test("a rule for every verb under a name holds each of them, and not the name itself", () => {
  expect(held(["itx.whatsapp.*"], [...STUB, ["logout"]])).toEqual({
    act: "itx.whatsapp.logout",
    args: [],
  });
  expect(held(["itx.whatsapp.*"], [...STUB, "groups", ["leave", "g1"]])).toEqual({
    act: "itx.whatsapp.groups.leave",
    args: ["g1"],
  });
  expect(held(["itx.whatsapp.*"], STUB, ["x"])).toBeNull();
});

const NOT_HELD: [what: string, rules: string[], resolved: ItxExpression][] = [
  ["another verb of the same stub", ["itx.whatsapp.sendMessage"], [...STUB, ["logout"]]],
  [
    "a verb under the one the rule names",
    ["itx.whatsapp.sendMessage"],
    [...STUB, "sendMessage", ["now"]],
  ],
  [
    "another stub",
    ["itx.whatsapp.*"],
    ["itx", "builtins", "rpcStubs", ["get", "other"], ["sendMessage"]],
  ],
  ["a name read as a value", ["itx.whatsapp.*"], [...STUB, "state"]],
  ["a mail's rule", ["email.send"], [...STUB, ["sendMessage"]]],
  ["a rule whose verb names nothing here", ["itx.gone.send"], [...STUB, ["sendMessage"]]],
];
test.for(NOT_HELD)("a rule does not hold %s", ([, rules, resolved]) => {
  expect(held(rules, resolved)).toBeNull();
});

test("the same function by another name is held all the same", () => {
  // `itx.rpcStubs.get("k1").sendMessage(…)` resolves to where `itx.whatsapp.sendMessage` does
  const byKey: ItxExpression = [
    "itx",
    "builtins",
    "rpcStubs",
    ["get", "k1"],
    ["sendMessage", "jo"],
  ];
  expect(held(["itx.whatsapp.sendMessage"], byKey)).toEqual({
    act: "itx.whatsapp.sendMessage",
    args: ["jo"],
  });
});

const REFUSED: [what: string, resolved: ItxExpression, extraArgs: unknown[]][] = [
  ["a call in the middle", [...STUB, ["chat", "jo"], ["send", "hi"]], []],
  ["a call of what a call answered", [...STUB, ["sendMessage", "jo"]], ["again"]],
  ["arguments that are not plain JSON", [...STUB, ["sendMessage", new Uint8Array(1)]], []],
];
test.for(REFUSED)(
  "a held verb with %s is refused: its approver could not see all of it",
  ([, resolved, extra]) => {
    expect(held(["itx.whatsapp.*"], resolved as ItxExpression, [...extra])).toHaveProperty(
      "refused",
    );
  },
);

function held(verbs: readonly string[], resolved: ItxExpression, extraArgs: unknown[] = []) {
  return heldVerbOf(
    verbs.map((verb) => ActRule.parse({ verb })),
    resolved,
    extraArgs,
    // the context's own table: `itx.whatsapp` is the stub, and anything under it follows
    (verb) => (verb[1] === "whatsapp" ? [...STUB, ...verb.slice(2)] : null),
  );
}
