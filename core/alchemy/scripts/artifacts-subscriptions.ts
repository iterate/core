// artifacts-subscriptions.ts — THE CONFIG REPO'S ARTIFACTS SUBSCRIPTION (src/artifacts-subscriptions.ts
// says what it is). `pnpm run deploy` runs this after the stack is deployed, when the queue exists;
// `pnpm run destroy` runs it with `--remove` before Alchemy's destroy.
//
// By hand: `node scripts/artifacts-subscriptions.ts --stage <name> [--remove]`.
import { callWithToken } from "../src/cloudflare-call.ts";
import {
  ensureArtifactsSubscription,
  removeArtifactsSubscription,
} from "../src/artifacts-subscriptions.ts";
import { loadMindConfig, stageOf } from "../src/config.ts";

const config = await loadMindConfig(stageOf(process.argv));
const token = process.env.CLOUDFLARE_API_TOKEN;
if (config.mind?.provided) {
  console.log("The mind is provided: its repos are not in Artifacts, and it has no subscription.");
  process.exit(0);
}
if (!token) {
  console.error(
    "The config repo's Artifacts subscription was not looked at: that needs CLOUDFLARE_API_TOKEN.",
  );
  process.exit(1);
}
const input = { accountId: config.accountId, name: config.name, call: callWithToken(token) };
const { failed, lines } = process.argv.includes("--remove")
  ? await removeArtifactsSubscription(input)
  : await ensureArtifactsSubscription(input);
for (const line of lines) console.log(line);
if (failed) process.exit(1);
