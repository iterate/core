// deploy.test.ts — what `pnpm run deploy` makes of the iterate config before it touches an account:
// the Worker variables, and the deployment a config file names. The account calls are `cf`'s.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  type IterateConfigInput,
  parseIterateConfig,
  parseIterateConfigInput,
} from "../src/iterate-config.ts";
import { readDeployment, workerVarsOf } from "./iterate-config-file.ts";

/** A deployment's config as a file writes it: plain fields beside secret ones, one of them blank. */
const INPUT = {
  cloudflare: { accountId: "account-1", resourcePrefix: "acme-os" },
  // two ways in, the password's secret inside its method's settings
  login: {
    methods: { emailCode: { from: "iterate <login@acme.test>" }, password: { password: "p" } },
    allow: [{ emailDomain: "acme.test" }],
  },
  secretsEncryption: { key: "the-key", previousKey: "" },
  adminBearer: "the-bearer",
  integrations: {
    github: {
      appId: "1",
      appSlug: "acme",
      oauthClientId: "Iv1.acme",
      oauthClientSecret: "github-secret",
      privateKey: "key line 1\nkey line 2",
      webhookSecret: "true",
    },
  },
} satisfies IterateConfigInput;

test("workerVarsOf: each set secret field is a secret of its own, named by its path, and the rest the plain var; the Worker parses them back into the same config", () => {
  const config = parseIterateConfigInput(INPUT);
  const vars = workerVarsOf(INPUT, config);
  expect(Object.keys(vars.secrets).sort()).toEqual([
    "ITERATE__ADMIN_BEARER",
    "ITERATE__INTEGRATIONS__GITHUB__OAUTH_CLIENT_SECRET",
    "ITERATE__INTEGRATIONS__GITHUB__PRIVATE_KEY",
    "ITERATE__INTEGRATIONS__GITHUB__WEBHOOK_SECRET",
    "ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD",
    "ITERATE__SECRETS_ENCRYPTION__KEY",
  ]);
  expect(JSON.parse(vars.ITERATE)).toEqual({
    cloudflare: { accountId: "account-1", resourcePrefix: "acme-os" },
    // the methods, in order, without the password's secret
    login: {
      methods: { emailCode: { from: "iterate <login@acme.test>" }, password: {} },
      allow: [{ emailDomain: "acme.test" }],
    },
    secretsEncryption: {},
    integrations: { github: { appId: "1", appSlug: "acme", oauthClientId: "Iv1.acme" } },
  });
  const onWorker = parseIterateConfig({ ITERATE: vars.ITERATE, ...vars.secrets });
  expect(JSON.stringify(onWorker)).toBe(JSON.stringify(config));
  expect(onWorker.integrations.github?.webhookSecret.exposeSecret()).toBe("true");
  expect(onWorker.integrations.github?.privateKey.exposeSecret()).toBe("key line 1\nkey line 2");
  expect(onWorker.secretsEncryption.key.exposeSecret()).toBe("the-key");
  expect(onWorker.login.methods.password?.password.exposeSecret()).toBe("p");
  expect(Object.keys(onWorker.login.methods)).toEqual(["emailCode", "password"]);
  expect(vars.ITERATE).not.toContain('"p"');
});

test("workerVarsOf: a key the schema does not name, an array's element's too, never reaches the plain var", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const input = {
    ...INPUT,
    secrets: { key: "old-key" },
    cloudflare: {
      ...INPUT.cloudflare,
      workerRoutes: [{ pattern: "os.acme.test/*", zone: "acme.test", apiToken: "a-token" }],
    },
  };
  const vars = workerVarsOf(input, parseIterateConfigInput(input));
  expect(JSON.parse(vars.ITERATE)).toEqual({
    cloudflare: {
      ...INPUT.cloudflare,
      workerRoutes: [{ pattern: "os.acme.test/*", zone: "acme.test" }],
    },
    login: {
      methods: { emailCode: { from: "iterate <login@acme.test>" }, password: {} },
      allow: [{ emailDomain: "acme.test" }],
    },
    secretsEncryption: {},
    integrations: { github: { appId: "1", appSlug: "acme", oauthClientId: "Iv1.acme" } },
  });
});

test("readDeployment: a config without a `cloudflare` section is no deployment, so a shell that exports one field still builds locally", async () => {
  expect(await readDeployment(configFile("export default {};"))).toBeUndefined();
  expect(
    await readDeployment(configFile('export default { adminBearer: "a client\'s bearer" };')),
  ).toBeUndefined();
});

test("readDeployment: a malformed config names the field, both its spellings, and how to change it", async () => {
  await expect(
    readDeployment(
      configFile(
        'export default { cloudflare: { accountId: "a", resourcePrefix: "acme-os" }, login: { methods: { password: { password: "p" } }, allow: [{ everyone: {} }] } };',
      ),
    ),
  ).rejects.toThrow(
    /ITERATE secretsEncryption\.key \(ITERATE__SECRETS_ENCRYPTION__KEY\): required, but unset or blank\n.*core\/os\/\.secrets.*iterate\.config\.local\.ts/s,
  );
});

/** A config file in a scratch folder, exporting `source`. */
function configFile(source: string) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "iterate-config-")), "iterate.config.ts");
  writeFileSync(file, source);
  return file;
}
