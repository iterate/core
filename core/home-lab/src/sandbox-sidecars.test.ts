// Which containers the launcher removes (sandbox-sidecars.ts): a sidecar that workerd left, and
// nothing else on the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { leftSidecars, type Listed } from "./sandbox-sidecars.ts";

const NOW = Date.parse("2026-11-12T04:00:00Z");
const PROXY = "cloudflare/proxy-everything:3cb1195@sha256:0ef6";
const old = NOW - 10 * 60_000;
const container = (name: string, image: string, more: Partial<Listed> = {}): Listed => ({
  name,
  image,
  state: "running",
  createdAt: old,
  ...more,
});

void test("a sidecar whose sandbox is gone is removed, and one whose sandbox runs is kept", () => {
  const listed = [
    container("workerd-mind-SandboxContainer-aaa-proxy", PROXY),
    container("workerd-mind-SandboxContainer-bbb-proxy", PROXY),
    container("workerd-mind-SandboxContainer-bbb", "iterate-dev-image:0123456789ab"),
    // its sandbox is listed and has stopped: the sidecar serves nobody
    container("workerd-mind-SandboxContainer-ccc-proxy", PROXY),
    container("workerd-mind-SandboxContainer-ccc", "iterate-dev-image:0123456789ab", {
      state: "exited",
    }),
  ];
  assert.deepEqual(leftSidecars(listed, NOW), [
    "workerd-mind-SandboxContainer-aaa-proxy",
    "workerd-mind-SandboxContainer-ccc-proxy",
  ]);
});

void test("a sidecar that has just started is kept: its sandbox starts a moment after it", () => {
  const listed = [
    container("workerd-mind-SandboxContainer-new-proxy", PROXY, { createdAt: NOW - 5_000 }),
  ];
  assert.deepEqual(leftSidecars(listed, NOW), []);
  assert.deepEqual(leftSidecars(listed, NOW + 120_000), [
    "workerd-mind-SandboxContainer-new-proxy",
  ]);
});

void test("no other container of the machine is touched", () => {
  const listed = [
    // somebody's own container that happens to end in -proxy
    container("my-proxy", "nginx:1"),
    // of workerd's naming, and not the proxy image
    container("workerd-mind-SandboxContainer-ddd-proxy", "nginx:1"),
    // the proxy image under a name that is not workerd's
    container("egress-proxy", PROXY),
    container("postgres", "postgres:17"),
  ];
  assert.deepEqual(leftSidecars(listed, NOW), []);
});
