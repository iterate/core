import { InvokeHandle, type ItxExpressionInput } from "iterate/expression";
import { expect, test } from "vitest";
import type { Caller } from "../caller.ts";
import { callContext } from "./built-ins.ts";

test("an approved act's text goes with the one call, and not with a call of the handle that the call answered", async () => {
  const callers: Caller[] = [];
  const there = {
    fetch: async () => new Response(),
    invoke: async (expression: ItxExpressionInput, _args?: unknown[], caller?: Caller) => {
      callers.push(caller!);
      // the context answers a handle as its expression, and the caller's side makes the handle
      return callers.length === 1 ? { $itxHandleExpression: [...expression, "handle"] } : "sent";
    },
  };
  const handle = await callContext(
    () => there,
    ["itx", "agents", ["get", "/agents/one"]],
    [],
    { principal: null, approvedAct: "the act's text", path: "/agents/caller" },
    "/agents",
  );
  if (!(handle instanceof InvokeHandle)) throw new Error("the answer is no handle");

  expect(await handle.invoke([["send", "hello"]])).toBe("sent");
  expect(callers).toEqual([
    { principal: null, approvedAct: "the act's text", path: "/agents/caller" },
    { principal: null, path: "/agents/caller" },
  ]);
});
