import { expect, test } from "vitest";
import { releasedAnswer } from "./lib.ts";

test("an answer of plain data is copied, and the answer that held its call's session is released", async () => {
  const session = pretendSession();
  const answer = session.held({ path: "/secrets/a", set: true });

  const copy = await releasedAnswer(Promise.resolve(answer));

  expect(copy).toEqual({ path: "/secrets/a", set: true });
  expect(copy).not.toBe(answer);
  expect(session).toMatchObject({ released: 1 });
});

test("a call that is refused is released by its own promise, which carries the disposer then, and the refusal goes on", async () => {
  const session = pretendSession();
  // as Workers RPC answers a verb that the receiver has not: the call's promise rejects
  const call = session.held(
    Promise.reject(new TypeError('The RPC receiver does not implement the method "listSecrets".')),
  );

  await expect(releasedAnswer(call)).rejects.toThrow("does not implement");

  expect(session).toMatchObject({ released: 1 });
});

test("a refused call with no disposer, as a plain promise is, is refused and nothing else", async () => {
  await expect(releasedAnswer(Promise.reject(new Error("no")))).rejects.toThrow("no");
});

/** A call's session, as Workers RPC keeps it: open until the disposer on its answer, or on its
 *  promise, runs. */
function pretendSession() {
  const counts = { released: 0 };
  return {
    held: <T extends object>(value: T): T =>
      Object.defineProperty(value, Symbol.dispose, { value: () => void (counts.released += 1) }),
    get released() {
      return counts.released;
    },
  };
}
