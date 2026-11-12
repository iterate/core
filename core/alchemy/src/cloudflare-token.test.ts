// What the mind's own Cloudflare API token may do (cloudflare-token.ts), held against the catalog
// of permission groups that Alchemy ships.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSION_GROUPS } from "@alchemy.run/cloudflare/ApiToken";
import {
  CLOUDFLARE_TOKEN_READS_LEFT_OUT,
  CLOUDFLARE_TOKEN_WRITES,
  cloudflareTokenGroupsOf,
  cloudflareTokenPoliciesOf,
} from "./cloudflare-token.ts";

const ACCOUNT = "0".repeat(32);
const groups = cloudflareTokenGroupsOf();
const held = [...groups.account, ...groups.zone];
const names = new Set<string>(held.map(({ name }) => name));

void test("the token holds reads, and the writes that are named: nothing else", () => {
  const writes: readonly string[] = CLOUDFLARE_TOKEN_WRITES;
  for (const { name } of held) assert.ok(/ read$/i.test(name) || writes.includes(name), name);
  for (const name of writes) assert.ok(names.has(name), name);
});

void test("the token deploys nothing, makes no token, and changes no name or setting", () => {
  for (const name of [
    "Workers Scripts Write",
    "Workers Routes Write",
    "Workers Containers Write",
    "Workers CI Write",
    "Pages Write",
    "Account API Tokens Write",
    "DNS Write",
    "Zone Write",
    "Zone Settings Write",
    "Account Settings Write",
    "Registrar Domains Admin",
    "AI Gateway Write",
  ]) {
    assert.ok(
      PERMISSION_GROUPS.some((group) => group.name === name),
      `the catalog has ${name}`,
    );
    assert.ok(!names.has(name), name);
  }
});

void test("a read that is left out is a group of the catalog, and the token does not hold it", () => {
  for (const name of Object.keys(CLOUDFLARE_TOKEN_READS_LEFT_OUT)) {
    assert.ok(
      PERMISSION_GROUPS.some((group) => group.name === name),
      `the catalog has ${name}`,
    );
    assert.ok(!names.has(name), name);
  }
});

// A catalog that gains or loses a read group changes these numbers. Before you change them, ask
// of each new read what cloudflare-token.ts asks: does it yield a credential that can do more
// than this token? A changed list also changes the token of every stack at its next deploy.
void test("the token's groups are as many as were looked at, and none is there twice", () => {
  assert.equal(groups.account.length, 147);
  assert.equal(groups.zone.length, 45);
  assert.equal(new Set(held.map(({ id }) => id)).size, held.length);
});

void test("one policy is for the account and one for every zone of it", () => {
  const policies = cloudflareTokenPoliciesOf(ACCOUNT);
  assert.deepEqual(
    policies.map(({ effect, resources }) => ({ effect, resources })),
    [
      { effect: "allow", resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" } },
      {
        effect: "allow",
        resources: {
          [`com.cloudflare.api.account.${ACCOUNT}`]: { "com.cloudflare.api.account.zone.*": "*" },
        },
      },
    ],
  );
  assert.deepEqual(
    policies.map(({ permissionGroups }) => permissionGroups),
    [groups.account.map(({ id }) => ({ id })), groups.zone.map(({ id }) => ({ id }))],
  );
});
