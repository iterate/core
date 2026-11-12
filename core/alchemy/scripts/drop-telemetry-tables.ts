// drop-telemetry-tables.ts — AFTER A DESTROY, THE STACK'S OWN TABLES LEAVE ITS DATA CATALOG.
// `pnpm run destroy` runs this when Alchemy's destroy has ended well.
//
// R2 keeps a data catalog's tables when the catalog is turned off, and when its bucket is
// deleted, and gives them back to a new bucket of the same name. A log pipeline's sink refuses a
// table that exists ("writing to existing Catalog tables is not yet supported"). So a stack with
// telemetry that is destroyed and deployed again under the same name gets no telemetry, unless
// its tables are dropped. Alchemy's destroy turns the catalog off and drops no table.
//
// WHEN: after the destroy, never before. A destroy asks before it deletes, and a person can say
// no: a step before that question would drop the tables of a stack that then lives. So this step
// looks for the stack's Workers first, and drops nothing while one is there. After a destroy the
// stack's pipelines are gone too, so nothing writes a table while it is dropped.
//
// WHAT IT TOUCHES: the catalog of the stack's own bucket, `iterate-<name>-telemetry`, and in it
// the three tables the stack's sinks write (src/stack.ts `telemetryPart`), by their exact names.
// A catalog is one bucket's, so another stack's tables are in another catalog. The namespace goes
// when those three are all it holds. A stack that never had telemetry has no such catalog.
//
// The Cloud's erase drops the same tables for a deployment it erases
// (internal-packages/installer/container/takeover.mjs). This is a second copy of that rule:
// `core/` is published alone and imports nothing from there.
import { stageOf } from "../src/config.ts";
import { dropTelemetryTables } from "../src/telemetry-tables.ts";

const name = stageOf(process.argv);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!name || !accountId || !token) {
  console.error(
    "The stack's telemetry tables were not looked at: that needs --stage <name>, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Run `node scripts/drop-telemetry-tables.ts --stage <name>` with them before the stack is deployed again.",
  );
  process.exit(1);
}
const { failed, lines } = await dropTelemetryTables({
  accountId,
  name,
  call: async (method, url, body) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers };
    if (body) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    let answered: unknown = null;
    try {
      answered = JSON.parse(text);
    } catch {
      // an answer with no JSON (a 204) has nothing to read
    }
    return { status: response.status, body: answered };
  },
});
for (const line of lines) console.log(line);
if (failed) {
  console.error(
    "The stack is destroyed, and a telemetry table of it is left: the next deploy's telemetry would fail. Run `node scripts/drop-telemetry-tables.ts --stage <name>` again; the token needs Account · Workers R2 Data Catalog Edit and Workers R2 Storage Edit.",
  );
  process.exit(1);
}
