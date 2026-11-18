// A SANDBOX'S OWN SESSION, as the `iterate` CLI decides it (./mind-api.ts): when no bearer goes,
// and what a refusal says.
import { expect, test } from "vitest";
import { ownSandboxOf, sandboxSessionRefusal, sandboxVariablesOf } from "./mind-api.ts";

const BOX = "/agents/ada/box";

test("in a sandbox of the mind, with no token named, the connection is the sandbox's own", () => {
  expect(ownSandboxOf(sandboxVariablesOf("example.com", BOX), "example.com")).toBe(BOX);
});

test.for<{ name: string; env: Record<string, string | undefined> }>([
  { name: "a laptop", env: {} },
  { name: "the mind named and no sandbox", env: { ITERATE_MIND: "example.com" } },
  { name: "a sandbox and no mind named", env: { ITERATE_SANDBOX: BOX } },
  {
    name: "a sandbox of another mind",
    env: { ITERATE_MIND: "other.com", ITERATE_SANDBOX: BOX },
  },
  {
    name: "a token named, which wins",
    env: {
      ...sandboxVariablesOf("example.com", BOX),
      ITERATE_MIND_TOKEN: 'getSecret("/secrets/iterate-mind")',
    },
  },
])("the sign-in is as ever on $name", ({ env }) => {
  expect(ownSandboxOf(env, "example.com")).toBeNull();
});

test("a refused session says why, in the egress's words when it gave them", () => {
  const input = { sandbox: BOX, address: "example.com", status: 401 };
  expect(
    sandboxSessionRefusal({
      ...input,
      why: `the mind filters what it sends (the rule for itx.fetch at ${BOX})`,
    }),
  ).toBe(
    `The sandbox ${BOX} gets no session of its own with example.com: the mind filters what it sends (the rule for itx.fetch at ${BOX}). Its owner removes that rule to give it one. To act as a member instead, set ITERATE_MIND_TOKEN.`,
  );
  expect(sandboxSessionRefusal({ ...input, why: undefined })).toBe(
    `example.com answered 401 and served no session for the sandbox ${BOX}: its stack may be older than this CLI, or this is no sandbox of that mind. To act as a member instead, set ITERATE_MIND_TOKEN.`,
  );
});
