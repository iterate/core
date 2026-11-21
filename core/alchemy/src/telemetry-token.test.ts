import assert from "node:assert/strict";
import { test } from "node:test";
import { Forbidden, InternalServerError, Unauthorized } from "@distilled.cloud/cloudflare/Errors";
import {
  State,
  StateStoreError,
  type PersistedState,
  type StateService,
} from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  deleteLegacyAccountApiToken,
  isTelemetryTokenPersisted,
  TelemetryToken,
  TelemetryTokenProvider,
  telemetryModeFromState,
  telemetryModeOf,
} from "./telemetry-token.ts";

void test("a stack's telemetry token is the one its state keeps, and a stack with none in state takes no new one", async () => {
  const kept = { value: Redacted.make("cf-telemetry-v1") };
  const reconcile = (output: typeof kept | undefined) =>
    Effect.gen(function* () {
      const provider = yield* TelemetryToken.Provider;
      // reconcile reads only `output`; the rest of Alchemy's context is left out
      return yield* provider.reconcile({
        id: "TelemetryToken",
        news: { name: "iterate-ada-telemetry" },
        output,
      } as Parameters<typeof provider.reconcile>[0]);
    }).pipe(Effect.provide(TelemetryTokenProvider()));
  const reused = await Effect.runPromise(reconcile(kept));
  assert.equal(Redacted.value(reused.value), "cf-telemetry-v1");
  const none = await Effect.runPromiseExit(reconcile(undefined));
  assert.equal(none._tag, "Failure");
  assert.match(JSON.stringify(none), /takes no new one/);
});

void test("telemetryModeOf reads minted, given, and off from the state and fails on state-store errors", async () => {
  const rowOf = (
    fqn: string,
    resourceType: string,
    attr: Record<string, unknown> = { value: Redacted.make("tok") },
  ) =>
    ({
      resourceType,
      namespace: undefined,
      fqn,
      logicalId: fqn,
      instanceId: `inst-${fqn}`,
      providerVersion: 1,
      status: "created",
      downstream: [],
      bindings: [],
      props: {},
      attr,
    }) as const satisfies PersistedState;

  const mintedCatalog = rowOf("TelemetryCatalogToken", "Cloudflare.ApiToken.AccountApiToken");
  const mintedAnalytics = rowOf("TelemetryAnalyticsToken", "Cloudflare.ApiToken.AccountApiToken");
  const givenRow = rowOf("TelemetryToken", "Iterate.TelemetryToken");

  assert.equal(isTelemetryTokenPersisted(undefined), false);
  assert.equal(isTelemetryTokenPersisted(givenRow), true);
  assert.equal(isTelemetryTokenPersisted({ ...givenRow, status: "deleting" }), false);
  assert.equal(isTelemetryTokenPersisted({ ...givenRow, attr: {} }), false);

  assert.equal(
    telemetryModeFromState({ catalogToken: mintedCatalog, analyticsToken: mintedAnalytics }),
    "minted",
  );
  assert.equal(telemetryModeFromState({ givenToken: givenRow }), "given");
  assert.equal(telemetryModeFromState({}), "off");

  // State service integration across all three fixtures
  const stateWith = (rows: Record<string, PersistedState | undefined>) =>
    ({
      get: ({ stack, stage, fqn }) => {
        assert.equal(stack, "mind");
        assert.equal(stage, "ada");
        return Effect.succeed(rows[fqn]);
      },
    }) as Pick<StateService, "get"> as StateService;

  assert.equal(
    await Effect.runPromise(
      telemetryModeOf("ada").pipe(
        Effect.provideService(
          State,
          Effect.succeed(
            stateWith({
              TelemetryCatalogToken: mintedCatalog,
              TelemetryAnalyticsToken: mintedAnalytics,
            }),
          ),
        ),
      ),
    ),
    "minted",
  );
  assert.equal(
    await Effect.runPromise(
      telemetryModeOf("ada").pipe(
        Effect.provideService(State, Effect.succeed(stateWith({ TelemetryToken: givenRow }))),
      ),
    ),
    "given",
  );
  assert.equal(
    await Effect.runPromise(
      telemetryModeOf("ada").pipe(Effect.provideService(State, Effect.succeed(stateWith({})))),
    ),
    "off",
  );

  // A state-store read failure must fail the deploy, never silently return "off"
  const brokenState = {
    get: () => Effect.fail(new StateStoreError({ message: "state store unreachable" })),
  } as Pick<StateService, "get"> as StateService;
  const failed = await Effect.runPromiseExit(
    telemetryModeOf("ada").pipe(Effect.provideService(State, Effect.succeed(brokenState))),
  );
  assert.equal(failed._tag, "Failure");
  // and so must a run with no state at all
  assert.equal((await Effect.runPromiseExit(telemetryModeOf("ada")))._tag, "Failure");
});

void test("legacy AccountApiToken delete succeeds when permitted, logs and continues on permission refusal with valid credential, and fails on invalid credential or 5xx", async () => {
  const accountId = "a".repeat(32);
  const token = {
    accountId,
    name: "iterate-ada-telemetry-catalog",
    tokenId: "tok-123",
  };

  // Credential with delete permission removes the token cleanly without warning
  const okLines: string[] = [];
  await Effect.runPromise(
    deleteLegacyAccountApiToken(Effect.void, Effect.void, token, (line) => okLines.push(line)),
  );
  assert.deepEqual(okLines, []);

  // Sign-in lacking API-token write scope (Unauthorized "Authentication error" or Forbidden "Method not allowed for token")
  for (const refusal of [
    new Unauthorized({ message: "Authentication error" }),
    new Forbidden({ message: "Method not allowed for token" }),
  ]) {
    const lines: string[] = [];
    await Effect.runPromise(
      deleteLegacyAccountApiToken(Effect.fail(refusal), Effect.succeed("valid"), token, (line) =>
        lines.push(line),
      ),
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /iterate-ada-telemetry-catalog/);
    assert.match(lines[0]!, new RegExp(`https://dash\\.cloudflare\\.com/${accountId}/api-tokens`));
  }

  // Invalid credential fails even on Unauthorized "Authentication error"
  const invalidExit = await Effect.runPromiseExit(
    deleteLegacyAccountApiToken(
      Effect.fail(new Unauthorized({ message: "Authentication error" })),
      Effect.fail(new Unauthorized({ message: "Authentication error" })),
      token,
      () => {},
    ),
  );
  assert.equal(invalidExit._tag, "Failure");

  // Non-permission errors (500) still fail
  const serverErrorExit = await Effect.runPromiseExit(
    deleteLegacyAccountApiToken(
      Effect.fail(new InternalServerError({ message: "internal error" })),
      Effect.succeed("valid"),
      token,
      () => {},
    ),
  );
  assert.equal(serverErrorExit._tag, "Failure");
});
