// remove-state-store.ts — AFTER THE LAST DESTROY: the stack's state store leaves the account
// (src/state-store.ts says what that is, and why a destroy leaves it).
//
//   pnpm run destroy:state --stage <name>
import { stageOf } from "../src/config.ts";
import { removeStateStore } from "../src/state-store.ts";

const name = stageOf(process.argv);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!name || !accountId || !token) {
  console.error(
    "Stopped: removing a state store needs --stage <name>, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
  );
  process.exit(1);
}
const { failed, lines } = await removeStateStore({
  accountId,
  name,
  call: async (method, url) => {
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // an answer with no JSON has nothing to read
    }
    return { status: response.status, body };
  },
});
for (const line of lines) console.log(line);
if (failed) process.exit(1);
