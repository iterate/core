// data-catalog-token-wait.ts — THE DATA CATALOG WAITS FOR ITS NEW TOKEN. The stack makes the
// catalog's API token and, seconds later, gives it to the catalog (./stack.ts). Cloudflare's
// catalog does not know a new token at once. It then refuses it ("InvalidCredential: The provided
// credential for warehouse=… is not valid") and takes the same token some seconds later. One first
// deploy in three meets that refusal (18 Nov 2026).
//
// Alchemy's provider turns the catalog on before it gives it the token, so a deploy that fails
// there leaves a catalog that the next deploy does not own, and refuses without `--adopt`. This
// provider is Alchemy's (2.0.0-beta.85 and beta.87), with that refusal waited out inside the one deploy.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

const tokenNotKnownYet = Predicate.isTagged("InvalidCredential");

/** Put it over `Cloudflare.providers()`: a provider of a resource's own type in the stack's
 *  context is found before the one in Alchemy's collection. */
export const DataCatalogProviderThatWaitsForItsToken = () =>
  Provider.effect(
    Cloudflare.R2.DataCatalog,
    Effect.gen(function* () {
      const alchemys = yield* Cloudflare.R2.DataCatalog.Provider;
      const waiting: Provider.ProviderService<Cloudflare.R2.DataCatalog> = {
        ...alchemys,
        reconcile: (input) =>
          alchemys.reconcile(input).pipe(
            Effect.tapError((error) =>
              tokenNotKnownYet(error)
                ? Effect.logWarning(
                    `[${input.id}] Cloudflare's catalog does not know its new token yet: the same call again in 5 seconds`,
                  )
                : Effect.void,
            ),
            // two minutes at most: then the deploy fails with Cloudflare's own words
            Effect.retry({
              while: tokenNotKnownYet,
              schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(24)]),
            }),
          ),
      };
      return waiting;
    }),
  ).pipe(Layer.provide(Cloudflare.R2.DataCatalogProvider()));
