// A queue consumer whose queue is gone (queue-consumers.ts), against a pretend Alchemy provider.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { goneQueueConsumerProvider } from "./queue-consumers.ts";

void test("a consumer whose queue is gone counts as deleted, so a replace goes on", async () => {
  const provider = goneQueueConsumerProvider(pretendAlchemy({ _tag: "QueueNotFound" }));
  const exit = await Effect.runPromiseExit(provider.delete(deleteInput()));
  assert.equal(Exit.isSuccess(exit), true);
});

void test("any other failure of a consumer's delete still fails the deploy", async () => {
  const provider = goneQueueConsumerProvider(pretendAlchemy({ _tag: "CloudflareError" }));
  const exit = await Effect.runPromiseExit(provider.delete(deleteInput()));
  assert.equal(Exit.isFailure(exit), true);
});

void test("everything else is Alchemy's own", () => {
  const base = pretendAlchemy(null);
  const provider = goneQueueConsumerProvider(base);
  assert.equal(provider.diff, base.diff);
  assert.equal(provider.reconcile, base.reconcile);
});

/** Alchemy's consumer provider, whose delete fails with `failure` (or succeeds with none). */
function pretendAlchemy(failure: { _tag: string } | null) {
  // The cast: of the provider, only `delete`, `diff` and `reconcile` are called here.
  return {
    diff: () => Effect.succeed(undefined),
    reconcile: () => Effect.succeed(undefined),
    delete: () => (failure ? Effect.fail(failure) : Effect.void),
  } as unknown as Parameters<typeof goneQueueConsumerProvider>[0];
}

function deleteInput() {
  // The cast: the pretend delete reads nothing of its input.
  return {} as Parameters<ReturnType<typeof goneQueueConsumerProvider>["delete"]>[0];
}
