// The default config's own agent (core/configs/default/agent-kinds/agent.ts, agent-start.ts,
// agent-prompt.ts): how the Dash starts one, what a new agent is told, and that the platform can
// load its facets. Its checks are Node's own tests, `.test.mjs` beside the code, as a mind's config
// runs them (`node --test`). This runs them in this repo's test run, and fails with their output.
//
// Until 23 November 2026 nothing ran them here, and three faults reached main in one pull request
// (iterate/private#1313): each stopped a new mind's agent, and a deploy from main found them.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the kind agent's node tests pass", () => {
  const run = spawnSync(process.execPath, ["--test", "agent-kinds/agent.test.mjs"], {
    cwd: fileURLToPath(new URL("../../configs/default/", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
  });
  const said = `${run.stdout}\n${run.stderr}`;
  expect(run, said).toMatchObject({ status: 0 });
  expect(said).toMatch(/^ℹ fail 0$/m);
  // the file has tests, and they ran: a run that found none also says "fail 0"
  expect(said).toMatch(/^ℹ pass [1-9]\d*$/m);
});
