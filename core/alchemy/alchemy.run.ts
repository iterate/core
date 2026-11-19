// alchemy.run.ts — `alchemy deploy alchemy.run.ts --stage <alchemy.stageName>`: one mind, from one
// config (src/config.ts), into the account that the config names.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { PLACEHOLDER_STAGE } from "alchemy/Alchemist/Operations";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AccessTeamProvider } from "./src/access-team.ts";
import { ArtifactsNamespaceProvider } from "./src/artifacts-namespace.ts";
import { ArtifactsRepoSubscriptionProvider } from "./src/artifacts-repo-subscription.ts";
import { CatalogTablesOfSinksProvider } from "./src/catalog-tables-of-sinks.ts";
import {
  CloudflareOAuthClientProvider,
  OAUTH_CLIENT_TOKEN,
} from "./src/cloudflare-oauth-client.ts";
import { loadMindConfig, namesOf } from "./src/config.ts";
import { DataCatalogProviderThatWaitsForItsToken } from "./src/data-catalog-token-wait.ts";
import { CallsWithoutWriteProviders } from "./src/realtime.ts";
import { mindStack, refuseDeploy } from "./src/stack.ts";

const config = loadMindConfig();

/** Ends a command that is for another stage or another Cloudflare account than the config's. */
const refuseAnotherStageOrAccount = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;
  if (stage !== config.alchemy.stageName)
    return yield* refuseDeploy(
      `the stage is ${stage}: pass --stage ${config.alchemy.stageName}, the config's alchemy.stageName`,
    );
  // an API token of the environment gets the config's account (`secrets` below); a sign-in by
  // `alchemy login` keeps the account that the person chose
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  if (accountId !== config.cloudflare.accountId)
    return yield* refuseDeploy(
      `the Cloudflare sign-in is for the account ${accountId}, and the config's account is ${config.cloudflare.accountId}: sign in to the config's account (alchemy login), or set CLOUDFLARE_API_TOKEN to a token of it`,
    );
});

export default Alchemy.Stack(
  "mind",
  {
    providers: Layer.mergeAll(
      AccessTeamProvider(),
      ArtifactsNamespaceProvider(),
      ArtifactsRepoSubscriptionProvider(),
      CatalogTablesOfSinksProvider(),
      // with the API token that `iterate deploy` checked for the client alone, when it gave one
      CloudflareOAuthClientProvider(process.env[OAUTH_CLIENT_TOKEN]?.trim() || undefined),
      DataCatalogProviderThatWaitsForItsToken(),
      // Alchemy's own providers of the SFU app and TURN key, where a credential without "Calls
      // Write" leaves them not made (src/realtime.ts): these win over `Cloudflare.providers()`
      CallsWithoutWriteProviders(),
    ).pipe(Layer.provideMerge(Cloudflare.providers())),
    // The state, with the generated keys, lives in the mind's own account. Alchemy opens it for
    // a deploy and for a destroy, and a destroy does not run the stack's program: so both are
    // refused here, before the state is opened. A command that addresses no deployment
    // (`alchemy login`, `alchemy state`) builds the stack with Alchemy's placeholder stage.
    state: Layer.unwrap(
      Effect.gen(function* () {
        if ((yield* Alchemy.Stage) !== PLACEHOLDER_STAGE) yield* refuseAnotherStageOrAccount;
        return Cloudflare.state({
          workerName: namesOf(config).state,
          accountId: config.cloudflare.accountId,
        });
      }).pipe(Effect.orDie),
    ).pipe(Layer.provide(Cloudflare.CloudflareApiLive()), Layer.orDie),
    // Alchemy reads the account of an API token from CLOUDFLARE_ACCOUNT_ID: the config's answers,
    // after the shell, so that it wins over a variable of the shell.
    secrets: [
      Alchemy.Secrets.ProcessEnv(),
      ConfigProvider.layerAdd(
        ConfigProvider.fromUnknown({ CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId }),
        { asPrimary: true },
      ),
    ],
  },
  // the check again: a deploy runs the program, and none may take the placeholder stage
  refuseAnotherStageOrAccount.pipe(Effect.andThen(mindStack(config))),
);
