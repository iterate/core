import { ActRule } from "iterate/acts";
import { expect, test, vi } from "vitest";
import { heldVerbRules } from "./held-verb-rules.ts";

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

const verb = ActRule.parse({ verb: "itx.whatsapp.sendMessage" });
const mail = ActRule.parse({ verb: "email.send" });
