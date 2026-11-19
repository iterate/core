// The config's `email` hook is the platform's to call: `workersRoot` refuses it to anyone else
// before it loads any code.
import type { InvokeHandle } from "iterate/expression";
import { errorCode } from "iterate/lib";
import { expect, test } from "vitest";
import type { Caller } from "../caller.ts";
import { workersRoot } from "./built-ins.ts";

const mail = { mail: { subject: "invented" }, forward: async () => {} };

test.for([
  { who: "loaded code", caller: { principal: null, app: true } },
  { who: "a member", caller: { principal: { actor: "user_1" } } },
  { who: "the delivery loop", caller: { principal: null, delivery: "hash" } },
  {
    who: "a signed statement that the platform carries in",
    caller: { principal: null, platform: true, signer: { principal: { actor: "x" }, key: "k" } },
  },
] as { who: string; caller: Caller }[])(
  "deliverEmail is refused to $who, and the code is never loaded",
  async ({ caller }) => {
    const refused: unknown = await Promise.resolve(
      handleFor(caller).invoke([["deliverEmail", mail]]),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect({ code: errorCode(refused), message: String(refused) }).toEqual({
      code: "FORBIDDEN",
      message:
        "Error: workers.get(spec).deliverEmail is the platform's own call, for a mail it received",
    });
  },
);

test("email itself is no caller's: the platform goes through deliverEmail", async () => {
  await expect(
    handleFor({ principal: null, platform: true }).invoke([["email", mail]]),
  ).rejects.toMatchObject({ code: "NOT_A_METHOD" });
});

test("the platform's own deliverEmail passes the check and goes on to load the config", async () => {
  // no loader here: the call fails past the check, where a host would load the code
  const failed: unknown = await Promise.resolve(
    handleFor({ principal: null, platform: true }).invoke([["deliverEmail", mail]]),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(errorCode(failed)).not.toBe("FORBIDDEN");
});

function handleFor(caller: Caller) {
  const root = workersRoot({
    path: "/",
    iterateContextName: "mind",
    itxEntrypoint: () => {
      throw new Error("no entrypoint in this test");
    },
    invoke: async () => {
      throw new Error("no invoke in this test");
    },
    caller: () => caller,
    delivery: () => caller.delivery,
    cause: () => undefined,
    namedWorker: async () => {
      throw new Error("no named worker in this test");
    },
  });
  return root.get({
    source: { "worker.js": "" },
    mainModule: "worker.js",
  } as never) as InvokeHandle;
}
