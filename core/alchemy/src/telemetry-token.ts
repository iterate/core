// telemetry-token.ts — THE TELEMETRY TOKEN THAT A STACK ALREADY KEEPS IN STATE. A stack whose
// tables an earlier deploy made with a token keeps that token: its Pipelines catalog sinks keep
// the token they were made with. A deploy takes no new token: a mind turns its tables on itself
// (core/configs/default/telemetry.ts). The mode is read from the stack's state alone.
//
// `AccountApiTokenDeleteFallbackProvider` wraps Alchemy's `AccountApiTokenProvider` so deleting
// an `AccountApiToken` resource succeeds even with a deploy sign-in that lacks API-token write
// permission: when Cloudflare refuses deletion for missing permission, it verifies the credential
// is valid, logs the token name and dashboard URL for manual removal, and lets Alchemy clear state.
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { isResourceState, type PersistedState, State } from "alchemy/State/State";
import type { ResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { z } from "zod";

export type TelemetryToken = Resource<
  "Iterate.TelemetryToken",
  {
    /** Descriptive name of the token (`iterate-<stage>-telemetry`). */
    name: string;
  },
  {
    /** The API token value, kept redacted in Alchemy's state. */
    value: Redacted.Redacted<string>;
  },
  never,
  Cloudflare.Providers
>;
export const TelemetryToken = Resource<TelemetryToken>("Iterate.TelemetryToken");

/** How the stack wires telemetry tables, as its state says:
 *  - `"minted"`: state holds `TelemetryCatalogToken` or `TelemetryAnalyticsToken` — declare those
 *    two `AccountApiToken` resources so catalog sinks keep their original credentials.
 *  - `"given"`: state holds `TelemetryToken` — use that one owner-created token.
 *  - `"off"`: neither — the bucket and the streams are made, and no token, catalog, sink or
 *    pipeline: the mind can make those itself (./mind-made-telemetry-tables.ts). */
export type TelemetryMode = "minted" | "given" | "off";

const isLiveResource = (persisted: PersistedState | undefined): persisted is ResourceState =>
  Boolean(persisted && isResourceState(persisted) && persisted.status !== "deleting");

/** Whether a persisted state row represents a live `TelemetryToken` with a stored value. */
export const isTelemetryTokenPersisted = (persisted: PersistedState | undefined): boolean =>
  Boolean(isLiveResource(persisted) && persisted.attr && "value" in persisted.attr);

/** Chooses the stack's telemetry mode from persisted state rows. */
export const telemetryModeFromState = (rows: {
  catalogToken?: PersistedState;
  analyticsToken?: PersistedState;
  givenToken?: PersistedState;
}): TelemetryMode => {
  if (isLiveResource(rows.catalogToken) || isLiveResource(rows.analyticsToken)) return "minted";
  if (isTelemetryTokenPersisted(rows.givenToken)) return "given";
  return "off";
};

/** Reads Alchemy's `State` once to determine the stack's telemetry mode for `stage`.
 *  Propagates `StateStoreError` so a store read failure stops the deploy rather than dropping
 *  existing telemetry resources. */
export const telemetryModeOf = (stage: string) =>
  Effect.gen(function* () {
    const stateOption = yield* Effect.serviceOption(State);
    if (Option.isNone(stateOption)) return "off" as const;
    const state = yield* stateOption.value;
    const [catalogToken, analyticsToken, givenToken] = yield* Effect.all([
      state.get({ stack: "mind", stage, fqn: "TelemetryCatalogToken" }),
      state.get({ stack: "mind", stage, fqn: "TelemetryAnalyticsToken" }),
      state.get({ stack: "mind", stage, fqn: "TelemetryToken" }),
    ]);
    return telemetryModeFromState({ catalogToken, analyticsToken, givenToken });
  });

/** Provider for `TelemetryToken`: it answers the value that the stack's state keeps. */
export const TelemetryTokenProvider = () =>
  Provider.succeed(TelemetryToken, {
    reconcile: ({ output }) =>
      output
        ? Effect.succeed({ value: output.value })
        : Effect.die(
            "This stack holds no telemetry token in its state, and a deploy takes no new one: a mind turns its telemetry tables on itself (core/configs/default/onboarding/telemetry.md).",
          ),
    // The token was created by the person in Cloudflare's dashboard, not by the deploy.
    delete: () => Effect.void,
  });

/** Attempts to delete a `Cloudflare.ApiToken.AccountApiToken`. When Cloudflare refuses for missing
 *  API-token write permission (and a read proves the credential is valid), logs the token name and
 *  dashboard URL so the owner can remove it manually and returns success. */
export const deleteLegacyAccountApiToken = <E, R, E2, R2>(
  remove: Effect.Effect<void, E, R>,
  credentialWorks: Effect.Effect<unknown, E2, R2>,
  token: { accountId: string; name: string; tokenId: string },
  say: (line: string) => void,
) =>
  remove.pipe(
    Effect.catchIf(refusedForPermissionShape, (refused) =>
      credentialWorks.pipe(
        Effect.flatMap(() =>
          Effect.sync(() =>
            say(
              `API token ${token.name} (${token.tokenId}) stays in Cloudflare: this deploy credential lacks permission to delete API tokens. Delete it in Cloudflare's dashboard: https://dash.cloudflare.com/${token.accountId}/api-tokens`,
            ),
          ),
        ),
        Effect.catchCause(() => Effect.fail(refused)),
      ),
    ),
  );

/** Overrides Alchemy's `AccountApiTokenProvider` so deleting `AccountApiToken` resources succeeds
 *  even without `account_api_tokens` write scope. */
export const AccountApiTokenDeleteFallbackProvider = () =>
  Provider.effect(
    Cloudflare.ApiToken.AccountApiToken,
    Effect.gen(function* () {
      const base = yield* Cloudflare.ApiToken.AccountApiToken.Provider;
      const credentials = yield* Credentials;
      const httpClient = yield* HttpClient.HttpClient;
      const wrapped: Provider.ProviderService<Cloudflare.ApiToken.AccountApiToken> = {
        ...base,
        delete: (input) =>
          deleteLegacyAccountApiToken(
            base.delete(input).pipe(noRetryOnPermissionRefusal),
            zones
              .listZones({ account: { id: input.output.accountId }, perPage: 1 })
              .pipe(
                Effect.provideService(Credentials, credentials),
                Effect.provideService(HttpClient.HttpClient, httpClient),
              ),
            input.output,
            console.log,
          ),
      };
      return wrapped;
    }),
  ).pipe(Layer.provide(Cloudflare.ApiToken.AccountApiTokenProvider()));

/** WHETHER AN ERROR HAS THE SHAPE OF A REFUSAL FOR PERMISSION. Cloudflare answers 403 code 10000
 *  "Authentication error" (mapped to `Unauthorized` or `Forbidden`) or code 10001 "Method not
 *  allowed for token" (`Forbidden`) for a valid token lacking permission. */
const refusedForPermissionShape = (error: unknown) =>
  (Predicate.isTagged(error, "Unauthorized") && /^Authentication error$/i.test(wordsOf(error))) ||
  (Predicate.isTagged(error, "Forbidden") &&
    (/method not allowed for token/i.test(wordsOf(error)) ||
      /^Authentication error$/i.test(wordsOf(error))));

/** Retries transient Cloudflare errors (throttling, 5xx) with the SDK's default policy, but not a
 *  refusal for permission, so a deploy without API-token write fails fast instead of waiting
 *  about 24 s on retries. */
const noRetryOnPermissionRefusal = Retry.policy((lastError) => {
  const base = Retry.makeDefault(lastError);
  return {
    ...base,
    while: (error) => !refusedForPermissionShape(error) && (base.while?.(error) ?? true),
  };
});

const wordsOf = (refused: unknown) =>
  z.object({ message: z.string() }).safeParse(refused).data?.message || "no reason given";
