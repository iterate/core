// sdk/loaded-worker.test.ts — what every loaded worker evaluates first, on the `cloudflare:workers`
// shim's base class.
import "./loaded-worker.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { expect, test } from "vitest";
import { currentCause } from "../cause.ts";
import { ITERATE_CAUSE_HEADER } from "../lib.ts";
import { IterateConfigEntrypoint } from "./index.ts";

test("every WorkerEntrypoint gets callWithCause and getItx, never enumerable: the walk runs a method under its call's cause, `using this.getItx()` releases, and a caller naming either is refused", async () => {
  const log: unknown[] = [];
  const env = {
    ITX: {
      get: (cause: unknown) => {
        log.push({ get: cause });
        return { append: () => log.push("append"), [Symbol.dispose]: () => log.push("dispose") };
      },
    },
  };
  const entrypoint = new Plain({} as never, env);
  // the shim's base class keeps no constructor arguments; the runtime's sets `env` from them
  Object.assign(entrypoint, { env });
  expect(Object.keys(WorkerEntrypoint.prototype)).toEqual([]);
  const cause = { chain: "a test's chain", depth: 1 };
  expect(await entrypoint.callWithCause(cause, [["act"]])).toBe(cause);
  expect(log).toEqual([{ get: cause }, "append", "dispose"]);
  for (const name of ["callWithCause", "getItx"])
    await expect(entrypoint.callWithCause(cause, [[name]])).rejects.toMatchObject({
      code: "NOT_A_METHOD",
    });
});

test("code outside any call runs under the newest cause its isolate saw, parent and all, never what only a call needs", async () => {
  const env = { ITX: { get: () => ({ append() {}, [Symbol.dispose]() {} }) } };
  const entrypoint = Object.assign(new Plain({} as never, env), { env });
  const cause = { chain: "a test's chain", depth: 2, parent: "/x@4", hops: 3, writeKey: "k" };
  await entrypoint.callWithCause(cause, [["act"]]);
  expect(currentCause()).toEqual({ chain: "a test's chain", depth: 2, parent: "/x@4" });
});

test("a request's fetch on the SDK's entrypoint leaves no newest cause behind, the mind's own deep one as a visitor's", async () => {
  const env = { ITX: { get: () => ({ append() {}, [Symbol.dispose]() {} }) } };
  const plain = Object.assign(new Plain({} as never, env), { env });
  const app = new (class extends IterateConfigEntrypoint {
    override async fetch(_request: Request) {
      return new Response(JSON.stringify(currentCause()));
    }
  })({} as never, {} as never);
  const deep = { chain: "an own chain", depth: 17, at: 1 };
  const own = new Request("https://app.example.org/", {
    headers: { [ITERATE_CAUSE_HEADER]: JSON.stringify(deep) },
  });
  await plain.callWithCause({ chain: "a call's chain", depth: 2 }, [["act"]]);
  const during = await (await app.fetch(own)).json();
  const afterOwn = currentCause();
  await plain.callWithCause({ chain: "a call's chain", depth: 2 }, [["act"]]);
  await app.fetch(new Request("https://app.example.org/"));
  expect({ during, afterOwn, afterVisitor: currentCause() }).toEqual({
    during: deep,
    afterOwn: undefined,
    afterVisitor: undefined,
  });
});

/** A WorkerEntrypoint that is no SDK host: `act` reaches its context through `getItx`. */
class Plain extends WorkerEntrypoint<{ ITX: object }> {
  // what loaded-worker.ts puts on every WorkerEntrypoint, typed for this test
  declare callWithCause: (cause: unknown, steps: [string][]) => Promise<unknown>;
  declare getItx: () => { append(): void } & Disposable;
  act() {
    using itx = this.getItx();
    itx.append();
    return currentCause();
  }
}
