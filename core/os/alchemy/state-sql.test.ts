// alchemy/state-sql.test.ts — ALCHEMY'S STATE OVER A DURABLE OBJECT'S SQLITE (state-sql.ts), on
// node:sqlite, through the State service as Alchemy's engine reaches it. The engine over the store
// is the live proofs' (tasks/alchemy-native-deploy.md, "The facet's proofs").
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import { State, type StateService } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { nodeSqliteDurableObjectStorage } from "iterate/stream/test-support";
import { expect, test } from "vitest";
import { sqlState, type StateSql } from "./state-sql.ts";

const stage = { stack: "iterate", stage: "acme-os" };

test("a resource's state and the stack's output read back as set, a Redacted value revived", async () => {
  const worker = created("Worker", { env: { KEY: Redacted.make("the-key") } });
  const read = await withState((state) =>
    Effect.all([
      state.set({ ...stage, fqn: "Worker", value: worker }),
      state.setOutput({ ...stage, value: { url: "https://acme-os.test" } }),
    ]).pipe(
      Effect.andThen(
        Effect.all({
          resource: state.get({ ...stage, fqn: "Worker" }),
          output: state.getOutput(stage),
        }),
      ),
    ),
  );
  const key = expect.toSatisfy((v) => Redacted.isRedacted(v) && Redacted.value(v) === "the-key");
  expect(read).toMatchObject({
    resource: { status: "created", props: { env: { KEY: key } } },
    output: { url: "https://acme-os.test" },
  });
});

// a missing row would plan the resource's re-creation
test("a row that does not parse fails as a StateStoreError, never as a missing resource", async () => {
  const { sql } = nodeSqliteDurableObjectStorage();
  await withState(() => Effect.void, sql);
  sql.exec("insert into alchemy_resource_state values ('iterate', 'acme-os', 'Worker', '{', 0)");
  await expect(
    withState((state) => state.get({ ...stage, fqn: "Worker" }), sql),
  ).rejects.toMatchObject({
    _tag: "StateStoreError",
    message: "durable object sqlite state: get failed",
  });
});

/** Runs `f` on the store over `sql`, a fresh one unless given, as Alchemy's engine reaches it:
 *  through the State service. */
function withState<A, E>(
  f: (state: StateService) => Effect.Effect<A, E>,
  sql: StateSql = nodeSqliteDurableObjectStorage().sql,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* yield* State);
    }).pipe(Effect.provide(sqlState(sql))),
  );
}

/** A resource's state as Apply commits it once the resource exists. */
function created(fqn: string, props: Record<string, unknown>): CreatedResourceState {
  return {
    status: "created",
    resourceType: "Test.Resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: "instance-1",
    providerVersion: 0,
    downstream: [],
    bindings: [],
    props,
    attr: {},
  };
}
