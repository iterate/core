import { ActRule } from "iterate/acts";
import { expect, test, vi } from "vitest";
import { gateOf, heldVerbRules } from "./held-verb-rules.ts";

test("the verb rules are read once for a few seconds, and a mail's rule is not among them", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({ rules: [verb, mail] }));
  const rules = heldVerbRules(read, 5_000);
  expect([await rules(), await rules()]).toEqual([[verb], [verb]]);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  await rules();
  expect(read).toHaveBeenCalledTimes(2);
});

test("a vault that cannot be reached stops no call and lifts no rule: the last rules stand", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const read = vi
    .fn<() => Promise<{ rules: ActRule[] }>>()
    .mockRejectedValueOnce(new Error("the vault is away"))
    .mockResolvedValueOnce({ rules: [verb] })
    .mockRejectedValue(new Error("the vault is away"));
  const rules = heldVerbRules(read, 5_000);
  expect(await rules()).toEqual([]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await rules()).toEqual([verb]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await rules()).toEqual([verb]);
});

test("the gate's answers are released when the kernel has read them: a rules read and an ask leave no session of the boundary open", async () => {
  const boundary = pretendBoundary();
  const gate = gateOf(() => boundary.egress);

  expect(await gate.verbRules()).toEqual([verb]);
  expect(boundary.open()).toBe(0);
  // an ask is answered and let go at once: the caller that waits is the next ask, not this answer
  expect(await gate.ask({ text: "an act's text" })).toEqual({ state: "free", facts: [] });
  expect(boundary.open()).toBe(0);
  expect(boundary).toMatchObject({ asked: 2, released: 2 });
});

/** The boundary's two calls of the gate, as Workers RPC answers them: an object that holds its
 *  call's session open until its disposer runs. */
function pretendBoundary() {
  let open = 0;
  const counts = { asked: 0, released: 0 };
  const held = <T extends object>(answer: T): T => {
    counts.asked += 1;
    open += 1;
    return Object.defineProperty(answer, Symbol.dispose, {
      value: () => {
        open -= 1;
        counts.released += 1;
      },
    });
  };
  return {
    egress: {
      actRules: async () => held({ locked: false, rules: [verb, mail] }),
      act: async () => held({ state: "free" as const, facts: [] }),
    },
    open: () => open,
    get asked() {
      return counts.asked;
    },
    get released() {
      return counts.released;
    },
  };
}

const verb = ActRule.parse({ verb: "itx.whatsapp.sendMessage" });
const mail = ActRule.parse({ verb: "email.send" });
