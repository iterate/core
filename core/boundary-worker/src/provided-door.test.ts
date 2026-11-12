// The door of a provide session (provided-door.ts) over a real capnweb session: what the home lab
// reads, and what happens to the answer that the boundary's own call got.
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { ProvidedDoor } from "./provided-door.ts";

test("an answer that the home lab has read is released, so the vault's session behind it ends", async () => {
  const door = pretendDoor();
  using session = sessionWith(new ProvidedDoor(door));

  expect(await session.secret("/secrets/a", "describe")).toEqual({ path: "/secrets/a", set: true });
  expect(door.open()).toBe(0);
  // ten at once, as `secrets.list()` asks
  await Promise.all(
    Array.from({ length: 10 }, (_, at) => session.secret(`/secrets/${at}`, "describe")),
  );
  expect(door).toMatchObject({ asked: 11, released: 11 });
  // an answer that is no object has no session to keep
  expect(await session.isMember("ada@example.com")).toBe(true);
  expect(door.open()).toBe(0);
});

test("a refusal reaches the home lab as the door threw it", async () => {
  using session = sessionWith(new ProvidedDoor(pretendDoor()));
  await expect(session.act({ text: "no act" })).rejects.toThrow("the gate refuses this");
});

test("capnweb alone never releases such an answer: it stays open as long as the session", async () => {
  const door = pretendDoor();
  // the door served as it was before: a target whose methods answer the door's own answers
  class Bare extends RpcTarget {
    secret(path: string) {
      return door.secret(path);
    }
  }
  using session = sessionWith(new Bare());

  expect(await session.secret("/secrets/a", "describe")).toEqual({ path: "/secrets/a", set: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(door).toMatchObject({ asked: 1, released: 0 });
});

/** What the home lab calls: the door's methods by name, over the session. */
type Calls = {
  secret(path: string, verb: string): Promise<unknown>;
  isMember(email: string): Promise<boolean>;
  act(input: { text: string }): Promise<unknown>;
};

/** A capnweb session whose far end serves `main`, as the provide session serves its door. */
function sessionWith(main: RpcTarget) {
  const { port1, port2 } = new MessageChannel();
  newMessagePortRpcSession(port1, main);
  return newMessagePortRpcSession<Calls>(port2);
}

/** The boundary's Door as its stub answers here: plain data that carries the call's disposer, as
 *  workerd puts one on every answer across Workers. It counts the answers that are still held. */
function pretendDoor() {
  const door = {
    asked: 0,
    released: 0,
    open: () => door.asked - door.released,
    secret: async (path: string) => {
      door.asked += 1;
      return Object.defineProperty({ path, set: true }, Symbol.dispose, {
        value: () => void (door.released += 1),
      });
    },
    isMember: async () => true,
    act: async () => {
      throw new Error("the gate refuses this");
    },
  };
  return door;
}
