// telemetry-token.ts — THE STACK'S TELEMETRY API TOKEN, PROVIDED BY THE OWNER AND KEPT IN STATE.
// One Cloudflare account-owned API token serves both the R2 Data Catalog / SQL queries and the
// Analytics Engine queries of the telemetry Worker (./stack.ts). Because a Cloudflare OAuth
// sign-in does not need "Account API Token Provisioning" to create tokens, the owner creates this
// single token in Cloudflare's dashboard and passes it in `CLOUDFLARE_TELEMETRY_API_TOKEN` on the
// first deploy (or when rotating it). The stack keeps the redacted value in Alchemy's state so
// later deploys and plans reuse it without asking again.
//
// `AccountApiTokenDeleteFallbackProvider` also wraps Alchemy's `AccountApiTokenProvider` so
// upgrading an existing stack (whose state still holds legacy `TelemetryCatalogToken` and
// `TelemetryAnalyticsToken`) succeeds even with a fresh deploy sign-in that lacks API-token write
// permission: when Cloudflare refuses deletion for permission, it verifies the credential is valid,
// logs the token name and dashboard URL for manual removal, and lets Alchemy clear state.
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
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

/** Environment variable carrying the owner-created Cloudflare telemetry API token. */
export const TELEMETRY_TOKEN = "CLOUDFLARE_TELEMETRY_API_TOKEN";

/** Whether the resource needs an update given the currently provided token and existing state. */
export const telemetryTokenNeedsUpdate = (
  provided: string | undefined,
  output: { value: Redacted.Redacted<string> } | undefined,
) => Boolean(provided && output && Redacted.value(output.value) !== provided);

/** Resolves the telemetry token value from the provided env value or existing Alchemy state. */
export const telemetryTokenValueOf = (
  provided: string | undefined,
  output: { value: Redacted.Redacted<string> } | undefined,
) => {
  const value = provided ? Redacted.make(provided) : output?.value;
  if (!value)
    return Effect.die(
      `${TELEMETRY_TOKEN} is not set: create an account-owned Cloudflare API token with "Workers R2 Data Catalog Write", "Workers R2 Storage Bucket Item Write", "Workers R2 SQL Read", and "Account Analytics Read", then pass it in ${TELEMETRY_TOKEN} (iterate deploy opens a pre-filled dashboard link for it).`,
    );
  return Effect.succeed({ value });
};

/** Provider for `TelemetryToken`. Stores `token` in state on first deploy or rotation, and reuses
 *  the kept state value on later deploys when `token` is omitted. */
export const TelemetryTokenProvider = (token?: string) =>
  Provider.succeed(TelemetryToken, {
    diff: ({ output }) =>
      Effect.succeed(
        telemetryTokenNeedsUpdate(token, output) ? ({ action: "update" } as const) : undefined,
      ),
    reconcile: ({ output }) => telemetryTokenValueOf(token, output),
    // The token was created by the person in Cloudflare's dashboard, not by the deploy.
    delete: () => Effect.void,
  });

const tokenDeletePermissionRefused = (error: unknown) => {
  const message = z.object({ message: z.string() }).safeParse(error).data?.message || "";
  return (
    (Predicate.isTagged(error, "Unauthorized") && /^Authentication error$/i.test(message)) ||
    (Predicate.isTagged(error, "Forbidden") &&
      (/method not allowed for token/i.test(message) || /^Authentication error$/i.test(message)))
  );
};

/** Attempts to delete a legacy `Cloudflare.ApiToken.AccountApiToken`. When Cloudflare refuses for
 *  missing API-token write permission (and a read proves the credential is valid), logs the token
 *  name and dashboard URL so the owner can remove it manually and returns success. */
export const deleteLegacyAccountApiToken = <E, R, E2, R2>(
  remove: Effect.Effect<void, E, R>,
  credentialWorks: Effect.Effect<unknown, E2, R2>,
  token: { accountId: string; name: string; tokenId: string },
  say: (line: string) => void,
) =>
  remove.pipe(
    Effect.catchIf(tokenDeletePermissionRefused, (refused) =>
      credentialWorks.pipe(
        Effect.flatMap(() =>
          Effect.sync(() =>
            say(
              `Legacy API token ${token.name} (${token.tokenId}) stays in Cloudflare: this deploy credential lacks permission to delete API tokens. Delete it in Cloudflare's dashboard: https://dash.cloudflare.com/${token.accountId}/api-tokens`,
            ),
          ),
        ),
        Effect.catchCause(() => Effect.fail(refused)),
      ),
    ),
  );

/** Overrides Alchemy's `AccountApiTokenProvider` so deleting legacy `TelemetryCatalogToken` and
 *  `TelemetryAnalyticsToken` resources succeeds even without `account_api_tokens` write scope. */
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
            base.delete(input),
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
