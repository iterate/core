// telemetry-toggle-proof.ts — A STACK'S TELEMETRY TURNS OFF, ON, OFF AND ON AGAIN, on a prototype
// stack that is deployed. It makes four deploys of the stack's own config, and looks at the
// account after each. It proves what scripts/deploy-stack.ts adds to a deploy:
//
// - a turn-off leaves no table in the stack's data catalog (the next turn-on finds none left);
// - a turn-on ends with the stack's three sinks, its telemetry Worker and its catalog on, also
//   when Cloudflare refused a Worker that binds to the pipelines at the first try.
//
//   node --env-file-if-exists=.secrets scripts/telemetry-toggle-proof.ts --stage <name> [deploy flags]
// CLOUDFLARE_API_TOKEN   a deploy's token, which may also make API tokens (README, "Telemetry")
//
// The stack is left with telemetry on. Run `pnpm smoke <domain>` after it for the rows that land.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountUrl, callWithToken } from "../src/cloudflare-call.ts";
import { loadMindConfig, resourceNamesOf, stageOf } from "../src/config.ts";

/** The stacks this proof may turn: prototypes that serve nobody. Add a prototype's domain here. */
const PROTOTYPES = ["blifto.com"];
const TABLES = ["events", "logs", "spans"];

const args = process.argv.slice(2);
const stage = stageOf(process.argv);
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!stage || !token) {
  console.error(
    "usage: node --env-file-if-exists=.secrets scripts/telemetry-toggle-proof.ts --stage <name> [deploy flags]\n  needs CLOUDFLARE_API_TOKEN",
  );
  process.exit(2);
}
const config = await loadMindConfig(stage);
if (!PROTOTYPES.includes(config.domain)) {
  console.error(
    `Stopped: ${config.domain} is not a prototype this proof may turn (${PROTOTYPES.join(", ")}). Nothing was changed.`,
  );
  process.exit(2);
}
const names = resourceNamesOf(config.name);
const account = accountUrl(config.accountId);
const call = callWithToken(token);
const folder = mkdtempSync(join(tmpdir(), "telemetry-toggle-proof-"));

/** One deploy of the stack's config with telemetry `on`: its exit code and all it printed. */
function deploy(on: boolean, turn: number) {
  const file = join(folder, `mind.config.${turn}.json`);
  const { telemetry: _was, ...rest } = config;
  writeFileSync(file, JSON.stringify(on ? { ...rest, telemetry: true } : rest));
  return new Promise<{ code: number; printed: string }>((done) => {
    const run = spawn(
      "pnpm",
      ["run", "deploy", ...args, ...(args.includes("--yes") ? [] : ["--yes"])],
      {
        cwd: `${import.meta.dirname}/..`,
        env: { ...process.env, ITERATE_MIND_CONFIG: file },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let printed = "";
    const through = (to: NodeJS.WriteStream) => (piece: Buffer) => {
      to.write(piece);
      printed += piece.toString();
    };
    run.stdout.on("data", through(process.stdout));
    run.stderr.on("data", through(process.stderr));
    run.on("error", (error) => done({ code: 1, printed: `${printed}\n${error.message}` }));
    run.on("close", (code) => done({ code: code ?? 1, printed }));
  });
}

/** What the account shows of the stack's telemetry part. */
async function shown() {
  const sinks = await call("GET", `${account}/pipelines/v1/sinks?per_page=50`);
  // The casts: Cloudflare's documented answers; a field that is not there reads as nothing.
  const sinkNames = ((sinks.body as { result?: { name?: string }[] } | null)?.result ?? []).map(
    (sink) => String(sink.name),
  );
  const catalog = await call("GET", `${account}/r2-catalog/${names.telemetryBucket}`);
  const worker = await call("GET", `${account}/workers/scripts/${names.telemetry}/settings`);
  return {
    sinksRead: sinks.status === 200,
    sinks: TABLES.filter((table) => sinkNames.includes(`${names.telemetryTables}_${table}_sink`)),
    catalogOn:
      (catalog.body as { result?: { status?: string } } | null)?.result?.status === "active",
    worker: worker.status,
  };
}

const rows: { pass: boolean; row: string }[] = [];
const row = (pass: boolean, text: string) => {
  rows.push({ pass, row: text });
  console.log(`${pass ? "ok  " : "FAIL"} ${text}`);
};

let turn = 0;
for (const on of [false, true, false, true]) {
  turn += 1;
  const word = `deploy ${turn} (telemetry ${on ? "on" : "off"})`;
  console.log(`\n=== ${word} ===`);
  const before = await shown();
  const { code, printed } = await deploy(on, turn);
  row(code === 0, `${word}: the deploy ended well (exit ${code})`);
  if (code !== 0) break;
  const after = await shown();
  row(after.sinksRead, `${word}: the account's sinks were read`);
  if (on) {
    row(
      after.sinks.length === TABLES.length,
      `${word}: the stack's three sinks are there (${after.sinks.join(", ") || "none"})`,
    );
    row(after.catalogOn, `${word}: the data catalog of ${names.telemetryBucket} is on`);
    row(after.worker === 200, `${word}: the Worker ${names.telemetry} is there`);
    // a turn-off drops its own tables, so the turn-on after one has none to drop
    if (turn > 1)
      row(
        !printed.includes("Left over from an earlier time"),
        `${word}: no table was left over from the turn-off before it`,
      );
    // the line of src/deploy-until-bound.ts for each try after the first
    const tries = (printed.match(/Try \d+ of \d+ starts in/g) || []).length;
    console.log(
      `     ${word}: ${tries} more ${tries === 1 ? "try" : "tries"} for a pipeline binding`,
    );
  } else {
    row(after.sinks.length === 0, `${word}: no sink of the stack is there`);
    row(!after.catalogOn, `${word}: the data catalog of ${names.telemetryBucket} is off`);
    row(after.worker === 404, `${word}: the Worker ${names.telemetry} is gone`);
    if (before.catalogOn)
      row(
        printed.includes("This deploy turned telemetry off") &&
          !printed.includes("a telemetry table of the stack may be left"),
        `${word}: the turn-off looked for the stack's tables and left none`,
      );
  }
}

const failed = rows.filter((each) => !each.pass);
console.log(
  `\n${rows.length - failed.length} of ${rows.length} rows pass${failed.length > 0 ? `; FAILED: ${failed.map((each) => each.row).join(" | ")}` : ""}`,
);
process.exitCode = failed.length > 0 || rows.length === 0 ? 1 : 0;
