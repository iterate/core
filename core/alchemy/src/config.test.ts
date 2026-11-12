import assert from "node:assert/strict";
import { test } from "node:test";
import { MindConfig } from "./config.ts";

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
