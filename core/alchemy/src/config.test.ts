import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMindConfig, MindConfig, resourceNamesOf } from "./config.ts";

const stack = {
  name: "proof",
  accountId: "0".repeat(32),
  domain: "mind.example",
  auth: { login: { methods: {}, allow: [{ email: "ada@sender.example" }] } },
};

void test("a stack's mail is on, or on with an address that each mail is forwarded to", () => {
  assert.equal(MindConfig.parse({ ...stack, mail: true }).mail, true);
  assert.deepEqual(MindConfig.parse({ ...stack, mail: { forwardTo: "team@group.example" } }).mail, {
    forwardTo: "team@group.example",
  });
  assert.equal(MindConfig.parse(stack).mail, undefined);
});

void test("a forward address that is no address, and a mail setting with another key, are refused", () => {
  for (const mail of [
    { forwardTo: "the team" },
    { forwardTo: "team@group.example", cc: "x" },
    {},
    false,
  ])
    assert.equal(MindConfig.safeParse({ ...stack, mail }).success, false, JSON.stringify(mail));
});

void test("a forward address counts as the stack's mail: one hostname of a zone refuses it, and a mailed code takes it", () => {
  const forward = { forwardTo: "team@group.example" };
  assert.equal(
    MindConfig.safeParse({ ...stack, hostnames: "platform", mail: forward }).success,
    false,
  );
  const mailed = { login: { methods: { email: {} }, allow: stack.auth.login.allow } };
  assert.equal(MindConfig.safeParse({ ...stack, auth: mailed, mail: forward }).success, true);
  assert.equal(MindConfig.safeParse({ ...stack, auth: mailed }).success, false);
});

void test("a forward address at the stack's own domain, or under it, is refused: such a mail comes back to the stack", () => {
  for (const forwardTo of ["team@mind.example", "team@sub.mind.example", "team@MIND.example"])
    assert.equal(MindConfig.safeParse({ ...stack, mail: { forwardTo } }).success, false, forwardTo);
  // another domain that only ends in the same letters is no part of it
  assert.equal(
    MindConfig.safeParse({ ...stack, mail: { forwardTo: "team@notmind.example" } }).success,
    true,
  );
});

void test("a config may ask for the mind's Cloudflare token, and only by `true`", () => {
  assert.equal(MindConfig.parse({ ...stack, cloudflareToken: true }).cloudflareToken, true);
  assert.equal(MindConfig.parse(stack).cloudflareToken, undefined);
  for (const cloudflareToken of [false, "true", {}])
    assert.equal(
      MindConfig.safeParse({ ...stack, cloudflareToken }).success,
      false,
      JSON.stringify(cloudflareToken),
    );
});

void test("a config that asks for the mind's Cloudflare token is one the stack may keep in its state store", async () => {
  const folder = mkdtempSync(join(tmpdir(), "mind-config-"));
  const named = process.env.ITERATE_MIND_CONFIG;
  try {
    process.env.ITERATE_MIND_CONFIG = join(folder, "mind.config.json");
    writeFileSync(
      process.env.ITERATE_MIND_CONFIG,
      JSON.stringify({ ...stack, cloudflareToken: true }),
    );
    assert.equal((await loadMindConfig(undefined)).cloudflareToken, true);
  } finally {
    if (named) process.env.ITERATE_MIND_CONFIG = named;
    else delete process.env.ITERATE_MIND_CONFIG;
    rmSync(folder, { recursive: true });
  }
});

void test("the queue of the longest stack name fits a Cloudflare Queue's name", () => {
  // a stack's name is at most 40 characters; a Queue's is at most 63
  const { cloudflareEvents } = resourceNamesOf("a".repeat(40));
  assert.ok(cloudflareEvents.length <= 63, `${cloudflareEvents.length} characters`);
});
