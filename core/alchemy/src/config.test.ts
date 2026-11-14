import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authConfigOf } from "core-auth-worker/config";
import {
  authSettingsOf,
  deployRefusalOf,
  loadMindConfig,
  MindConfig,
  resourceNamesOf,
  storedConfigOf,
} from "./config.ts";

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

void test("a forward address counts as the stack's mail: a mailed code takes it", () => {
  const forward = { forwardTo: "team@group.example" };
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

void test("a provided mind may not ask for the token: its stack has no mind Worker to hold it", () => {
  assert.equal(
    MindConfig.safeParse({ ...stack, mind: { provided: true }, cloudflareToken: true }).success,
    false,
  );
  assert.equal(MindConfig.safeParse({ ...stack, mind: { provided: true } }).success, true);
});

// As a deploy loads a config file, with `env` in its environment: a field that PUBLIC_FIELDS does
// not list is refused in the file. The test's own ITERATE_MIND__ variables (a shell with the
// deploy's secrets) are set aside meanwhile.
async function loadedFromFile(config: unknown, env: Record<string, string> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "mind-config-"));
  const given = { ...env, ITERATE_MIND_CONFIG: join(folder, "mind.config.json") };
  const ambient = Object.keys(process.env).filter((key) => key.startsWith("ITERATE_MIND__"));
  const before = [...new Set([...ambient, ...Object.keys(given)])].map(
    (key) => [key, process.env[key]] as const,
  );
  try {
    for (const key of ambient) delete process.env[key];
    Object.assign(process.env, given);
    writeFileSync(given.ITERATE_MIND_CONFIG, JSON.stringify(config));
    return await loadMindConfig(undefined);
  } finally {
    for (const [key, value] of before)
      if (value) process.env[key] = value;
      else delete process.env[key];
    rmSync(folder, { recursive: true });
  }
}

const cloudflare = { clientId: "proof-client" };
const withCloudflare = {
  ...stack,
  auth: { login: { ...stack.auth.login, methods: { cloudflare } } },
};
const SECRET_VAR = "ITERATE_MIND__AUTH__LOGIN__METHODS__CLOUDFLARE__CLIENT_SECRET";

void test("a config that asks for the mind's Cloudflare token is one the stack may keep in its state store", async () => {
  assert.equal((await loadedFromFile({ ...stack, cloudflareToken: true })).cloudflareToken, true);
});

const { domain: _, ...noDomain } = stack;

void test("a stack on a Free account with no domain yet is one the stack may keep in its state store, and reads back the same", async () => {
  const loaded = await loadedFromFile({
    ...noDomain,
    cloudflarePlan: "free",
    mind: { sandboxImage: "later" },
    cloudflareToken: true,
  });
  assert.equal(loaded.domain, undefined);
  assert.equal(loaded.cloudflarePlan, "free");
  assert.deepEqual(await loadedFromFile(storedConfigOf(loaded)), loaded);
  // the deploy after the card and the domain: the same config with the domain, without the plan,
  // and with its sandboxes still to come
  const { cloudflarePlan: _plan, ...paid } = { ...loaded, domain: "mind.example" };
  assert.equal(MindConfig.parse(paid).mind?.sandboxImage, "later");
});

void test("a Free account takes no telemetry, no provided mind, and its sandboxes said to come later", () => {
  const free = { ...noDomain, cloudflarePlan: "free", mind: { sandboxImage: "later" } };
  for (const refused of [
    { ...free, telemetry: true },
    { ...free, domain: "mind.example", mind: { provided: true } },
    { ...free, mind: { sandboxImage: "published" } },
    { ...free, mind: { sandboxImage: "managed" } },
    // no image named: the deploy after the card would build one with Docker
    { ...free, mind: {} },
    { ...noDomain, cloudflarePlan: "free" },
    { ...free, cloudflarePlan: "paid" },
  ])
    assert.equal(MindConfig.safeParse(refused).success, false, JSON.stringify(refused));
  for (const taken of [free, { ...stack, ...free }])
    assert.equal(MindConfig.safeParse(taken).success, true, JSON.stringify(taken));
});

