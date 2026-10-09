// iterate-config.test.ts — the iterate config as a deploy takes it: read from its file, split into
// the Worker's variables, and the names of what the Worker binds. How the Worker reads each field
// is its consumers' tests'.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { readDeployment } from "../scripts/iterate-config-file.ts";
import {
  deploymentOf,
  type IterateConfigInput,
  parseIterateConfig,
  resourceNamesOf,
  secretFieldsOf,
} from "./iterate-config.ts";

test("deploymentOf: each set secret field is a variable of its own, as JSON; ITERATE, what the schema names of the rest", () => {
  // the parse warns about each unknown key (iterate/app-config), which is not this test's subject
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // two keys the schema does not name, one in an array's element
  const route = { pattern: "os.acme.test/*", zone: "acme.test" };
  const { vars } = deploymentOf({
    ...configInput(),
    secrets: { key: "old-key" },
    cloudflare: { ...configInput().cloudflare, workerRoutes: [{ ...route, apiToken: "a-token" }] },
  });
  // exact: a secret or an unknown key left in ITERATE, or one variable too many, must fail
  expect({ ITERATE: JSON.parse(vars.ITERATE), secrets: vars.secrets }).toEqual({
    ITERATE: {
      cloudflare: { accountId: "account-1", resourcePrefix: "acme-os", workerRoutes: [route] },
      login: {
        methods: { emailCode: { from: "iterate <login@acme.test>" }, password: {} },
        allow: [{ emailDomain: "acme.test" }],
      },
      secretsEncryption: {},
    },
    secrets: {
      ITERATE__ADMIN_BEARER: '"true"',
      ITERATE__CLOUDFLARE__API_TOKEN: '"cf-token"',
      ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: '"p"',
      ITERATE__SECRETS_ENCRYPTION__KEY: '"key line 1\\nkey line 2"',
    },
  });
});

test("deploymentOf: the Worker parses its variables back into the config the deploy parsed, each secret exactly", () => {
  const { config, vars } = deploymentOf(configInput());
  const onWorker = parseIterateConfig({ ITERATE: vars.ITERATE, ...vars.secrets });
  // JSON shows every plain field, in order, and each secret as REDACTED; secretFieldsOf, their values
  expect(JSON.stringify(onWorker)).toBe(JSON.stringify(config));
  expect(secretFieldsOf(onWorker)).toEqual(secretFieldsOf(config));
});

test("resourceNamesOf: the KV titles follow the Worker's name, the other resources the prefix", () => {
  expect(resourceNamesOf({ resourcePrefix: "acme", workerName: "acme-os" })).toMatchObject({
    db: "acme-db",
    oauthKv: "acme-os-oauth-kv",
    itxKv: "acme-os-itx-kv",
  });
});

test("readDeployment: a malformed config names the field, both its spellings, and how to change it", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "iterate-config-")), "iterate.config.ts");
  writeFileSync(
    file,
    `export default { cloudflare: { accountId: "a", apiToken: "t", resourcePrefix: "acme" } };`,
  );
  await expect(readDeployment(file)).rejects.toThrow(
    /^ITERATE login \(ITERATE__LOGIN\): required, but unset or blank\n.*core\/os\/\.secrets.*iterate\.config\.local\.ts/s,
  );
});

/** A deployment's config as a file writes it: plain fields beside secret ones, one of them blank. */
function configInput() {
  return {
    cloudflare: { accountId: "account-1", apiToken: "cf-token", resourcePrefix: "acme-os" },
    // two ways in, the password's secret inside its method's settings
    login: {
      methods: { emailCode: { from: "iterate <login@acme.test>" }, password: { password: "p" } },
      allow: [{ emailDomain: "acme.test" }],
    },
    secretsEncryption: { key: "key line 1\nkey line 2", previousKey: "" },
    // reads as JSON `true`: its variable must keep it a string
    adminBearer: "true",
  } satisfies IterateConfigInput;
}
