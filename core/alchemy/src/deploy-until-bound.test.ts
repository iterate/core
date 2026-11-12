// How often a deploy is tried when Cloudflare does not bind a Worker to a new log pipeline
// (deploy-until-bound.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deployUntilBound } from "./deploy-until-bound.ts";

/** A deploy that answers `outcomes` in turn, and what was said and waited between them. */
function pretendDeploys(outcomes: { code: number; notBound: boolean }[]) {
  const said: string[] = [];
  const waited: number[] = [];
  let deploys = 0;
  return {
    said,
    waited,
    get deploys() {
      return deploys;
    },
    run: (waits?: number[]) =>
      deployUntilBound({
        deploy: async () => outcomes[deploys++]!,
        pause: async (seconds) => void waited.push(seconds),
        say: (line) => void said.push(line),
        waits,
      }),
  };
}

void test("a deploy that succeeds is made once, and nothing is said", async () => {
  const deploys = pretendDeploys([{ code: 0, notBound: false }]);
  assert.equal(await deploys.run(), 0);
  assert.equal(deploys.deploys, 1);
  assert.deepEqual(deploys.said, []);
});

void test("a deploy that fails for another reason is not tried again", async () => {
  const deploys = pretendDeploys([{ code: 1, notBound: false }]);
  assert.equal(await deploys.run(), 1);
  assert.equal(deploys.deploys, 1);
  assert.deepEqual(deploys.waited, []);
});

void test("a deploy that Cloudflare did not bind is tried again after a wait, with one line for each try", async () => {
  const deploys = pretendDeploys([
    { code: 1, notBound: true },
    { code: 1, notBound: true },
    { code: 0, notBound: false },
  ]);
  assert.equal(await deploys.run(), 0);
  assert.equal(deploys.deploys, 3);
  assert.deepEqual(deploys.waited, [20, 40]);
  assert.equal(deploys.said.length, 2);
  assert.match(deploys.said[0]!, /"Pipeline binding error".* Try 2 of 7 starts in 20 seconds/);
  assert.match(deploys.said[1]!, /Try 3 of 7 starts in 40 seconds/);
});

void test("a deploy that succeeds with the words in its output is not tried again", async () => {
  const deploys = pretendDeploys([{ code: 0, notBound: true }]);
  assert.equal(await deploys.run(), 0);
  assert.equal(deploys.deploys, 1);
});

void test("the tries are bounded: the last failure is the deploy's, and a line says so", async () => {
  const deploys = pretendDeploys([
    { code: 1, notBound: true },
    { code: 1, notBound: true },
    { code: 7, notBound: true },
  ]);
  assert.equal(await deploys.run([1, 2]), 7);
  assert.equal(deploys.deploys, 3);
  assert.deepEqual(deploys.waited, [1, 2]);
  assert.match(deploys.said.at(-1)!, /in each of 3 tries .* The deploy failed\./);
});
