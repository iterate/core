import { expect, test } from "vitest";
import type { ItxExpression } from "iterate/expression";
import { codedError, errorCode } from "iterate/lib";
import { egressRuleOfStart, ruleThenStart } from "./egress-rule.ts";

test("a start that names egress gives a rule for itx.fetch, and starts without it", () => {
  const target = ["itx", ["cd", "/"], "workers", ["get", { source: "x" }], "fetch"];
  expect(
    egressRuleOfStart(
      [["start", { egress: target, instance: "basic" }]],
      { principal: null },
      "/sandboxes/box",
    ),
  ).toEqual({
    rule: {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.fetch", target },
    },
    steps: [["start", { instance: "basic" }]],
  });
});

test("a start with no egress, or another verb, writes no rule", () => {
  expect(
    egressRuleOfStart([["start", { instance: "basic" }]], { principal: null }, "/sandboxes/box"),
  ).toBeNull();
  expect(egressRuleOfStart([["start"]], { principal: null }, "/sandboxes/box")).toBeNull();
  expect(egressRuleOfStart([["exec", ["ls"]]], { principal: null }, "/sandboxes/box")).toBeNull();
});

test("loaded code's egress is admitted as any row it writes: a built-in target is refused", () => {
  const steps: ItxExpression = [["start", { egress: ["itx", "builtins", "fetch"] }]];
  expect(() => egressRuleOfStart(steps, { principal: null, app: true }, "/sandboxes/box")).toThrow(
    /builtins/,
  );
  expect(
    egressRuleOfStart(steps, { principal: null }, "/sandboxes/box")?.rule.payload.target,
  ).toEqual(["itx", "builtins", "fetch"]);
});

const rule = {
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match: "itx.fetch", target: ["itx", ["cd", "/"], "fetch"] },
};
const refused = new Error(
  "sandbox /sandboxes/box: start takes one of image, containerSnapshot or from",
);

test("the rule is on before the start runs, so the box never sends unfiltered", async () => {
  const order: string[] = [];
  await ruleThenStart(
    rule,
    false,
    async () => void order.push("rule"),
    async () => void order.push("start"),
  );
  expect(order).toEqual(["rule", "start"]);
});

test("a refused append starts nothing", async () => {
  const order: string[] = [];
  const wall = new Error("the row wall");
  await expect(
    ruleThenStart(
      rule,
      false,
      () => Promise.reject(wall),
      async () => void order.push("start"),
    ),
  ).rejects.toBe(wall);
  expect(order).toEqual([]);
});

test("a refused start takes back its rule by compare-and-set, and never sets one", async () => {
  const appended: unknown[] = [];
  const append = async (event: unknown) => void appended.push(event);
  await expect(ruleThenStart(rule, false, append, () => Promise.reject(refused))).rejects.toBe(
    refused,
  );
  expect(appended.at(-1)).toEqual({
    type: rule.type,
    payload: { match: "itx.fetch", target: null, ifTarget: rule.payload.target },
  });
  // a box with an earlier rule of its own: putting it back would overwrite a later start's rule
  appended.length = 0;
  await expect(ruleThenStart(rule, true, append, () => Promise.reject(refused))).rejects.toThrow(
    /keeps the egress this start named/,
  );
  expect(appended).toEqual([rule]);
});

test("a start refused with a code keeps the code when the sandbox keeps the rule: a refusal, not a failure", async () => {
  const append = async () => {};
  const refusal = codedError("INVALID_INPUT", "sandbox /box runs already");
  const kept = await ruleThenStart(rule, true, append, () => Promise.reject(refusal)).catch(
    (error: unknown) => error,
  );
  expect({ code: errorCode(kept), message: (kept as Error).message }).toEqual({
    code: "INVALID_INPUT",
    message: expect.stringMatching(/^sandbox \/box runs already \(the sandbox keeps the egress/),
  });
  // an error with no code gets none
  const failed = await ruleThenStart(rule, true, append, () => Promise.reject(refused)).catch(
    (error: unknown) => error,
  );
  expect(errorCode(failed)).toBe(undefined);
});

test("a start still going on when its caller stops waiting keeps its rule", async () => {
  const appended: unknown[] = [];
  const slow = new Error(
    "sandbox /sandboxes/box is still starting (…): the start goes on, so try again",
  );
  await expect(
    ruleThenStart(
      rule,
      false,
      async (event) => void appended.push(event),
      () => Promise.reject(slow),
    ),
  ).rejects.toBe(slow);
  expect(appended).toEqual([rule]);
});
