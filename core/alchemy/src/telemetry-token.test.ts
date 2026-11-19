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
  TELEMETRY_TOKEN,
  telemetryModeFromState,
  telemetryModeOf,
  telemetryTokenNeedsUpdate,
  telemetryTokenValueOf,
} from "./telemetry-token.ts";

void test("first deploy with a provided token stores it redacted, and missing token dies with guidance", async () => {
  const made = await Effect.runPromise(telemetryTokenValueOf("cf-telemetry-secret", undefined));
  assert.equal(Redacted.value(made.value), "cf-telemetry-secret");
  assert.doesNotMatch(JSON.stringify(made), /cf-telemetry-secret/);

  const missing = await Effect.runPromiseExit(telemetryTokenValueOf(undefined, undefined));
  assert.equal(missing._tag, "Failure");
  assert.match(JSON.stringify(missing), new RegExp(TELEMETRY_TOKEN));
});

void test("later deploys reuse the kept token without prompting and update only on rotation", async () => {
  const kept = { value: Redacted.make("cf-telemetry-v1") };
  assert.equal(telemetryTokenNeedsUpdate(undefined, kept), false);
  assert.equal(telemetryTokenNeedsUpdate("cf-telemetry-v1", kept), false);
  assert.equal(telemetryTokenNeedsUpdate("cf-telemetry-v2", kept), true);

  const reused = await Effect.runPromise(telemetryTokenValueOf(undefined, kept));
  assert.equal(Redacted.value(reused.value), "cf-telemetry-v1");

  const rotated = await Effect.runPromise(telemetryTokenValueOf("cf-telemetry-v2", kept));
  assert.equal(Redacted.value(rotated.value), "cf-telemetry-v2");
});

void test("telemetryModeOf resolves minted, given, and off across the three state fixtures and fails on state-store errors", async () => {
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

  // Fixture 1: existing mind with minted tokens stays minted (even if env token is set)
  assert.equal(
    telemetryModeFromState({ catalogToken: mintedCatalog, analyticsToken: mintedAnalytics }),
    "minted",
  );
  assert.equal(
    telemetryModeFromState(
      { catalogToken: mintedCatalog, analyticsToken: mintedAnalytics },
      "env-tok",
    ),
    "minted",
  );

  // Fixture 2: mind with TelemetryToken in state, or fresh deploy with env token -> given
  assert.equal(telemetryModeFromState({ givenToken: givenRow }), "given");
  assert.equal(telemetryModeFromState({}, "env-tok"), "given");

  // Fixture 3: fresh mind with no token in state and no env token -> off
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
  assert.equal(
    await Effect.runPromise(
      telemetryModeOf("ada", "env-tok").pipe(
        Effect.provideService(State, Effect.succeed(stateWith({}))),
      ),
    ),
    "given",
  );

  // A state-store read failure must fail the deploy, never silently return "off"
  const brokenState = {
    get: () => Effect.fail(new StateStoreError({ message: "state store unreachable" })),
  } as Pick<StateService, "get"> as StateService;
  const failed = await Effect.runPromiseExit(
    telemetryModeOf("ada").pipe(Effect.provideService(State, Effect.succeed(brokenState))),
  );
  assert.equal(failed._tag, "Failure");
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

  // Fresh branch sign-in lacking API-token write (Unauthorized "Authentication error" or Forbidden "Method not allowed for token")
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
