import { ActRule } from "iterate/acts";
import type { ItxExpression } from "iterate/expression";
import { expect, test } from "vitest";
import { calledNameOf, heldVerbOf } from "./held-verbs.ts";

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

test("a rule for every verb under a name holds each of them, and the name itself when it is called", () => {
  expect(held(["itx.whatsapp.*"], [...STUB, ["logout"]])).toEqual({
    act: "itx.whatsapp.logout",
    args: [],
  });
  expect(held(["itx.whatsapp.*"], [...STUB, "groups", ["leave", "g1"]])).toEqual({
    act: "itx.whatsapp.groups.leave",
    args: ["g1"],
  });
  // the stub itself called, where a bridge lends a function: it could answer the same verbs
  expect(held(["itx.whatsapp.*"], STUB, ["x"])).toEqual({ act: "itx.whatsapp", args: ["x"] });
  // the stub read as a value is no call
  expect(held(["itx.whatsapp.*"], STUB)).toBeNull();
});

test("a rule for one verb holds every verb under it too: a function reached through the verb is the verb's", () => {
  expect(held(["itx.whatsapp.sendMessage"], [...STUB, "sendMessage", ["now"]])).toEqual({
    act: "itx.whatsapp.sendMessage.now",
    args: [],
  });
  expect(held(["itx.whatsapp.sendMessage"], [...STUB, "sendMessage", "now"], ["jo"])).toEqual({
    act: "itx.whatsapp.sendMessage.now",
    args: ["jo"],
  });
});

// THE CALL RUNS WHATEVER COMES AFTER IT. Each of these calls the verb and then goes on, and so
// ended in something that is no call of the verb: none was held, and each ran.
const GOES_ON: [what: string, resolved: ItxExpression, extraArgs: unknown[]][] = [
  ["a name of its answer is read", [...STUB, ["sendMessage", "jo", { text: "hi" }], "ok"], []],
  ["a function of its answer is called", [...STUB, ["sendMessage", "jo"], ["toString"]], []],
  ["two names of its answer are read", [...STUB, ["sendMessage", "jo"], "key", "id"], []],
  ["its answer is called", [...STUB, ["sendMessage", "jo"]], ["again"]],
];
test.for(GOES_ON)(
  "a call of a held verb after which %s is refused, by a rule for the verb and by a rule for every verb under its name",
  ([, resolved, extra]) => {
    const refused = { refused: expect.stringContaining("nothing after it") };
    expect([
      held(["itx.whatsapp.sendMessage"], resolved, [...extra]),
      held(["itx.whatsapp.*"], resolved, [...extra]),
    ]).toEqual([refused, refused]);
  },
);

const NOT_HELD: [what: string, rules: string[], resolved: ItxExpression][] = [
  ["another verb of the same stub", ["itx.whatsapp.sendMessage"], [...STUB, ["logout"]]],
  [
    "a name under the verb read as a value",
    ["itx.whatsapp.sendMessage"],
    [...STUB, "sendMessage", "length"],
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

test("what a call's name is now leaves out the call's own arguments and keeps which thing it is", () => {
  const send = (...args: unknown[]): ItxExpression => [...STUB, ["sendMessage", ...args]];
  // the same function with other arguments is the same name
  expect(calledNameOf(send("jo", { text: "hi" }))).toEqual(calledNameOf(send("al")));
  expect(calledNameOf(send("jo"))).toEqual([...STUB, "sendMessage"]);
  // arguments beside the expression: its end is the name already
  expect(calledNameOf([...STUB, "sendMessage"])).toEqual([...STUB, "sendMessage"]);
  // another stub, and another function of the same stub, are other names
  expect(
    calledNameOf(["itx", "builtins", "rpcStubs", ["get", "k2"], ["sendMessage", "jo"]]),
  ).not.toEqual(calledNameOf(send("jo")));
  expect(calledNameOf([...STUB, ["logout"]])).not.toEqual(calledNameOf(send("jo")));
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
