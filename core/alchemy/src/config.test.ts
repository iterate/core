import assert from "node:assert/strict";
import { test } from "node:test";
import { MindConfig, namesOf } from "./config.ts";

void test("a config with every field parses, and a field it does not name is refused", () => {
  assert.equal(MindConfig.safeParse(config()).success, true);
  assert.equal(MindConfig.safeParse({ ...config(), domain: "example.com" }).success, false);
});

void test("the mind id is 64 lowercase hex characters, and never left out", () => {
  const { mindId: _, ...withoutMindId } = config();
  assert.equal(MindConfig.safeParse(withoutMindId).success, false);
  for (const mindId of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
    const refused = MindConfig.safeParse({ ...config(), mindId });
    assert.deepEqual(refused.error?.issues[0]?.path, ["mindId"]);
  }
});

void test("the control plane's hostname is a zone of the mind, or one label under one", () => {
  for (const controlPlaneHostname of [
    "example.com",
    "iterate.example.com",
    "control.sub.example.net",
  ])
    assert.equal(MindConfig.safeParse({ ...config(), controlPlaneHostname }).success, true);
});

void test("a hostname two labels under a zone, or one that only ends like a zone, is refused", () => {
  for (const controlPlaneHostname of [
    "a.b.example.com",
    "evil-example.com",
    "iterate.example.org",
  ]) {
    const refused = MindConfig.safeParse({ ...config(), controlPlaneHostname });
    assert.deepEqual(refused.error?.issues[0]?.path, ["controlPlaneHostname"]);
    assert.match(refused.error?.issues[0]?.message || "", /certificate/);
  }
});

void test("an owner's address is at no zone of the mind, and at no name under one", () => {
  for (const email of ["ada@example.com", "ada@mail.sub.example.net"]) {
    const refused = MindConfig.safeParse({ ...config(), ownerEmails: [email] });
    assert.deepEqual(refused.error?.issues[0]?.path, ["ownerEmails"]);
  }
});

void test("a topology is one of the two, and never left out", () => {
  const { topology: _, ...withoutTopology } = config();
  assert.equal(MindConfig.safeParse(withoutTopology).success, false);
  assert.equal(MindConfig.safeParse({ ...config(), topology: "home-lab" }).success, false);
});

void test("every resource's name starts with iterate-<stage>, with _ where Cloudflare takes no -", () => {
  const names = namesOf(MindConfig.parse(config()));
  assert.equal(names.state, "iterate-example-com-state");
  assert.equal(names.cloudflareEvents, "iterate-example-com-events");
  assert.equal(names.telemetryMetrics, "iterate_example_com_metrics");
  assert.equal(names.telemetryTables, "iterate_example_com_telemetry");
  for (const name of Object.values(names)) assert.match(name, /^iterate[-_]example[-_]com[-_]/);
});

void test("no config field names another state store: the store is iterate-<stage>-state", () => {
  const refused = MindConfig.safeParse({
    ...config(),
    alchemy: { stageName: "example-com", stateStoreName: "iterate-example-state" },
  });
  assert.deepEqual(refused.error?.issues[0]?.path, ["alchemy"]);
});

function config() {
  return {
    mindId: "a".repeat(64),
    controlPlaneHostname: "iterate.example.com",
    ownerEmails: ["ada@example.org"],
    topology: "full-cloudflare",
    alchemy: { stageName: "example-com" },
    cloudflare: { accountId: "a".repeat(32), zones: ["example.com", "sub.example.net"] },
  };
}
