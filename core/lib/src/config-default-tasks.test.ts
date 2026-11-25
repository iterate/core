// The default config's Tasks app (core/configs/default/apps/tasks): how a markdown file under
// tasks/ is read as a card and written back (public/tasks-model.js), and the calls of
// `itx.config` that keep a card, follow it and say who asked (cards.js, feed.js, asks.js,
// askers.js, board.js). Its checks are Node's own
// tests, `.test.mjs` beside the code, as a mind's config runs them (`node --test`). This runs
// them in this repo's test run, and fails with their output.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the tasks app's node tests pass", () => {
  const run = spawnSync(process.execPath, ["--test"], {
    cwd: fileURLToPath(new URL("../../configs/default/apps/tasks/", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
  });
  const said = `${run.stdout}\n${run.stderr}`;
  expect(run, said).toMatchObject({ status: 0 });
  expect(said).toMatch(/^ℹ fail 0$/m);
});
