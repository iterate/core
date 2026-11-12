// One try of a deploy, and what a signal does to the tries after it (deploy-try.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deployTry } from "./deploy-try.ts";
import { deployUntilBound, NOT_BOUND } from "./deploy-until-bound.ts";

/** Deploys as scripts/deploy-stack.ts does, with `script` as the child of each try. `seen` is
 *  called once, when the child has printed Cloudflare's words. */
function deploys(script: string, seen: () => void = () => {}) {
  const said: string[] = [];
  let tries = 0;
  let printed = "";
  return {
    said,
    get tries() {
      return tries;
    },
    run: () =>
      deployUntilBound({
        deploy: () => {
          tries += 1;
          return deployTry({
            command: process.execPath,
            args: ["-e", script],
            cwd: import.meta.dirname,
            piped: true,
            out: (piece) => {
              const before = printed.includes(NOT_BOUND);
              printed += piece.toString();
              if (!before && printed.includes(NOT_BOUND)) seen();
            },
            err: () => {},
          });
        },
        pause: async () => {},
        say: (line) => void said.push(line),
        waits: [0, 0],
      }),
  };
}

const REFUSED = `console.log(${JSON.stringify(NOT_BOUND)});`;

void test("a try that Cloudflare refused, with its words in two pieces, is tried again", async () => {
  const half = Math.floor(NOT_BOUND.length / 2);
  const run = deploys(
    `process.stdout.write(${JSON.stringify(NOT_BOUND.slice(0, half))}); setTimeout(() => { process.stdout.write(${JSON.stringify(NOT_BOUND.slice(half))}); process.exit(1); }, 200);`,
  );
  assert.equal(await run.run(), 1);
  assert.equal(run.tries, 3);
});

void test("SIGTERM during a try that printed Cloudflare's words ends the whole deploy: no further try", async () => {
  const run = deploys(`${REFUSED} setTimeout(() => {}, 60000);`, () =>
    process.emit("SIGTERM", "SIGTERM"),
  );
  assert.equal(await run.run(), 143);
  assert.equal(run.tries, 1);
  assert.deepEqual(run.said, []);
});

void test("SIGINT that the child answers with its own exit code ends the whole deploy too", async () => {
  const run = deploys(
    `process.on("SIGINT", () => process.exit(1)); ${REFUSED} setTimeout(() => {}, 60000);`,
    () => process.emit("SIGINT", "SIGINT"),
  );
  assert.equal(await run.run(), 130);
  assert.equal(run.tries, 1);
});

void test("a try that a signal killed from outside is not tried again", async () => {
  const run = deploys(`${REFUSED} setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);`);
  assert.equal(await run.run(), 137);
  assert.equal(run.tries, 1);
});

void test("a signal between two tries finds no listener of the deploy's: Node's own ending applies", async () => {
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  await deploys(`process.exit(0);`).run();
  assert.deepEqual(
    { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") },
    before,
  );
});

void test("a try whose new sink Cloudflare refused with 403, its line in two pieces, is tried again", async () => {
  const line =
    "ERROR (#1): InvalidSinkConfig: failed to validate Basin Catalog table: Unexpected, context: { status: 403 Forbidden, json: Forbidden }";
  const cut = line.indexOf("Unexpected");
  const run = deploys(
    `process.stderr.write(${JSON.stringify(line.slice(0, cut))}); setTimeout(() => { process.stderr.write(${JSON.stringify(line.slice(cut))}); process.exit(1); }, 200);`,
  );
  assert.equal(await run.run(), 1);
  assert.equal(run.tries, 3);
  assert.match(
    run.said[0]!,
    /a new sink of the stack's log pipelines .* Try 2 of 3 starts in 0 seconds/,
  );
});