void test("a stack with no domain has no mail and no provided mind: both live at the domain", () => {
  assert.equal(MindConfig.safeParse({ ...noDomain, mail: true }).success, false);
  assert.equal(MindConfig.safeParse({ ...noDomain, mind: { provided: true } }).success, false);
  assert.equal(MindConfig.safeParse(noDomain).success, true);
});

void test("a mind whose sandboxes come later is one the stack may keep in its state store, and reads back the same", async () => {
  const loaded = await loadedFromFile({ ...stack, mind: { sandboxImage: "later" } });
  assert.equal(loaded.mind?.sandboxImage, "later");
  assert.deepEqual(await loadedFromFile(storedConfigOf(loaded)), loaded);
});

void test("a config with the sign-in with Cloudflare is one the stack may keep in its state store, and reads back the same", async () => {
  const loaded = await loadedFromFile(withCloudflare);
  assert.deepEqual(loaded.auth.login.methods.cloudflare, cloudflare);
  // The stack stores the loaded config (./stack.ts), and a deploy with no config file parses it again.
  assert.deepEqual(await loadedFromFile(storedConfigOf(loaded)), loaded);
});

void test("the deploy's environment sets a field by its ITERATE_MIND__ variable, on top of the file", async () => {
  const loaded = await loadedFromFile(withCloudflare, {
    [SECRET_VAR]: "proof-secret",
    ITERATE_MIND__TELEMETRY: "true",
    ITERATE_MIND__MIND__TEMPLATE: "minimal",
    ITERATE_MIND__MAIL__FORWARD_TO: "team@group.example",
  });
  assert.deepEqual(loaded.auth.login.methods.cloudflare, {
    ...cloudflare,
    clientSecret: "proof-secret",
  });
  assert.equal(loaded.telemetry, true);
  assert.equal(loaded.mind?.template, "minimal");
  assert.deepEqual(loaded.mail, { forwardTo: "team@group.example" });
});

void test("the client's secret is in neither the stored config nor the auth Worker's settings, whose schema refuses it", async () => {
  const loaded = await loadedFromFile(withCloudflare, { [SECRET_VAR]: "proof-secret" });
  assert.deepEqual(storedConfigOf(loaded).auth.login.methods.cloudflare, cloudflare);
  assert.doesNotMatch(JSON.stringify(storedConfigOf(loaded)), /proof-secret/);
  const settings = authSettingsOf(loaded);
  assert.doesNotMatch(JSON.stringify(settings), /proof-secret/);
  assert.deepEqual(authConfigOf("mind.example", settings).login.methods.cloudflare, cloudflare);
  assert.throws(() => authConfigOf("mind.example", loaded.auth));
});

void test("a config file that holds the client's secret is refused, and the refusal names its variable", async () => {
  const withSecret = {
    ...stack,
    auth: {
      login: { ...stack.auth.login, methods: { cloudflare: { ...cloudflare, clientSecret: "x" } } },
    },
  };
  await assert.rejects(
    loadedFromFile(withSecret),
    new RegExp(`auth\\.login\\.methods\\.cloudflare\\.clientSecret \\(${SECRET_VAR}\\)`),
  );
});

void test("a deploy of the sign-in with Cloudflare and no client's secret is refused, by the secret's variable", async () => {
  assert.match(
    deployRefusalOf(await loadedFromFile(withCloudflare)) || "",
    new RegExp(`${SECRET_VAR} is not`),
  );
  assert.equal(
    deployRefusalOf(await loadedFromFile(withCloudflare, { [SECRET_VAR]: "proof-secret" })),
    undefined,
  );
  assert.equal(deployRefusalOf(await loadedFromFile(stack)), undefined);
});

