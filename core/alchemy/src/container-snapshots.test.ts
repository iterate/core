// A destroy of a container application whose saved snapshots the registry refuses to delete
// (container-snapshots.ts), against a pretend Alchemy provider and pretend Cloudflare calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import { providerForMode, type ProviderService } from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  isSnapshotRefusal,
  type Leftover,
  leftoverLine,
  snapshotRefusalProvider,
} from "./container-snapshots.ts";

/** The registry's 403, as Alchemy's snapshot clean-up gives it. */
const refusal = {
  _tag: "ContainerSnapshotCleanupError",
  message:
    "Container registry DELETE /v2/account-1/cloudchamber-snapshots/8b2c/manifests/rootfs-set-1abf returned HTTP 403",
};
const application = { accountId: "account-1", applicationId: "app-1" };
const leftovers: Leftover[] = [
  { repository: "account-1/cloudchamber-snapshots/8b2c", tags: 40 },
  { repository: "account-1/cloudchamber-snapshots/6cef", tags: 3 },
];

void test("only the registry's 403 on a snapshot's delete counts as the refusal", () => {
  assert.equal(isSnapshotRefusal(refusal), true);
  assert.equal(
    isSnapshotRefusal({ ...refusal, message: refusal.message.replace("403", "500") }),
    false,
  );
  // the registry could not be reached
  assert.equal(
    isSnapshotRefusal({
      _tag: "ContainerSnapshotCleanupError",
      message: "Container registry DELETE /v2/x/manifests/y failed",
    }),
    false,
  );
  assert.equal(isSnapshotRefusal({ _tag: "ContainerApplicationNotFound" }), false);
  assert.equal(isSnapshotRefusal(undefined), false);
});

void test("a refused snapshot: the application is deleted, and each repository is named with its tag count", async () => {
  const run = destroy(refusal, { deleteFails: null });
  await Effect.runPromise(run.provider.delete(deleteInput()));
  assert.deepEqual(run.deleted, [application]);
  assert.deepEqual(run.said, leftovers.map(leftoverLine));
  assert.match(
    run.said[0]!,
    /^account-1\/cloudchamber-snapshots\/8b2c keeps 40 tags of this mind.s sandbox snapshots: /,
  );
});

void test("an application that is already gone: the destroy goes on", async () => {
  const run = destroy(refusal, { deleteFails: { _tag: "ContainerApplicationNotFound" } });
  const exit = await Effect.runPromiseExit(run.provider.delete(deleteInput()));
  assert.equal(Exit.isSuccess(exit), true);
  assert.equal(run.said.length, 2);
});

void test("any other failure still fails the destroy, and the application is not deleted", async () => {
  for (const failure of [
    {
      _tag: "ContainerSnapshotCleanupError",
      message: "Container registry GET /v2/_catalog failed",
    },
    { _tag: "CloudflareError", message: "Authentication error" },
  ]) {
    const run = destroy(failure, { deleteFails: null });
    const exit = await Effect.runPromiseExit(run.provider.delete(deleteInput()));
    assert.equal(Exit.isFailure(exit), true);
    assert.deepEqual(run.deleted, []);
    assert.deepEqual(run.said, []);
  }
  // a refusal, then a failure of the application's own delete
  const run = destroy(refusal, { deleteFails: { _tag: "CloudflareError" } });
  assert.equal(
    Exit.isFailure(await Effect.runPromiseExit(run.provider.delete(deleteInput()))),
    true,
  );
});

void test("a destroy that Alchemy finishes says nothing and calls nothing more", async () => {
  const run = destroy(null, { deleteFails: null });
  await Effect.runPromise(run.provider.delete(deleteInput()));
  assert.deepEqual(run.deleted, []);
  assert.deepEqual(run.said, []);
});

void test("Alchemy's engine reaches the wrapped delete through the provider's live mode", async () => {
  // a dual registration, as Alchemy's: the engine calls `providerForMode(service, mode)`
  const run = destroy(refusal, { deleteFails: null, dual: true });
  const live = await Effect.runPromise(providerForMode(run.provider, "live"));
  await Effect.runPromise(live.delete(deleteInput()));
  assert.deepEqual(run.deleted, [application]);
  assert.deepEqual(run.said, leftovers.map(leftoverLine));
  // the local variant has no registry, and stays Alchemy's own
  const local = await Effect.runPromise(providerForMode(run.provider, "local"));
  assert.equal(Exit.isFailure(await Effect.runPromiseExit(local.delete(deleteInput()))), true);
});

type ApplicationService = ProviderService<Cloudflare.Containers.DurableObjectApplication>;

/** The wrapper over a pretend Alchemy provider whose delete fails with `failure` (or succeeds with
 *  none), and a pretend application delete that fails with `deleteFails` (or records the call).
 *  `dual`: the provider is registered for two modes, as `ProviderLayer.dual` makes it. */
function destroy(
  failure: object | null,
  options: { deleteFails: { _tag: string } | null; dual?: boolean },
) {
  const said: string[] = [];
  const deleted: object[] = [];
  // The cast: of the provider, only `delete` is called here.
  const variant = {
    delete: () => (failure ? Effect.fail(failure) : Effect.void),
  } as unknown as ApplicationService;
  const base = options.dual
    ? { ...variant, modes: { live: Effect.succeed(variant), local: Effect.succeed(variant) } }
    : variant;
  const provider = snapshotRefusalProvider(
    base,
    {
      leftovers: () => Effect.succeed(leftovers),
      deleteContainerApplication: (input) =>
        options.deleteFails
          ? Effect.fail(options.deleteFails)
          : Effect.sync(() => void deleted.push(input)),
    },
    (line) => void said.push(line),
  );
  return { provider, said, deleted };
}

// The cast: the wrapper reads only `output` of its input.
function deleteInput() {
  return { id: "SandboxContainer-Containers", output: application } as unknown as Parameters<
    ApplicationService["delete"]
  >[0];
}
