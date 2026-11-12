// What a deploy does around Alchemy's run for the stack's telemetry tables (telemetry-at-deploy.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { deployAroundTelemetry } from "./telemetry-at-deploy.ts";

/** One run with what it said and the order of what it did. */
async function run(input: {
  telemetry: boolean;
  drops?: ({ failed: boolean; lines: string[]; bucketLeft?: boolean } | Error)[];
  catalogOn?: boolean | Error;
  code?: number;
}) {
  const did: string[] = [];
  const said: string[] = [];
  const drops = [...(input.drops || [])];
  const code = await deployAroundTelemetry({
    telemetry: input.telemetry,
    name: "one",
    bucket: "iterate-one-telemetry",
    drop: async () => {
      did.push("drop");
      const next = drops.shift() || { failed: false, lines: [] };
      if (next instanceof Error) throw next;
      return next;
    },
    catalogOn: async () => {
      did.push("read");
      if (input.catalogOn instanceof Error) throw input.catalogOn;
      return input.catalogOn === true;
    },
    deploy: async () => {
      did.push("deploy");
      return input.code ?? 0;
    },
    say: (line) => said.push(line),
  });
  return { code, did, said };
}

void test("with telemetry on, the step runs before the deploy and its lines are said", async () => {
  const { code, did, said } = await run({
    telemetry: true,
    drops: [{ failed: false, lines: ["Dropped: table telemetry.logs"] }],
  });
  assert.equal(code, 0);
  assert.deepEqual(did, ["drop", "deploy"]);
  assert.deepEqual(said, ["Dropped: table telemetry.logs"]);
});

void test("the temporary bucket could not be removed, so the deploy does not start", async () => {
  const { code, did, said } = await run({
    telemetry: true,
    drops: [{ failed: true, bucketLeft: true, lines: ["NOT removed: the bucket"] }],
  });
  assert.equal(code, 1);
  assert.deepEqual(did, ["drop"]);
  assert.equal(said[0], "NOT removed: the bucket");
  assert.match(
    said[1]!,
    /^Stopped before the deploy: the bucket iterate-one-telemetry, .* a deploy would take it as the stack's own\. Nothing of the stack was changed\./,
  );
});

void test("a step that did not end may have made its bucket, so the deploy does not start", async () => {
  const { code, did, said } = await run({ telemetry: true, drops: [new Error("fetch failed")] });
  assert.equal(code, 1);
  assert.deepEqual(did, ["drop"]);
  assert.match(said[0]!, /^Stopped before the deploy: .* did not end \(fetch failed\)/);
});

void test("a step that failed and left no bucket is said in a note, and the deploy goes on", async () => {
  const { code, did, said } = await run({
    telemetry: true,
    drops: [{ failed: true, lines: ["Cloudflare answered 403"] }],
  });
  assert.equal(code, 0);
  assert.deepEqual(did, ["drop", "deploy"]);
  assert.match(
    said[1]!,
    /^Note: the stack's telemetry tables could not be looked at\. The deploy goes on\./,
  );
});

void test("a deploy that turned telemetry off drops the tables after Alchemy has ended, never beside it", async () => {
  const { code, did, said } = await run({
    telemetry: false,
    catalogOn: true,
    drops: [{ failed: false, lines: ["Dropped: table telemetry.logs"] }],
  });
  assert.equal(code, 0);
  assert.deepEqual(did, ["read", "deploy", "drop"]);
  assert.match(said[0]!, /^This deploy turned telemetry off for one\. .* with the rows in them/);
  assert.equal(said[1], "Dropped: table telemetry.logs");
});

void test("a deploy with telemetry off that failed, or of a stack whose catalog is off, drops nothing", async () => {
  assert.deepEqual((await run({ telemetry: false, catalogOn: true, code: 1 })).did, [
    "read",
    "deploy",
  ]);
  assert.deepEqual((await run({ telemetry: false, catalogOn: false })).did, ["read", "deploy"]);
  // a read that did not answer: the deploy goes on
  const unread = await run({ telemetry: false, catalogOn: new Error("fetch failed") });
  assert.deepEqual(unread.did, ["read", "deploy"]);
  assert.equal(unread.code, 0);
});

void test("the step after a turn-off fails no deploy: a table or a bucket left is said in a note", async () => {
  for (const drops of [
    [{ failed: true, bucketLeft: true, lines: ["NOT removed: the bucket"] }],
    [new Error("fetch failed")],
  ]) {
    const { code, said } = await run({ telemetry: false, catalogOn: true, drops });
    assert.equal(code, 0);
    assert.match(
      said.at(-1)!,
      /^Note: a telemetry table of the stack may be left\. The stack is deployed and works\./,
    );
  }
});