void test("the client's secret in the environment of a stack with no sign-in with Cloudflare is ignored: one Doppler config deploys both", async () => {
  const loaded = await loadedFromFile(stack, { [SECRET_VAR]: "proof-secret" });
  assert.deepEqual(loaded, MindConfig.parse(stack));
  assert.equal(deployRefusalOf(loaded), undefined);
  // with the method's client id from the environment too, the method is the config's
  const both = await loadedFromFile(stack, {
    [SECRET_VAR]: "proof-secret",
    ITERATE_MIND__AUTH__LOGIN__METHODS__CLOUDFLARE__CLIENT_ID: "proof-client",
  });
  assert.deepEqual(both.auth.login.methods.cloudflare, {
    ...cloudflare,
    clientSecret: "proof-secret",
  });
});

void test("a variable the mind config does not name, and the old platform's ITERATE ones, fail no deploy", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const unnamed = [
    "ITERATE_MIND__NO_SUCH__FIELD",
    "ITERATE_MIND__AUTH__LOGIN__NO_SUCH",
    // under a leaf, a union, and an object the config does not have
    "ITERATE_MIND__TELEMETRY__NO_SUCH",
    "ITERATE_MIND__MAIL__NO_SUCH",
    "ITERATE_MIND__CLOUD__NO_SUCH",
    // an array's item: the array is set whole
    "ITERATE_MIND__AUTH__LOGIN__ALLOW__EMAIL",
  ];
  const loaded = await loadedFromFile(
    { ...stack, telemetry: true, mail: true },
    {
      ...Object.fromEntries(unnamed.map((key) => [key, "x"])),
      // a bridge's: the mind it lends to
      ITERATE_MIND: "a-slug",
      ITERATE: "not JSON",
      ITERATE__SECRETS_ENCRYPTION__KEY: "x",
      ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: "x",
    },
  );
  assert.deepEqual(loaded, MindConfig.parse({ ...stack, telemetry: true, mail: true }));
  const warned = warn.mock.calls.map(({ arguments: [line] }) => String(line));
  assert.deepEqual(
    warned.map((line) => line.split(":")[0]),
    unnamed,
  );
  assert.doesNotMatch(warned.join("\n"), /ITERATE__/);
});

void test("the queue of the longest stack name fits a Cloudflare Queue's name", () => {
  // a stack's name is at most 40 characters; a Queue's is at most 63
  const { cloudflareEvents } = resourceNamesOf("a".repeat(40));
  assert.ok(cloudflareEvents.length <= 63, `${cloudflareEvents.length} characters`);
});

void test("a config's old default for hostnames is read and not kept; any other value is refused", () => {
  assert.deepEqual(MindConfig.parse({ ...stack, hostnames: "all" }), MindConfig.parse(stack));
  assert.equal(MindConfig.safeParse({ ...stack, hostnames: "platform" }).success, false);
});

const cloudService = {
  name: "cloud",
  worker: "proof-cloud",
  entrypoint: "Service",
  description: "installs minds",
};

void test("a config's services are kept whole in the stored config, and read back the same", async () => {
  const loaded = await loadedFromFile({ ...stack, services: [cloudService] });
  assert.deepEqual(loaded.services, [cloudService]);
  assert.deepEqual(storedConfigOf(loaded).services, [cloudService]);
});

void test("a service named twice, a name no itx step takes, a provided mind's service and another key are refused", () => {
  for (const services of [
    [cloudService, { ...cloudService, worker: "other" }],
    [{ ...cloudService, name: "the-cloud" }],
    [{ ...cloudService, worker: "Proof Cloud" }],
    [{ ...cloudService, accountId: "0".repeat(32) }],
  ])
    assert.equal(
      MindConfig.safeParse({ ...stack, services }).success,
      false,
      JSON.stringify(services),
    );
  assert.equal(
    MindConfig.safeParse({ ...stack, mind: { provided: true }, services: [cloudService] }).success,
    false,
  );
  assert.equal(
    MindConfig.safeParse({ ...stack, services: [{ name: "x", worker: "y" }] }).success,
    true,
  );
});
