// remove-dmarc-record.ts — AFTER A DESTROY, THE ZONE HOLDS NO DNS RECORD OF THE STACK
// (src/dmarc-record.ts says which record a destroy leaves, and why). `pnpm run destroy` runs this
// twice: with `--print-domain` BEFORE Alchemy's destroy, and with `--domain <that>` after it
// (`domainFor` there says why the domain is read first).
//
// By hand, after a destroy: `node scripts/remove-dmarc-record.ts --stage <name> --domain <domain>`.
import { callWithToken } from "../src/cloudflare-call.ts";
import { loadMindConfig, stageOf } from "../src/config.ts";
import { domainFor, removeDmarcRecord } from "../src/dmarc-record.ts";

const name = stageOf(process.argv);
if (process.argv.includes("--print-domain")) {
  // nothing for a stack with no domain yet: the step after the destroy then has none to look at
  console.log((await loadMindConfig(name)).domain ?? "");
  process.exit(0);
}
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!name || !accountId || !token) {
  console.error(
    "The zone's DMARC record was not looked at: that needs --stage <name>, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
  );
  process.exit(1);
}
const domain = await domainFor(process.argv, async () => (await loadMindConfig(name)).domain);
if (!domain) {
  console.log(`The stack ${name} has no domain: it has no zone, so no DMARC record.`);
  process.exit(0);
}
const { failed, lines } = await removeDmarcRecord({
  accountId,
  name,
  domain,
  call: callWithToken(token),
});
for (const line of lines) console.log(line);
if (failed) process.exit(1);
