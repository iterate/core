// How often a deploy is tried when Cloudflare refuses, for a while, a Worker that binds to a log
// pipeline or a new sink (deploy-until-bound.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deployUntilBound, refusalIn } from "./deploy-until-bound.ts";

/** A deploy that answers `outcomes` in turn, and what was said and waited between them. */
function pretendDeploys(outcomes: { code: number; notBound?: boolean; printed?: string }[]) {
  const outcomeOf = (outcome: (typeof outcomes)[number]) => ({
    code: outcome.code,
    refused: refusalIn(outcome.printed || (outcome.notBound ? NOT_BOUND_LINE : "")),
  });
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
        deploy: async () => outcomeOf(outcomes[deploys++]!),
        pause: async (seconds) => void waited.push(seconds),
        say: (line) => void said.push(line),
        waits,
      }),
  };
}

/** Alchemy's line for a Worker that Cloudflare did not bind. */
const NOT_BOUND_LINE =
  "ERROR (#1): ScriptStartupError: Pipeline binding error. Please try again later or contact support.";
/** Alchemy's line for a new sink that Cloudflare refused, as the stack gate printed it, less the header that names the request. */
const SINK_REFUSED_LINE =
  'ERROR (#1): InvalidSinkConfig: failed to validate Basin Catalog table: Unexpected, context: { status: 403 Forbidden, headers: {"content-length": "9", "server": "cloudflare", "connection": "keep-alive", "date": "Thu, 12 Nov 2026 15:56:59 GMT", "content-type": "text/plain;charset=UTF-8"}, json: Forbidden } => Received response with unexpected status code';

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
  assert.match(
    deploys.said.at(-1)!,
    /in each of 3 tries, the last time a Worker that binds .* The deploy failed\./,
  );
});

void test("a turn-on whose new sink Cloudflare refused with 403 is tried again, with a line of its own", async () => {
  const deploys = pretendDeploys([{ code: 1, printed: SINK_REFUSED_LINE }, { code: 0 }]);
  assert.equal(await deploys.run(), 0);
  assert.equal(deploys.deploys, 2);
  assert.deepEqual(deploys.waited, [20]);
  assert.equal(deploys.said.length, 1);
  assert.match(
    deploys.said[0]!,
    /^Cloudflare refused a new sink of the stack's log pipelines \("failed to validate Basin Catalog table", with 403\)\. .* Try 2 of 7 starts in 20 seconds/,
  );
});

void test("the two refusals share the tries: a sink refused, then a Worker not bound, then the last try", async () => {
  const deploys = pretendDeploys([
    { code: 1, printed: SINK_REFUSED_LINE },
    { code: 1, notBound: true },
    { code: 1, printed: SINK_REFUSED_LINE },
  ]);
  assert.equal(await deploys.run([1, 2]), 1);
  assert.equal(deploys.deploys, 3);
  assert.match(deploys.said[0]!, /a new sink .* Try 2 of 3 starts in 1 seconds/);
  assert.match(deploys.said[1]!, /a Worker that binds .* Try 3 of 3 starts in 2 seconds/);
  assert.match(
    deploys.said[2]!,
    /in each of 3 tries, the last time a new sink of the stack's log pipelines .* The deploy failed\./,
  );
});

void test("a sink that Cloudflare refused for another reason is not tried again", async () => {
  for (const printed of [
    // the same check with another answer than 403
    SINK_REFUSED_LINE.replaceAll("403 Forbidden", "409 Conflict"),
    // a 403 on another line than the check's
    "ERROR (#1): InvalidSinkConfig: failed to validate Basin Catalog table: the table has another schema\nGET /accounts/a/tokens -> 403 Forbidden",
    // a token that the catalog does not know
    '{"success":false,"errors":[{"code":1012,"message":"could not authenticate against the catalog with the provided token"}],"messages":[{"message":"Sink Definition was invalid"}]}',
  ]) {
    const deploys = pretendDeploys([{ code: 1, printed }]);
    assert.equal(await deploys.run(), 1);
    assert.equal(deploys.deploys, 1, printed);
    assert.deepEqual(deploys.said, []);
  }
});
