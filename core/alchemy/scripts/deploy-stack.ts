// deploy-stack.ts — THE DEPLOY ITSELF, AND WHAT KEEPS A STACK'S TELEMETRY TURNING ON AND OFF.
// `pnpm run deploy` runs this last: the CLI and iterate Cloud both deploy through it.
//
//   node --env-file-if-exists=.secrets scripts/deploy-stack.ts --stage <name> [Alchemy's flags]
//
// It runs Alchemy's deploy, and three things around it that Alchemy does not do:
//
// 1. BEFORE A DEPLOY WITH TELEMETRY ON: a table of the stack's that no sink writes is dropped
//    (src/telemetry-tables.ts says why; src/telemetry-at-deploy.ts says when the deploy does
//    not start).
// 2. THE DEPLOY IS TRIED AGAIN when Cloudflare refused a Worker that binds to the stack's log
//    pipelines, a new sink of them, or the container application of the sandboxes' class at the
//    deploy that turns them on (src/deploy-until-bound.ts).
// 3. AFTER A DEPLOY THAT TURNED TELEMETRY OFF: the same step as 1 (src/telemetry-at-deploy.ts).
//
// The output of Alchemy is read for step 2, so it goes through a pipe. A person at a terminal who
// did not pass `--yes` has a question to answer: their deploy keeps the terminal, and is not
// tried again.
import { setTimeout as sleep } from "node:timers/promises";
import { accountUrl, callWithToken } from "../src/cloudflare-call.ts";
import { loadMindConfig, type MindConfig, resourceNamesOf, stageOf } from "../src/config.ts";
import { deployTry } from "../src/deploy-try.ts";
import { deployUntilBound } from "../src/deploy-until-bound.ts";
import { deployAroundTelemetry } from "../src/telemetry-at-deploy.ts";
import { dropTelemetryTables } from "../src/telemetry-tables.ts";

const args = process.argv.slice(2);
let config: MindConfig | undefined;
try {
  config = await loadMindConfig(stageOf(process.argv));
} catch {
  // Alchemy's deploy reads the config itself, and says what is wrong with it
}
const token = process.env.CLOUDFLARE_API_TOKEN;
const tables =
  config && token
    ? { accountId: config.accountId, name: config.name, call: callWithToken(token) }
    : undefined;

const piped = args.includes("--yes") || !process.stdin.isTTY || !process.stdout.isTTY;
const deploy = () =>
  deployTry({
    command: process.execPath,
    args: [`${import.meta.dirname}/../node_modules/alchemy/bin/cli.js`, "deploy", ...args],
    cwd: `${import.meta.dirname}/..`,
    piped,
    out: (piece) => void process.stdout.write(piece),
    err: (piece) => void process.stderr.write(piece),
  });

const untilBound = () =>
  deployUntilBound({
    deploy,
    pause: (seconds) => sleep(seconds * 1000),
    say: (line) => console.log(line),
  });
const bucket = tables && resourceNamesOf(tables.name).telemetryBucket;
process.exitCode =
  tables && bucket
    ? await deployAroundTelemetry({
        telemetry: Boolean(config?.telemetry),
        name: tables.name,
        bucket,
        drop: () => dropTelemetryTables({ ...tables, when: "deploying" }),
        catalogOn: async () => {
          const catalog = await tables.call(
            "GET",
            `${accountUrl(tables.accountId)}/r2-catalog/${bucket}`,
          );
          // The cast: Cloudflare's documented answer; a catalog with no status reads as off.
          return (
            (catalog.body as { result?: { status?: string } } | null)?.result?.status === "active"
          );
        },
        deploy: untilBound,
        say: (line) => console.log(line),
      })
    : await untilBound();
