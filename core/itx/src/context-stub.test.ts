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
  // plain data in an object is copied, and its session let go too: nobody else would
  next = { path: "/", parts: [1, { deep: null }] };
  const copied = await context.invoke("itx.whoami()");
  expect(copied).toEqual({ path: "/", parts: [1, { deep: null }] });
  expect(copied).not.toBe(next);
  expect(released).toHaveLength(6);
  // an answer that holds a stub (a function, or an object of a class of its own) is the answer
  // itself: the disposer moves onto it, for whoever holds it
  class Stub {}
  for (const held of [{ repo: new Stub() }, { call: () => 1 }, [new Stub()], { at: new Date(0) }]) {
    next = held;
    const answer = (await context.invoke("itx.whoami()")) as object & Disposable;
    expect(answer).toBe(held);
    const before = released.length;
    answer[Symbol.dispose]();
    expect(released).toHaveLength(before + 1);
  }
});

test("what a context answers to append, read and the send reservations is copied, and its session let go", async () => {
  const released: string[] = [];
  // each answer carries its call's disposer, as workerd hands it back
  const held = <T extends object>(name: string, value: T) =>
    Object.assign(value, { [Symbol.dispose]: () => void released.push(name) });
  const namespace = {
    getByName: () => ({
      append: async () => held("append", [{ type: "proof/crossed", offset: 3 }]),
      read: async () =>
        held("read", { events: [{ offset: 3 }], scannedThroughOffset: 3, atHead: true }),
      reserveSend: async () => held("reserveSend", { reserved: true }),
      releaseSend: async () => undefined,
    }),
  };
  const context = reachableContext(namespace as never, DurableObjectNameCodec.address("/"), "test");
  expect(await context.append({ type: "proof/crossed" })).toEqual([
    { type: "proof/crossed", offset: 3 },
  ]);
  expect(await context.read(0, 10)).toEqual({
    events: [{ offset: 3 }],
    scannedThroughOffset: 3,
    atHead: true,
  });
  expect(await context.reserveSend("k")).toEqual({ reserved: true });
  expect(await context.releaseSend("k")).toBeUndefined();
  expect(released).toEqual(["append", "read", "reserveSend"]);
});

test("a key named __proto__ in an event's payload is data: the copy holds it as the original does", async () => {
  // An event's payload is anyone's JSON, and JSON.parse makes `__proto__` an own key.
  const stored = JSON.parse(
    '[{"type":"proof/odd","payload":{"__proto__":{"x":1},"constructor":"c","prototype":null,"kept":true}}]',
  );
  let disposed = 0;
  const namespace = {
    getByName: () => ({
      read: async () =>
        Object.assign(
          { events: stored, scannedThroughOffset: 1, atHead: true },
          { [Symbol.dispose]: () => void (disposed += 1) },
        ),
    }),
  };
  const context = reachableContext(namespace as never, DurableObjectNameCodec.address("/"), "test");
  const page = (await context.read(0, 10)) as unknown as { events: typeof stored };
  expect(disposed).toBe(1);
  const payload = page.events[0].payload;
  // the same bytes, the same own keys, and an ordinary object: nothing reached the prototype
  expect(JSON.stringify(page.events)).toBe(JSON.stringify(stored));
  expect(Object.keys(payload)).toEqual(["__proto__", "constructor", "prototype", "kept"]);
  expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
  expect(payload.x).toBeUndefined();
  // and a copy: the original went with its session
  expect(Object.is(page.events, stored)).toBe(false);
});
