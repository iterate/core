import { ActRule } from "iterate/acts";
import type { ItxExpression } from "iterate/expression";
import { expect, test } from "vitest";
import { calledNameOf, heldVerbOf, refuseMoreArguments } from "./held-verbs.ts";

// where the mind's rule `itx.whatsapp` points: the stub a bridge lent
const STUB: ItxExpression = ["itx", "builtins", "rpcStubs", ["get", "k1"]];
// where `itx.config` points: the worker of the mind's own code
const SPEC = { repo: "/repos/config", ref: "main" };
const WORKER: ItxExpression = ["itx", "builtins", "workers", ["get", SPEC]];

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

// THE SAME FUNCTION BY ANOTHER SPELLING OF A STEP. Each of these reaches the function the rule
// names. The walk does the same thing for each, and none was held.
const SAID = ["jo", { text: "hi" }];
const OTHER_SPELLINGS: [what: string, resolved: ItxExpression, extraArgs: unknown[]][] = [
  [
    "an argument more on the step that finds the stub, which the finder does not read",
    ["itx", "builtins", "rpcStubs", ["get", "k1", 0], ["sendMessage", ...SAID]],
    [],
  ],
  [
    "the stub's own invoke, given the call as its steps",
    [...STUB, ["invoke", [["sendMessage", ...SAID]]]],
    [],
  ],
  [
    "invoke read as a name and then called",
    [...STUB, "invoke", ["", [["sendMessage", ...SAID]]]],
    [],
  ],
  [
    "an invoke inside an invoke",
    [...STUB, ["invoke", [["invoke", [["sendMessage", ...SAID]]]]]],
    [],
  ],
  [
    "invoke given the verb's name, and the arguments beside the expression",
    [...STUB, ["invoke", ["sendMessage"]]],
    SAID,
  ],
  ["the verb read as a name and then called", [...STUB, "sendMessage", ["", ...SAID]], []],
];
test.for(OTHER_SPELLINGS)(
  "a held verb reached by %s is held as the same act",
  ([, resolved, extra]) => {
    expect(held(["itx.whatsapp.sendMessage"], resolved, [...extra])).toEqual({
      act: "itx.whatsapp.sendMessage",
      args: SAID,
    });
    expect(held(["itx.whatsapp.*"], resolved, [...extra])).toEqual({
      act: "itx.whatsapp.sendMessage",
      args: SAID,
    });
  },
);

test("a verb of a worker is held by the same spellings: an argument more on the step that loads it, and its own invoke", () => {
  const post = { act: "itx.config.slack", args: ["chat.postMessage", { text: "hi" }] };
  const call: ItxExpression[number] = ["slack", "chat.postMessage", { text: "hi" }];
  expect([
    held(["itx.config.slack"], [...WORKER, call]),
    held(["itx.config.slack"], ["itx", "builtins", "workers", ["get", SPEC, 0], call]),
    held(["itx.config.slack"], [...WORKER, ["invoke", [call]]]),
    // the same spec with its keys in another order is the same worker
    held(
      ["itx.config.slack"],
      ["itx", "builtins", "workers", ["get", { ref: "main", repo: "/repos/config" }], call],
    ),
  ]).toEqual([post, post, post, post]);
});

test("a step that finds a thing is the same step by its name and its first argument: a facet with no spec, or with another, is the same facet", () => {
  // where `itx.agents` points here: a facet by its name, with the spec it was made by
  const send = { act: "itx.agents.send", args: ["hi"] };
  const facet = (...found: unknown[]): ItxExpression => [
    "itx",
    "builtins",
    "facets",
    ["get", ...found],
    ["send", "hi"],
  ];
  expect([
    held(["itx.agents.send"], facet("agents", { className: "Agents" })),
    held(["itx.agents.send"], facet("agents")),
    held(["itx.agents.send"], facet("agents", { className: "Another" })),
    held(["itx.agents.send"], facet("agents", { className: "Agents" }, 0)),
    // another name is another facet
    held(["itx.agents.send"], facet("other", { className: "Agents" })),
  ]).toEqual([send, send, send, send, null]);
});

test("the stub called through its own applyRoot is the stub called", () => {
  expect(held(["itx.whatsapp.*"], [...STUB, ["applyRoot", ["x"]]])).toEqual({
    act: "itx.whatsapp",
    args: ["x"],
  });
});

test("a function of the thing that is itself named invoke is still held by a rule that names it", () => {
  // read as the walk does it, the steps end at `x`; as written, they call `thing.invoke`
  expect(held(["itx.whatsapp.thing.invoke"], [...STUB, "thing", ["invoke", [["x"]]]])).toEqual({
    act: "itx.whatsapp.thing.invoke",
    args: [[["x"]]],
  });
});

test("an invoke whose steps are no list is refused where a rule holds a verb of that thing: nobody could read what it calls", () => {
  const unread = { refused: expect.stringContaining("write the call itself") };
  expect([
    held(["itx.whatsapp.sendMessage"], [...STUB, ["invoke", "sendMessage('jo')"]]),
    held(["itx.whatsapp.*"], [...STUB, ["invoke", { steps: [["sendMessage"]] }]]),
    held(["itx.whatsapp.sendMessage"], [...STUB, ["invoke", [["sendMessage", "jo"], 7]]]),
  ]).toEqual([unread, unread, unread]);
  // on another stub it is no business of this rule
  expect(
    held(
      ["itx.whatsapp.sendMessage"],
      ["itx", "builtins", "rpcStubs", ["get", "other"], ["invoke", "x"]],
    ),
  ).toBeNull();
});

