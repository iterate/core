// The default config's own agent: its code (core/configs/default/agent/), and the kind that the
// mind's config gives it (agent-kinds/agent.ts, agent-start.ts, agent-prompt.ts). The kind's checks
// are `agent-kinds/agent.test.mjs`: how the Dash starts an agent, what a new agent is told, and that
// the platform can load its facets. The agent's checks are in `agent-tests/`, beside its folder:
// a file in agent/ would ship with the facets. All are Node's own tests, as a mind's config runs
// them (`node --test`). This runs them in this repo's test run, and fails with their output.
//
// Nothing else in this repo's test run executes them: without this file a fault in the agent or in
// its kind reaches main unseen, and a new mind's agent is the first to show it.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const CONFIG = fileURLToPath(new URL("../../configs/default/", import.meta.url));

test("the agent's and the kind agent's node tests pass", () => {
  const files = readdirSync(`${CONFIG}agent-tests/`)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `agent-tests/${name}`);
  // a file that goes missing fails here, and does not silently stop its tests
  expect(files.toSorted()).toEqual([
    "agent-tests/files.test.mjs",
    "agent-tests/processor.test.mjs",
    "agent-tests/script-envelope.test.mjs",
    "agent-tests/start.test.mjs",
    "agent-tests/subagent.test.mjs",
  ]);
  // the whole run takes about 6 s on Beelink by itself, and 22 s beside the whole repository's
  // tests: each timeout leaves five times the slower one or more
  const run = spawnSync(process.execPath, ["--test", ...files, "agent-kinds/agent.test.mjs"], {
    cwd: CONFIG,
    encoding: "utf8",
    timeout: 120_000,
  });
  const said = `${run.stdout}\n${run.stderr}`;
  expect(run, said).toMatchObject({ status: 0 });
  expect(said).toMatch(/^ℹ fail 0$/m);
  // the files have tests, and they ran: a run that found none also says "fail 0"
  expect(said).toMatch(/^ℹ pass [1-9]\d*$/m);
}, 150_000);
