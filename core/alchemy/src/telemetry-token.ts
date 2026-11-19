// telemetry-token.ts — THE STACK'S TELEMETRY API TOKEN, PROVIDED BY THE OWNER AND KEPT IN STATE.
// One Cloudflare account-owned API token serves both the R2 Data Catalog / SQL queries and the
// Analytics Engine queries of the telemetry Worker (./stack.ts). Because a Cloudflare OAuth
// sign-in does not request "Account API Token Provisioning", the owner creates this single token
// in Cloudflare's dashboard and passes it in `CLOUDFLARE_TELEMETRY_API_TOKEN` when turning
// telemetry tables on. The stack keeps the redacted value in Alchemy's state so later deploys
// and plans reuse it without asking again, and refuses a different token because Pipelines
// catalog sinks keep the token they were made with.
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

/** How the stack wires telemetry tables:
 *  - `"minted"`: state holds `TelemetryCatalogToken` or `TelemetryAnalyticsToken` — declare those
 *    two `AccountApiToken` resources so catalog sinks keep their original credentials.
 *  - `"given"`: state holds `TelemetryToken` or `CLOUDFLARE_TELEMETRY_API_TOKEN` is set — use the
 *    single owner-created token and refuse any different token.
 *  - `"off"`: neither stored nor provided — omit the telemetry bucket, catalog, sinks, and pipelines. */
export type TelemetryMode = "minted" | "given" | "off";

const isLiveResource = (persisted: PersistedState | undefined): persisted is ResourceState =>
  Boolean(persisted && isResourceState(persisted) && persisted.status !== "deleting");

/** Whether a persisted state row represents a live `TelemetryToken` with a stored value. */
export const isTelemetryTokenPersisted = (persisted: PersistedState | undefined): boolean =>
  Boolean(isLiveResource(persisted) && persisted.attr && "value" in persisted.attr);

/** Chooses the stack's telemetry mode from persisted state rows and an optional env token.
 *  Minted-token stacks stay in `minted` mode because catalog sinks keep the credentials they were
 *  created with. */
export const telemetryModeFromState = (
  rows: {
    catalogToken?: PersistedState;
    analyticsToken?: PersistedState;
    givenToken?: PersistedState;
  },
  providedToken?: string,
): TelemetryMode => {
  if (isLiveResource(rows.catalogToken) || isLiveResource(rows.analyticsToken)) return "minted";
  if (providedToken || isTelemetryTokenPersisted(rows.givenToken)) return "given";
  return "off";
};

/** Reads Alchemy's `State` once to determine the stack's telemetry mode for `stage`.
 *  Propagates `StateStoreError` so a store read failure stops the deploy rather than dropping
 *  existing telemetry resources. */
export const telemetryModeOf = (stage: string, providedToken?: string) =>
  Effect.gen(function* () {
    const stateOption = yield* Effect.serviceOption(State);
    if (Option.isNone(stateOption)) return providedToken ? ("given" as const) : ("off" as const);
    const state = yield* stateOption.value;
    const [catalogToken, analyticsToken, givenToken] = yield* Effect.all([
      state.get({ stack: "mind", stage, fqn: "TelemetryCatalogToken" }),
      state.get({ stack: "mind", stage, fqn: "TelemetryAnalyticsToken" }),
      state.get({ stack: "mind", stage, fqn: "TelemetryToken" }),
    ]);
    return telemetryModeFromState({ catalogToken, analyticsToken, givenToken }, providedToken);
  });

/** Environment variable carrying the owner-created Cloudflare telemetry API token. */
export const TELEMETRY_TOKEN = "CLOUDFLARE_TELEMETRY_API_TOKEN";

/** Refusal when a different telemetry token is passed to a mind whose tables already hold one.
 *  Cloudflare Pipelines catalog sinks keep the credentials they were created with and refuse a
 *  replacement sink on an existing catalog table. */
export const TELEMETRY_TOKEN_IMMUTABLE =
  "This mind's telemetry token cannot be changed: its tables keep the token they were made with.";

/** Resolves the telemetry token value from existing Alchemy state or the provided env value,
 *  refusing any token that differs from the stored one. */
export const telemetryTokenValueOf = (
  provided: string | undefined,
  output: { value: Redacted.Redacted<string> } | undefined,
) => {
  if (provided && output && Redacted.value(output.value) !== provided)
    return Effect.die(TELEMETRY_TOKEN_IMMUTABLE);
  const value = output?.value || (provided ? Redacted.make(provided) : undefined);
  if (!value)
    return Effect.die(
      `${TELEMETRY_TOKEN} is not set: create an account-owned Cloudflare API token with "Workers R2 Data Catalog Write", "Workers R2 Storage Bucket Item Write", "Workers R2 SQL Read", and "Account Analytics Read", then pass it in ${TELEMETRY_TOKEN} (iterate deploy opens a pre-filled dashboard link for it).`,
    );
  return Effect.succeed({ value });
};

/** Provider for `TelemetryToken`. Stores `token` in state on creation, reuses the stored value on
 *  later deploys, and refuses a different token so catalog sinks are never left with dead credentials. */
export const TelemetryTokenProvider = (token?: string) =>
  Provider.succeed(TelemetryToken, {
    diff: ({ output }) =>
      token && output && Redacted.value(output.value) !== token
        ? Effect.die(TELEMETRY_TOKEN_IMMUTABLE)
        : Effect.succeed(undefined),
    reconcile: ({ output }) => telemetryTokenValueOf(token, output),
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
