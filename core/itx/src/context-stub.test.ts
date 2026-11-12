import { expect, test } from "vitest";
import { reachableContext } from "./context-stub.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";

test("an answer from another context is released: at once when it is a plain value, by its holder when it is an object", async () => {
  const released: string[] = [];
  let next: unknown;
  // workerd puts a disposer on what a call across contexts answers; until it runs, the call's
  // session is held open, and the runtime warns when it is dropped unreleased
  const namespace = {
    getByName: () => ({
      invokeSafe: async () => ({
        ok: true,
        data: next,
        [Symbol.dispose]: () => void released.push(JSON.stringify(next) ?? "undefined"),
      }),
    }),
  };
  const context = reachableContext(namespace as never, DurableObjectNameCodec.address("/"), "test");
  // a plain value has nowhere to carry the disposer, and nothing in it to keep alive
  for (const plain of [42, "done", true, null, undefined]) {
    next = plain;
    expect(await context.invoke("itx.whoami()")).toBe(plain);
  }
  expect(released).toEqual(["42", '"done"', "true", "null", "undefined"]);
  // an object may hold stubs of the other context: the disposer moves onto it, for whoever holds it
  next = { path: "/" };
  const answer = (await context.invoke("itx.whoami()")) as { path: string } & Disposable;
  expect(answer).toEqual({ path: "/" });
  expect(released).toHaveLength(5);
  answer[Symbol.dispose]();
  expect(released).toHaveLength(6);
});
