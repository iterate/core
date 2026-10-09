// alchemy.run.ts — THE ALCHEMY CLI'S ENTRY FOR core/os: one iterate deployment (alchemy/stack.ts), its
// iterate config from the config file (scripts/iterate-config-file.ts), its release from this
// checkout's build (scripts/build.ts `releaseOf`), its stage its Worker's name. From core/os:
//
//   pnpm run deploy --stage <worker>                     # the build, then `alchemy deploy`
//   pnpm build && pnpm alchemy plan --stage <worker>     # what a deploy would change
//   pnpm alchemy dev|logs|destroy --stage <worker>
//
// Both package scripts load .secrets first; a variable already set wins. State: .alchemy/ beside this
// file, or the account's Cloudflare state store with ITERATE_STATE_STORE=cloudflare (iterate's
// deployments, which CI deploys and destroys from fresh runners). This module builds nothing, except
// under `alchemy dev`: dev re-imports it when a file it imports changes, and each import runs Vite's
// build, so the redeploy carries every app edit since the last one. An edit outside the import graph
// waits for the next such change (a save that changes nothing reloads nothing); a change during an
// apply interrupts it, and the next plan repeats it.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as ConfigProvider from "effect/ConfigProvider";
import { iterateStack } from "./alchemy/stack.ts";
import { releaseOf } from "./scripts/build.ts";
import { imagesOfDeployment } from "./scripts/images.ts";
import { HOW_TO_CHANGE_THE_CONFIG, readDeployment } from "./scripts/iterate-config-file.ts";
import { viteBuild } from "./scripts/vite-build.ts";

const deployment = await readDeployment();
const cloudflare = deployment?.config.cloudflare;
if (!deployment || !cloudflare)
  throw new Error(
    `No deployment: the iterate config has no \`cloudflare\` section. ${HOW_TO_CHANGE_THE_CONFIG}`,
  );
const accountId = cloudflare.accountId;
// Alchemy's Cloudflare providers and its state store read the account and the token from the
// environment: the config's, unless the environment names them already
process.env.CLOUDFLARE_ACCOUNT_ID ||= accountId;
process.env.CLOUDFLARE_API_TOKEN ||= cloudflare.apiToken.exposeSecret();
const store = process.env.ITERATE_STATE_STORE || "local";
if (store !== "local" && store !== "cloudflare")
  throw new Error(
    `ITERATE_STATE_STORE is ${JSON.stringify(store)}: local (the default) or cloudflare`,
  );
// `alchemy dev` runs this module in a child with ALCHEMY_DEV=true (alchemy's Cli/commands/dev.ts)
if (process.env.ALCHEMY_DEV === "true") await viteBuild(import.meta.dirname, {});

export default Alchemy.Stack(
  "iterate",
  {
    providers: Cloudflare.providers(),
    state: store === "cloudflare" ? Cloudflare.state() : Alchemy.localState(),
    // The process environment, then the deployment's own secrets over it: each secret the config
    // sets, from the file or the environment, as the variable stack.ts binds. A declared list
    // replaces the CLI's .env loading (alchemy's Util/ConfigProvider.ts), so a stray core/os/.env
    // never reaches a deployment.
    secrets: [
      Alchemy.Secrets.ProcessEnv(),
      ConfigProvider.layerAdd(ConfigProvider.fromEnv({ env: deployment.vars.secrets }), {
        asPrimary: true,
      }),
    ],
  },
  iterateStack({ deployment, release: releaseOf(), images: imagesOfDeployment(accountId) }),
);
