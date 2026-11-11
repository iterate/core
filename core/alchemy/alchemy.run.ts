import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { loadMindConfig, resourceNamesOf, stageOf } from "./src/config.ts";
import { mindStack } from "./src/stack.ts";

// The account's own store by default: local state would keep the generated keys in this checkout in
// clear, and a second checkout would mint new ones.
const store = process.env.ITERATE_STATE_STORE || "cloudflare";
if (store !== "local" && store !== "cloudflare")
  throw new Error(
    `ITERATE_STATE_STORE is ${JSON.stringify(store)}: cloudflare (the default) or local`,
  );

const config = await loadMindConfig(stageOf(process.argv));

// Alchemy's Cloudflare providers and its state store read the account from the environment.
process.env.CLOUDFLARE_ACCOUNT_ID ||= config.accountId;
if (process.env.CLOUDFLARE_ACCOUNT_ID !== config.accountId)
  throw new Error(
    `CLOUDFLARE_ACCOUNT_ID is ${process.env.CLOUDFLARE_ACCOUNT_ID}, but the mind config's account is ${config.accountId}`,
  );
export default Alchemy.Stack(
  "mind",
  {
    providers: Cloudflare.providers(),
    state:
      store === "cloudflare"
        ? Cloudflare.state({ workerName: resourceNamesOf(config.name).state })
        : Alchemy.localState(),
  },
  mindStack(config),
);
