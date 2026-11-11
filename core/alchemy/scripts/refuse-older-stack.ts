// refuse-older-stack.ts — A DEPLOY NEVER LANDS ON A STACK FROM BEFORE "MIND". Until 2026-11-11 a
// stack's Workers were `iterate-<name>-project` and `iterate-<name>-ingress`, and every context's
// log is in the first. This deploy would make `iterate-<name>-mind` beside it: an empty mind, with
// a new signing key, on the same domain. So `pnpm run deploy` runs this first, and it stops.
import { loadMindConfig, stageOf } from "../src/config.ts";

const stage = stageOf(process.argv);
let name = stage;
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
try {
  ({ name, accountId } = await loadMindConfig(stage));
} catch {
  // An older stack keeps its config under its old name, so a deploy with no config file finds
  // none: the stage and the account are enough to look. The deploy itself reports a bad config.
}
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!name || !accountId || !token) {
  console.error(
    "Stopped: the deploy needs --stage <name>, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or a config file) to check what is deployed.",
  );
  process.exit(1);
}

const found: string[] = [];
for (const worker of [`iterate-${name}-project`, `iterate-${name}-ingress`]) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/settings`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  await response.body?.cancel();
  if (response.ok) found.push(worker);
  else if (response.status !== 404) {
    console.error(
      `Stopped: Cloudflare answered ${response.status} when asked whether the Worker ${worker} exists, so the deploy cannot tell whether an older deployment is here. Nothing was changed.`,
    );
    process.exit(1);
  }
}
if (found.length > 0) {
  console.error(
    `Stopped: this is a deployment from before the rename to mind (the account has ${found.join(" and ")}). Its data is in the old Workers, and this deploy would put an empty mind beside them. Erase and replace it, or keep it on the older version. To erase it, run \`pnpm run destroy --stage ${name}\` from a checkout of the older version. Nothing was changed.`,
  );
  process.exit(1);
}
console.log(`no deployment from before the rename is here (${name})`);
