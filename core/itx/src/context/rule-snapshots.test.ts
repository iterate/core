// RuleSnapshotCache sharing and lifetimes. Workerd request ownership is simulated at Promise.race.
import { expect, onTestFinished, test, vi } from "vitest";
import { ruleSnapshots, SNAPSHOT_TTL_MS, type RulesSnapshotAnswer } from "./rule-snapshots.ts";

test("a borrowed read that rejects only for its borrower is dropped and read again", async ({
  task,
}) => {
  const pending = Promise.withResolvers<RulesSnapshotAnswer>();
  const owner = ruleSnapshots.get(task.name, () => pending.promise);
  // Workerd can reject a borrower's wait while the owner's read stays pending, including its cleanup.
  vi.spyOn(Promise, "race").mockRejectedValueOnce(crossRequestError());
  const read = vi.fn(async () => snapshotAnswer("fresh"));
  const warn = vi.spyOn(console, "warn");

  await expect(ruleSnapshots.get(task.name, read)).resolves.toMatchObject({ version: "fresh" });
  expect(read).toHaveBeenCalledTimes(1);
  await expect(ruleSnapshots.get(task.name, read)).resolves.toMatchObject({ version: "fresh" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "rule-snapshot.platform-failure-borrowed-read",
      context: task.name,
    }),
  );
  pending.resolve(snapshotAnswer("old"));
  await owner;
});

test.for([
  { name: "cross-request failure", error: crossRequestError() },
  { name: "owner failure", error: new Error("owner read failed") },
])("a call's own $name still throws", async ({ error }, { task }) => {
  const read = vi.fn(async () => {
    throw error;
  });
  await expect(ruleSnapshots.get(task.name, read)).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
});

test("a borrower's own reread failure still throws", async ({ task }) => {
  const pending = Promise.withResolvers<RulesSnapshotAnswer>();
  const owner = ruleSnapshots.get(task.name, () => pending.promise);
  vi.spyOn(Promise, "race").mockRejectedValueOnce(crossRequestError());
  const error = new Error("this call's read failed");
  const read = vi.fn(async () => {
    throw error;
  });

  await expect(ruleSnapshots.get(task.name, read)).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(snapshotAnswer());
  await owner;
});

test("a shared rejection still fails its owner while the borrower reads again", async ({
  task,
}) => {
  const pending = Promise.withResolvers<RulesSnapshotAnswer>();
  const error = new Error("owner read failed");
  const owner = expect(ruleSnapshots.get(task.name, () => pending.promise)).rejects.toBe(error);
  const read = vi.fn(async () => snapshotAnswer("fresh"));
  const borrower = ruleSnapshots.get(task.name, read);
  pending.reject(error);

  await owner;
  await expect(borrower).resolves.toMatchObject({ version: "fresh" });
  expect(read).toHaveBeenCalledTimes(1);
});

test("two borrowers rejecting the same read preserve the replacement read", async ({ task }) => {
  const pending = Promise.withResolvers<RulesSnapshotAnswer>();
  const replacement = Promise.withResolvers<RulesSnapshotAnswer>();
  const owner = ruleSnapshots.get(task.name, () => pending.promise);
  vi.spyOn(Promise, "race")
    .mockRejectedValueOnce(crossRequestError())
    .mockRejectedValueOnce(crossRequestError());
  const read = vi.fn(() => replacement.promise);
  const second = ruleSnapshots.get(task.name, read);
  const third = ruleSnapshots.get(task.name, read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  replacement.resolve(snapshotAnswer("fresh"));

  await expect(second).resolves.toMatchObject({ version: "fresh" });
  await expect(third).resolves.toMatchObject({ version: "fresh" });
  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(snapshotAnswer());
  await owner;
});

test("two healthy callers share one read", async ({ task }) => {
  const pending = Promise.withResolvers<RulesSnapshotAnswer>();
  const read = vi.fn(() => pending.promise);
  const owner = ruleSnapshots.get(task.name, read);
  const borrower = ruleSnapshots.get(task.name, read);
  pending.resolve(snapshotAnswer());

  expect(await borrower).toBe(await owner);
  expect(read).toHaveBeenCalledTimes(1);
});

test("half-life starts one read behind and a later caller can replace its dead read", async ({
  task,
}) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const pending = Promise.withResolvers<RulesSnapshotAnswer>();
  const read = vi.fn(async () => snapshotAnswer());
  const keepAlive = vi.fn<(reading: Promise<unknown>) => void>();
  await ruleSnapshots.get(task.name, read, keepAlive);
  await vi.advanceTimersByTimeAsync(SNAPSHOT_TTL_MS / 2 - 1);
  await ruleSnapshots.get(task.name, read, keepAlive);
  expect(read).toHaveBeenCalledTimes(1);

  read.mockImplementationOnce(() => pending.promise);
  await vi.advanceTimersByTimeAsync(1);
  await ruleSnapshots.get(task.name, read, keepAlive);
  await ruleSnapshots.get(task.name, read, keepAlive);
  expect(read).toHaveBeenCalledTimes(2);
  expect(keepAlive).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(SNAPSHOT_TTL_MS / 2);
  vi.spyOn(Promise, "race").mockRejectedValueOnce(crossRequestError());
  read.mockResolvedValueOnce(snapshotAnswer("fresh"));
  await expect(ruleSnapshots.get(task.name, read)).resolves.toMatchObject({ version: "fresh" });
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenLastCalledWith("v1");
  pending.resolve(snapshotAnswer());
  await keepAlive.mock.calls[0]![0];
  await expect(ruleSnapshots.get(task.name, read)).resolves.toMatchObject({ version: "fresh" });
  expect(read).toHaveBeenCalledTimes(3);
});

function snapshotAnswer(version = "v1"): RulesSnapshotAnswer {
  return { version, rules: [], routing: { fetchRoutes: {}, ingressTarget: null } };
}

function crossRequestError(): Error {
  return new Error(
    "This promise was created by a request that has since ended, so it can never settle. " +
      "With the handle_cross_request_promise_resolution compatibility flag, a promise can only " +
      "settle in the request that created it, and settling it after that request ends is dropped.",
  );
}