test("another verb stays free by every spelling, and so does another stub", () => {
  expect([
    held(["itx.whatsapp.sendMessage"], [...STUB, ["invoke", [["logout"]]]]),
    held(
      ["itx.whatsapp.sendMessage"],
      ["itx", "builtins", "rpcStubs", ["get", "k1", 0], ["logout"]],
    ),
    held(
      ["itx.whatsapp.sendMessage"],
      ["itx", "builtins", "rpcStubs", ["get", "other", 0], ["sendMessage"]],
    ),
    // a first argument that is another key is another stub, whatever comes after it
    held(
      ["itx.whatsapp.sendMessage"],
      ["itx", "builtins", "rpcStubs", ["get", "k2", "k1"], ["sendMessage"]],
    ),
    held(
      ["itx.config.slack"],
      ["itx", "builtins", "workers", ["get", { repo: "/repos/other" }], ["slack"]],
    ),
  ]).toEqual([null, null, null, null, null]);
});

test("a step that finds a thing takes its own arguments and no more", () => {
  expect(() => refuseMoreArguments("rpcStubs.get(key)", [])).not.toThrow();
  expect(() => refuseMoreArguments("rpcStubs.get(key)", [0])).toThrow(
    "rpcStubs.get(key) takes no argument after its own, and got 1 more",
  );
  // an argument that is given as undefined is given
  expect(() => refuseMoreArguments("workers.get(spec)", [undefined])).toThrow("got 1 more");
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

// Rows that fill in the call (`sameCallAroundTheHole` in ./held-verbs.ts): one pins a method, one
// merges the call's fields into its own.
const POST: ItxExpression = [...WORKER, ["slack", "chat.postMessage", { "@": true }]];
const REACT: ItxExpression = [
  ...WORKER,
  ["slack", "reactions.add", { channel: "C1", "...@": true }],
];

test("a rule on a name whose row fills in the call's arguments holds that call, by every name that reaches it", () => {
  const call: ItxExpression = [
    ...WORKER,
    ["slack", "chat.postMessage", { channel: "C1", text: "hi" }],
  ];
  expect(held(["itx.slack.postMessage"], call)).toEqual({
    act: "itx.slack.postMessage",
    args: [{ channel: "C1", text: "hi" }],
  });
  // the pinned argument says which call it is: another method of the same function is not held
  expect(
    held(["itx.slack.postMessage"], [...WORKER, ["slack", "chat.delete", { ts: "1" }]]),
  ).toBeNull();
  // the name read as a value, and another function of the worker, are no call of it
  expect(held(["itx.slack.postMessage"], [...WORKER, "slack"])).toBeNull();
  expect(
    held(["itx.slack.postMessage"], [...WORKER, ["other", "chat.postMessage", {}]]),
  ).toBeNull();
});

test("a row that merges the call's object into its own holds a call with the pinned keys, whatever else it gives", () => {
  expect(
    held(
      ["itx.slack.react"],
      [...WORKER, ["slack", "reactions.add", { channel: "C1", name: "eyes" }]],
    ),
  ).toEqual({ act: "itx.slack.react", args: [{ name: "eyes" }] });
  // another channel is not the call the row makes
  expect(
    held(
      ["itx.slack.react"],
      [...WORKER, ["slack", "reactions.add", { channel: "C2", name: "eyes" }]],
    ),
  ).toBeNull();
});

// `itx.slack.pin => itx.config.slack("pins.add", { channel: @ })`: the hole is inside an argument.
const PIN: ItxExpression = [...WORKER, ["slack", "pins.add", { channel: { "@": true } }]];

test.for([
  ["an argument after the row's", ["slack", "pins.add", { channel: "C1" }, "more"]],
  ["a key beside the row's", ["slack", "pins.add", { channel: "C1", timestamp: "1" }]],
] as const)(
  "the call a row makes, given %s, is refused: it does the same and no row could have made it",
  ([, call]) => {
    expect(held(["itx.slack.pin"], [...WORKER, [...call]])).toEqual({
      refused: expect.stringContaining("only as the call its row makes"),
    });
  },
);

test("a call with a hole inside an argument is held as the argument its caller gave", () => {
  expect(held(["itx.slack.pin"], [...WORKER, ["slack", "pins.add", { channel: "C1" }]])).toEqual({
    act: "itx.slack.pin",
    args: ["C1"],
  });
});

test("a held call that a row fills in is one call: what goes on after it is refused", () => {
  expect(
    held(["itx.slack.postMessage"], [...WORKER, ["slack", "chat.postMessage", {}], "ok"]),
  ).toEqual({ refused: expect.stringContaining("only as one call") });
});

function held(verbs: readonly string[], resolved: ItxExpression, extraArgs: unknown[] = []) {
  return heldVerbOf(
    verbs.map((verb) => ActRule.parse({ verb })),
    resolved,
    extraArgs,
    // the context's own table: `itx.whatsapp` is the stub, and anything under it follows
    (verb) =>
      verb[1] === "whatsapp"
        ? [...STUB, ...verb.slice(2)]
        : verb[1] === "slack"
          ? { react: REACT, pin: PIN }[String(verb[2])] || POST
          : verb[1] === "config"
            ? [...WORKER, ...verb.slice(2)]
            : verb[1] === "agents"
              ? [
                  "itx",
                  "builtins",
                  "facets",
                  ["get", "agents", { className: "Agents" }],
                  ...verb.slice(2),
                ]
              : null,
  );
}
