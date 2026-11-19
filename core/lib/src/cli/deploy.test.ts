import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MindConfig as ScriptConfig } from "../../../alchemy/src/config.ts";
import {
  DEPLOY_SCOPES,
  RECOVER_SCOPES,
  scopesLacking,
  STACK_SCOPES,
  TELEMETRY_TOKEN_ENV,
  TELEMETRY_TOKEN_PERMISSIONS,
  telemetryTokenPage,
} from "./cloudflare-access.ts";
import {
  boundaryCheck,
  boundaryMisses,
  candidatesOf,
  createPalette,
  deployArgsOf,
  deployConfigOf,
  deployedMind,
  domainPickerOptions,
  earlierDeployOf,
  ENTER_NEW_DOMAIN,
  erateOf,
  formatMindConfigForStdout,
  identityKeyLineOf,
  isColorEnabled,
  isInteractiveEnv,
  mindConfigIn,
  onboardingUrlOf,
  planArgsOf,
  PNPM_COMPAT_ENV,
  pnpmCommandOf,
  productRead,
  redactMindConfig,
  saysTheStateStoreRefused,
  stageNameOf,
  verifyTelemetryToken,
  zeroTrustStep,
} from "./deploy.ts";

test("the stage is the zone with a hyphen for each dot, at most 32 characters, a letter first", () => {
  expect(stageNameOf("ada-labs.com")).toBe("ada-labs-com");
  expect(stageNameOf("mind.example.co.uk")).toBe("mind-example-co-uk");
  expect(stageNameOf("4you.example")).toBe("z4you-example");
  // cut where the script's limit is, and never left with a hyphen at its end
  expect(stageNameOf(`${"a".repeat(31)}.example.com`)).toBe("a".repeat(31));
  expect(stageNameOf(`${"a".repeat(40)}.com`)).toBe("a".repeat(32));
});

test("the names asked about come from the person's name and words: the -erate names first, then .com, 20 at most", () => {
  expect(erateOf("jonas")).toBe("jonaserate");
  expect(erateOf("misha")).toBe("misherate");
  const names = candidatesOf("Ada Lovelace", "engines");
  expect(names).toHaveLength(20);
  expect(names.slice(0, 8)).toEqual([
    "aderate.com",
    "lovelacerate.com",
    "aderate.dev",
    "lovelacerate.dev",
    "adalovelace.com",
    "ada-lovelace.com",
    "adal.com",
    "lovelace.com",
  ]);
  expect(names).toContain("engines.com");
  expect(names).toContain("adaengines.com");
  expect(candidatesOf("ada")).toEqual([
    "aderate.com",
    "aderate.dev",
    "adas.com",
    "heyada.com",
    "adahq.com",
    "adas.dev",
    "adas.net",
    "adas.xyz",
    "heyada.dev",
    "heyada.net",
    "heyada.xyz",
    "adahq.dev",
    "adahq.net",
    "adahq.xyz",
  ]);
});

const answers = {
  accountId: "0".repeat(32),
  domain: "ada-labs.com",
  owner: "Ada@Example.org",
};

test("a new mind's config is the script's one input but for its id: the zone whole, one owner, iterate.<zone>, and the stage from the zone", () => {
  expect(deployConfigOf(answers)).toEqual({
    // the hash of the genesis that the command signs before the deploy (identity.ts)
    mindId: undefined,
    controlPlaneHostname: "iterate.ada-labs.com",
    ownerEmails: ["ada@example.org"],
    topology: "full-cloudflare",
    alchemy: { stageName: "ada-labs-com" },
    cloudflare: { accountId: "0".repeat(32), zones: ["ada-labs.com"] },
  });
  expect(deployConfigOf(answers).mail).toBeUndefined();
  expect(deployConfigOf({ ...answers, mailForwardTo: "team@group.example" })).toMatchObject({
    mail: { forwardTo: "team@group.example" },
  });
});

test("the control plane's hostname is the zone or one label under it, and nothing else", () => {
  const at = (controlPlaneHostname: string) =>
    deployConfigOf({ ...answers, controlPlaneHostname }).controlPlaneHostname;
  expect(at("ada-labs.com")).toBe("ada-labs.com");
  expect(at("Mind.ada-labs.com")).toBe("mind.ada-labs.com");
  // a zone's certificate covers no name two labels deep
  expect(() => at("a.mind.ada-labs.com")).toThrow(/ada-labs\.com, or one label under it/);
  expect(() => at("iterate.example.com")).toThrow(/cannot answer at iterate\.example\.com/);
  expect(() => at("not a hostname")).toThrow(/cannot answer at/);
});

test("an owner's address is an email address that is not at the mind's own domain", () => {
  expect(() => deployConfigOf({ ...answers, owner: "ada@ada-labs.com" })).toThrow(
    /takes that domain's mail/,
  );
  expect(() => deployConfigOf({ ...answers, owner: "ada@mail.ada-labs.com" })).toThrow(
    /takes that domain's mail/,
  );
  expect(() => deployConfigOf({ ...answers, owner: "ada" })).toThrow(/is an email address/);
  expect(() => deployConfigOf({ ...answers, owner: undefined })).toThrow(/is an email address/);
});

const deployed = {
  stageName: "ada",
  mindId: "cd".repeat(32),
  controlPlaneHostname: "ada-labs.com",
  zones: ["ada-labs.com", "ada.example"],
  ownerEmails: ["ada@example.org", "charles@example.org"],
  topology: "external-mind-connects-into-cloudflare-boundary" as const,
};

test("a deploy over a mind keeps what the mind has, its id among it, and a flag replaces its owners or its hostname", () => {
  const { accountId } = answers;
  expect(deployConfigOf({ accountId, domain: "ada.example", deployed })).toEqual({
    mindId: "cd".repeat(32),
    controlPlaneHostname: "ada-labs.com",
    ownerEmails: ["ada@example.org", "charles@example.org"],
    topology: "external-mind-connects-into-cloudflare-boundary",
    alchemy: { stageName: "ada" },
    cloudflare: { accountId, zones: ["ada-labs.com", "ada.example"] },
  });
  expect(
    deployConfigOf({
      accountId,
      domain: "ada.example",
      deployed,
      owner: "grace@example.org",
      controlPlaneHostname: "iterate.ada.example",
    }),
  ).toMatchObject({
    mindId: "cd".repeat(32),
    controlPlaneHostname: "iterate.ada.example",
    ownerEmails: ["grace@example.org"],
    alchemy: { stageName: "ada" },
  });
});

test("a deployed mind's config is read from its boundary Worker's settings: the plain-text variable ITERATE", () => {
  const { stageName: _, ...config } = deployed;
  const settings = (text: string) => ({
    compatibility_date: "2026-01-01",
    bindings: [
      { type: "service", name: "AUTH", service: "iterate-ada-auth" },
      { type: "secret_text", name: "ITERATE__SIGNING_KEY" },
      { type: "plain_text", name: "ITERATE", text },
    ],
  });
  expect(mindConfigIn(settings(JSON.stringify(config)))).toEqual(config);
  // what is no config of a mind is none: text that is no JSON, a config with no owner, no variable
  expect(mindConfigIn(settings("{"))).toBeUndefined();
  expect(mindConfigIn(settings(JSON.stringify({ ...config, ownerEmails: [] })))).toBeUndefined();
  expect(mindConfigIn({ bindings: [] })).toBeUndefined();
  expect(mindConfigIn(null)).toBeUndefined();
});

test("a deployed mind whose config holds no id is read all the same, and only such a mind and a new one get an id from this run", () => {
  const { stageName, mindId: _, ...withoutId } = deployed;
  const read = mindConfigIn({
    bindings: [{ type: "plain_text", name: "ITERATE", text: JSON.stringify(withoutId) }],
  });
  expect(read).toEqual(withoutId);
  const { accountId } = answers;
  const config = (mind: typeof read) =>
    deployConfigOf({ accountId, domain: "ada.example", deployed: mind && { ...mind, stageName } });
  // no id in the config: the command makes the mind's identity before it deploys
  expect(config(read).mindId).toBeUndefined();
  expect(deployConfigOf(answers).mindId).toBeUndefined();
  // an id in the config is the one that the script gets, whatever else a flag replaces
  expect(config({ ...withoutId, mindId: "cd".repeat(32) })).toMatchObject({
    mindId: "cd".repeat(32),
  });
});

test("ML-DSA-65 is checked only for a mind with no id, before any account mutation or domain purchase", () => {
  const source = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8");
  expect(source.match(/.*mlDsaRequired\(.*/g)).toEqual([
    "    if (!config.mindId) await mlDsaRequired();",
  ]);
  expect(source).not.toContain("canVerifyMlDsa65");
  const identity = readFileSync(new URL("./identity.ts", import.meta.url), "utf8");
  // key creation (newIdentity) and verification of held records (heldIdentity)
  expect(identity.match(/^ {2}await mlDsaRequired\(\);$/gm)).toHaveLength(2);
  // checked before buying a domain or erasing zone holdings
  expect(source.indexOf("if (!config.mindId) await mlDsaRequired();")).toBeLessThan(
    source.indexOf("const zone = await zoneOf("),
  );
  expect(source.indexOf("if (!config.mindId) await mlDsaRequired();")).toBeLessThan(
    source.indexOf("await eraseHoldings("),
  );
});

test("the key's line names the key file only when it is here, and only when this run gave the id, the mind took a record, or the log was empty before", () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), "iterate-key-line-")), "mind.key.json");
  const quiet = { taken: 0, emptyBefore: false };
  // no key file on this computer: no line, whatever the run did
  expect(identityKeyLineOf(keyFile, { gaveTheId: true })).toBeUndefined();
  writeFileSync(keyFile, "{}");
  for (const run of [
    { gaveTheId: true },
    { gaveTheId: false, posted: { ...quiet, taken: 1 } },
    { gaveTheId: false, posted: { ...quiet, emptyBefore: true } },
  ])
    expect(identityKeyLineOf(keyFile, run)).toBe(
      `Its identity key: ${keyFile}  (keep a copy: it proves that the mind is yours)`,
    );
  // a later deploy of a mind whose log has its records, or whose post failed, prints none
  expect(identityKeyLineOf(keyFile, { gaveTheId: false, posted: quiet })).toBeUndefined();
  expect(identityKeyLineOf(keyFile, { gaveTheId: false })).toBeUndefined();
});

test("sign-in never asks for Account API Token Provisioning, stack uses TelemetryToken, and telemetryTokenPage pre-fills the four telemetry permissions", () => {
  expect(STACK_SCOPES).not.toContain("account_api_tokens:create");
  expect(DEPLOY_SCOPES).not.toContain("account_api_tokens:create");
  expect(STACK_SCOPES).not.toContain("workers-r2-bucket-item.write");
  expect(STACK_SCOPES).not.toContain("r2-catalog-sql.read");
  expect(STACK_SCOPES).not.toContain("account-analytics.read");
  // the deploy's sign-in asks for the stack's scopes whole, and no scope twice
  expect(DEPLOY_SCOPES).toEqual(expect.arrayContaining(STACK_SCOPES));
  expect([...new Set(DEPLOY_SCOPES)]).toEqual(DEPLOY_SCOPES);
  // the recovery's sign-in can write to D1, and can deploy and make nothing else
  expect(RECOVER_SCOPES.filter((scope) => !scope.endsWith(".read"))).toEqual(["d1.write"]);

  const script = readFileSync(
    new URL("../../../alchemy/src/stack.ts", import.meta.url).pathname,
    "utf8",
  );
  expect(script).not.toContain("AccountApiToken");
  expect(script).toContain('TelemetryToken("TelemetryToken"');

  const url = telemetryTokenPage("ada-labs-com");
  expect(url).toMatchObject({ origin: "https://dash.cloudflare.com" });
  expect(url.searchParams.get("to")).toBe("/:account/api-tokens");
  expect(url.searchParams.get("name")).toBe("iterate-ada-labs-com-telemetry");
  expect(JSON.parse(url.searchParams.get("permissionGroupKeys") || "")).toEqual(
    TELEMETRY_TOKEN_PERMISSIONS,
  );
  expect(TELEMETRY_TOKEN_ENV).toBe("CLOUDFLARE_TELEMETRY_API_TOKEN");
});

test("what a sign-in did not grant is read from the token answer's scope, and an answer with none granted all", () => {
  expect(scopesLacking(DEPLOY_SCOPES, undefined)).toEqual([]);
  expect(scopesLacking(DEPLOY_SCOPES, DEPLOY_SCOPES.join(" "))).toEqual([]);
  const unticked = DEPLOY_SCOPES.filter((scope) => scope !== "d1.write").join(" ");
  expect(scopesLacking(DEPLOY_SCOPES, unticked)).toEqual(["d1.write"]);
  expect(scopesLacking(["zone.read", "d1.write"], "d1.write offline_access")).toEqual([
    "zone.read",
  ]);
});

test("domainPickerOptions builds one unified list with Buy a brand new domain on top, enter-new option, and Use an existing cloudflare zone below", () => {
  const options = domainPickerOptions({
    offers: [
      { name: "aderate.com", registrable: true, pricing: { registration_cost: "10.44" } },
      { name: "aderate.dev", registrable: true, pricing: { registration_cost: "12.18" } },
    ],
    zones: [
      { id: "z1", name: "existing-free.com", status: "active", uses: [] },
      { id: "z2", name: "existing-mind.dev", status: "active", stageName: "existing", uses: [] },
      { id: "z3", name: "unreadable.com", status: "active", unread: true },
    ],
  });
  expect(options).toEqual([
    { value: "\0heading-buy", label: "Buy a brand new domain", disabled: true },
    { value: "aderate.com", label: "aderate.com", hint: "10.44 USD a year" },
    { value: "aderate.dev", label: "aderate.dev", hint: "12.18 USD a year" },
    {
      value: ENTER_NEW_DOMAIN,
      label: "Enter a brand new domain name and buy that",
      hint: "type a domain to buy, or keywords for more names",
    },
    { value: "\0heading-zones", label: "Use an existing cloudflare zone", disabled: true },
    { value: "existing-free.com", label: "existing-free.com", hint: "in this account, unused" },
    {
      value: "existing-mind.dev",
      label: "existing-mind.dev",
      hint: "a mind is here already: deploy over it",
    },
  ]);

  const noZones = domainPickerOptions({ offers: [], zones: [] });
  expect(noZones.map((option) => [option.label, Boolean(option.disabled)])).toEqual([
    ["Buy a brand new domain", true],
    ["Enter a brand new domain name and buy that", false],
    ["Use an existing cloudflare zone", true],
    ["No existing Cloudflare zones in this account", true],
  ]);
});

test("redactMindConfig and formatMindConfigForStdout print full MindConfig while redacting any sensitive keys", () => {
  const sample = {
    mindId: "a".repeat(64),
    controlPlaneHostname: "iterate.ada-labs.com",
    ownerEmails: ["ada@example.org"],
    topology: "full-cloudflare",
    alchemy: { stageName: "ada-labs-com" },
    cloudflare: { accountId: "0".repeat(32), zones: ["ada-labs.com"] },
    mail: undefined,
    extra: { apiToken: "cf-secret-123", nestedSecret: "shh", publicLabel: "ok" },
  };
  const redacted = redactMindConfig(sample);
  expect(redacted).toEqual({
    mindId: "a".repeat(64),
    controlPlaneHostname: "iterate.ada-labs.com",
    ownerEmails: ["ada@example.org"],
    topology: "full-cloudflare",
    alchemy: { stageName: "ada-labs-com" },
    cloudflare: { accountId: "0".repeat(32), zones: ["ada-labs.com"] },
    extra: { apiToken: "[redacted]", nestedSecret: "[redacted]", publicLabel: "ok" },
  });
  const printed = formatMindConfigForStdout(sample);
  expect(printed).not.toContain("cf-secret-123");
  expect(printed).not.toContain("shh");
  expect(JSON.parse(printed)).toEqual(redacted);
});

test("verifyTelemetryToken accepts active account-owned tokens and rejects user-owned or invalid tokens", async () => {
  const accountId = "0".repeat(32);
  const ok = (result: unknown) => ({ status: 200, result, total: 0, error: "" });
  const unauthorized = { status: 401, result: null, total: 0, error: "Invalid access token" };

  expect(
    await verifyTelemetryToken(accountId, "tok-acct", async (_method, path) =>
      path === `/accounts/${accountId}/tokens/verify` ? ok({ status: "active" }) : unauthorized,
    ),
  ).toEqual({ ok: true });

  const userToken = await verifyTelemetryToken(accountId, "tok-user", async (_method, path) =>
    path === "/user/tokens/verify" ? ok({ status: "active" }) : unauthorized,
  );
  expect(userToken).toMatchObject({ ok: false });
  expect("error" in userToken && userToken.error).toMatch(/user-owned API token/i);

  const invalid = await verifyTelemetryToken(accountId, "tok-bad", async () => unauthorized);
  expect(invalid).toEqual({ ok: false, error: "Invalid access token" });
});

test("CLI color palette respects NO_COLOR/TERM/TTY and styles Cloudflare account names, codes, domains, URLs, and headings", () => {
  expect(isColorEnabled({}, true)).toBe(true);
  expect(isColorEnabled({}, false)).toBe(false);
  expect(isColorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
  expect(isColorEnabled({ TERM: "dumb" }, true)).toBe(false);
  expect(isColorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
  expect(isColorEnabled({ FORCE_COLOR: "0" }, true)).toBe(true);
  expect(isColorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);

  const plain = createPalette(false);
  expect(plain.mark("𝑖")).toBe("𝑖");
  expect(plain.account("Jonas's Account")).toBe("Jonas's Account");
  expect(plain.code("ABCD-EFGH")).toBe("ABCD-EFGH");
  expect(plain.domain("jonaserate.com")).toBe("jonaserate.com");
  expect(plain.url("https://onboarding.jonaserate.com/")).toBe(
    "https://onboarding.jonaserate.com/",
  );

  const colored = createPalette(true);
  expect(colored.mark("𝑖")).toContain("\u001b[");
  expect(colored.account("Jonas's Account")).toContain("\u001b[");
  expect(colored.account("Jonas's Account")).not.toBe(colored.domain("Jonas's Account"));
  expect(colored.code("ABCD-EFGH")).toContain("\u001b[");
  expect(colored.url("https://onboarding.jonaserate.com/")).toContain("\u001b[");

  const styledOptions = domainPickerOptions({ offers: [], zones: [], color: true });
  expect(styledOptions[0]?.label).toContain("Buy a brand new domain");
  expect(styledOptions[0]?.label).toContain("\u001b[");
});

test("pnpmCommandOf uses local pnpm only when major version matches packageManager, else npx --yes", () => {
  expect(pnpmCommandOf("pnpm@12.18.0", "12.18.0\n")).toEqual({ command: "pnpm", first: [] });
  expect(pnpmCommandOf("pnpm@12.18.0", "12.0.1")).toEqual({ command: "pnpm", first: [] });
  expect(pnpmCommandOf("pnpm@12.18.0", "9.15.0")).toEqual({
    command: "npx",
    first: ["--yes", "pnpm@12.18.0"],
  });
  expect(pnpmCommandOf("pnpm@12.18.0", undefined)).toEqual({
    command: "npx",
    first: ["--yes", "pnpm@12.18.0"],
  });
  expect(pnpmCommandOf("pnpm@12.18.0", "")).toEqual({
    command: "npx",
    first: ["--yes", "pnpm@12.18.0"],
  });
  expect(PNPM_COMPAT_ENV).toEqual({
    npm_config_engine_strict: "false",
    npm_config_manage_package_manager_versions: "false",
    COREPACK_ENABLE_STRICT: "0",
  });
});

test("the deploy runs again by itself after the state store's refusal, and after no other failure", () => {
  expect(
    saysTheStateStoreRefused("error: State store request failed (DecodeError, HTTP 404)."),
  ).toBe(true);
  expect(saysTheStateStoreRefused("StateStoreError: the store did not answer")).toBe(true);
  expect(saysTheStateStoreRefused("error: Authentication error (code 10000)")).toBe(false);
  expect(saysTheStateStoreRefused("[15:25:30.212] INFO: Computing plan")).toBe(false);
});

test("deploy has no OAuth-client token prompt or Account API Token Provisioning, isolates token env vars, prints MindConfig, respects CI=1, waits for Enter before opening browser, and ends at onboarding.<zone>", () => {
  expect(onboardingUrlOf("ada-labs.com")).toBe("https://onboarding.ada-labs.com/");
  expect(isInteractiveEnv({}, true)).toBe(true);
  expect(isInteractiveEnv({ CI: "1" }, true)).toBe(false);
  expect(isInteractiveEnv({ CI: "true" }, true)).toBe(false);
  expect(isInteractiveEnv({ CI: "0" }, true)).toBe(true);
  expect(isInteractiveEnv({ CI: "false" }, true)).toBe(true);
  expect(isInteractiveEnv({}, false)).toBe(false);
  const source = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8");
  expect(source).not.toContain("apiTokenPage");
  expect(source).not.toContain("oauthClientStep");
  expect(source).not.toContain("Account API Token Provisioning");
  expect(source).not.toContain("MAKES_API_TOKENS");
  expect(source).toContain("CLOUDFLARE_OAUTH_CLIENT_API_TOKEN: _droppedOAuthToken");
  expect(source).toContain("CLOUDFLARE_TELEMETRY_API_TOKEN: _droppedTelemetryToken");
  expect(source).toContain(
    "await telemetryTokenStep(cf, account, stageName, { plan: input.plan })",
  );
  expect(source).toContain(
    'p.log.info(`${c.callout("MindConfig:")}\\n${formatMindConfigForStdout(deployedConfig)}`)',
  );
  // iconic 𝑖 is printed on its own very first line before p.intro
  expect(source).toContain('console.log(c.mark("𝑖"));');
  expect(source.indexOf('console.log(c.mark("𝑖"));')).toBeLessThan(source.indexOf("p.intro("));
  // sourceOf pre-builds core-mind-worker in the background; deployArgsOf/planArgsOf skip rebuilding
  expect(source).toContain('"--filter", "core-mind-worker", "build"');
  expect(planArgsOf("ada-labs-com")).toEqual([
    ["exec", "alchemy", "plan", "alchemy.run.ts", "--stage", "ada-labs-com", "--no-input"],
  ]);
  expect(source).toContain("Press Enter to open in browser...");
  expect(source.indexOf("Press Enter to open in browser...")).toBeLessThan(
    source.indexOf("openPageCommand(new URL(url)"),
  );
  // telemetry token is collected before buying a domain or erasing zone holdings
  expect(source.indexOf("await telemetryTokenStep(")).toBeLessThan(
    source.indexOf("const zone = await zoneOf("),
  );
  expect(source.indexOf("await telemetryTokenStep(")).toBeLessThan(
    source.indexOf("await eraseHoldings("),
  );
});

test("Zero Trust: an organization goes on; none, or Access not enabled, is set up once, then a gate; any other refusal stops", () => {
  const account = "0".repeat(32);
  const answer = (status: number, result: unknown, error = "") => ({
    status,
    result,
    total: 0,
    error,
  });
  const there = answer(200, { auth_domain: "frosty-moon-7a3b.cloudflareaccess.com" });
  const none = answer(404, null, "access.api.error.not_found (code 12130)");
  const noDomain = answer(200, { auth_domain: "" });
  const notEnabled = answer(
    403,
    null,
    "access.api.error.not_enabled: Access is not enabled. Visit the Access dashboard at https://dash.cloudflare.com/ and click the 'Enable Access' button. (code 9999)",
  );
  const noPermission = answer(403, null, "Authentication error (code 10000)");

  for (const tried of [false, true])
    expect(zeroTrustStep(account, there, tried)).toEqual({ next: "go" });
  // the read: the command tries the script's own set-up first
  for (const read of [none, noDomain, notEnabled])
    expect(zeroTrustStep(account, read, false)).toEqual({ next: "make" });
  // the set-up refused for Access or a plan, or with no organization after it: the gate
  for (const after of [
    none,
    noDomain,
    notEnabled,
    answer(403, null, "a plan is required (code 9999)"),
  ])
    expect(zeroTrustStep(account, after, true)).toEqual({
      next: "gate",
      page: `https://one.dash.cloudflare.com/${account}/`,
      words:
        "Turn on Zero Trust: an owner of the mind proves their email address through Cloudflare Access, which is part of it.\nOn this page choose a team name and the Free plan. Cloudflare may ask for a payment method, and the Free plan charges nothing.",
    });
  // a permission is no gate: Cloudflare's words, and the permission that a pasted token needs
  expect(zeroTrustStep(account, noPermission, false)).toEqual({
    next: "stop",
    words:
      'Cloudflare refused to read the account\'s Zero Trust organization (403: Authentication error (code 10000)). The access needs "Access: Organizations, Identity Providers, and Groups Write". Nothing is deployed.',
  });
  expect(zeroTrustStep(account, noPermission, true)).toMatchObject({
    next: "stop",
    words: expect.stringMatching(/^Cloudflare refused to set up the account's Zero Trust/),
  });
});

test("a deploy over a mind keeps every field of the config that the mind was deployed with, and changes only what a flag names", () => {
  const accountId = "0".repeat(32);
  const whole = ScriptConfig.parse({
    mindId: "cd".repeat(32),
    controlPlaneHostname: "iterate.ada-labs.com",
    ownerEmails: ["ada@example.org"],
    topology: "full-cloudflare",
    alchemy: { stageName: "ada-labs-com" },
    cloudflare: {
      accountId,
      zones: ["ada-labs.com"],
      containerImage: `registry.cloudflare.com/${accountId}/iterate-sandbox@sha256:${"ab".repeat(32)}`,
    },
    mail: { forwardTo: "team@group.example" },
  });
  // every field of the script's config, nested ones too, is in this one: a new field fails here
  type Shape = Record<string, object>;
  const pathsOf = (shape: Shape, at = ""): string[] =>
    Object.entries(shape).flatMap(([key, field]) => {
      const inner = "unwrap" in field ? (field as { unwrap: () => object }).unwrap() : field;
      return "shape" in inner ? pathsOf(inner.shape as Shape, `${at}${key}.`) : [`${at}${key}`];
    });
  const valuePaths = (value: object, at = ""): string[] =>
    Object.entries(value).flatMap(([key, field]) =>
      field && typeof field === "object" && !Array.isArray(field)
        ? valuePaths(field, `${at}${key}.`)
        : [`${at}${key}`],
    );
  expect(valuePaths(whole).sort()).toEqual(pathsOf(ScriptConfig.shape).sort());

  // the boundary's settings as the stack writes them (core/alchemy/src/stack.ts)
  const script = readFileSync(
    new URL("../../../alchemy/src/stack.ts", import.meta.url).pathname,
    "utf8",
  );
  expect(script).toContain("DEPLOY_CONFIG: JSON.stringify(config),");
  const settingsOf = (config: typeof whole & Record<string, unknown>) => ({
    bindings: [
      {
        type: "plain_text",
        name: "ITERATE",
        text: JSON.stringify({
          mindId: config.mindId,
          controlPlaneHostname: config.controlPlaneHostname,
          zones: config.cloudflare.zones,
          ownerEmails: config.ownerEmails,
          topology: config.topology,
        }),
      },
      { type: "plain_text", name: "DEPLOY_CONFIG", text: JSON.stringify(config) },
    ],
  });
  const overMind = (config: typeof whole & Record<string, unknown>, flags = {}) => {
    const read = mindConfigIn(settingsOf(config));
    if (!read) throw new Error("no config read");
    return deployConfigOf({
      accountId,
      domain: "ada-labs.com",
      deployed: { ...read, stageName: config.alchemy.stageName },
      ...flags,
    });
  };
  expect(overMind(whole)).toEqual(whole);
  expect(ScriptConfig.parse(overMind(whole))).toEqual(whole);
  // a field that this command does not know survives too
  const later = { ...whole, later: true, cloudflare: { ...whole.cloudflare, later: 1 } };
  expect(overMind(later)).toEqual(later);
  // a flag changes what it names, and nothing else
  expect(overMind(whole, { owner: "grace@example.org" })).toEqual({
    ...whole,
    ownerEmails: ["grace@example.org"],
  });
  expect(overMind(whole, { mailForwardTo: "other@group.example" })).toEqual({
    ...whole,
    mail: { forwardTo: "other@group.example" },
  });
  const { mail: _, ...withoutMail } = whole;
  expect(JSON.parse(JSON.stringify(overMind(whole, { mailForwardTo: "none" })))).toEqual(
    withoutMail,
  );
  expect(() => overMind(whole, { mailForwardTo: "team@ada-labs.com" })).toThrow(
    /domain of the mind/,
  );
  // a mind deployed before the stack kept its whole config is read, with no deploy config: the
  // command then deploys nothing over it (deployMind)
  expect(
    mindConfigIn({ bindings: settingsOf(whole).bindings.slice(0, 1) })?.deployConfig,
  ).toBeUndefined();
});

test("a mind of the earlier stack is named as such, and no path of the command deploys over it or erases its domain", async () => {
  // the earlier stack's boundary: bindings, and no variable ITERATE
  const asked: string[] = [];
  const cf = (async (method: string, path: string) => {
    asked.push(`${method} ${path}`);
    return {
      status: 200,
      result: {
        bindings: [
          { type: "service", name: "AUTH", service: "iterate-ada-labs-com-auth" },
          { type: "send_email", name: "SEND_EMAIL" },
        ],
      },
      total: 0,
      error: "",
    };
  }) as Parameters<typeof deployedMind>[0];
  await expect(deployedMind(cf, "account", "ada-labs-com")).rejects.toThrow(
    "The mind whose boundary Worker is iterate-ada-labs-com-boundary runs iterate's earlier stack, and this command works on a mind of the new stack alone. It does not move a mind from the earlier stack yet: iterate moves it. Nothing was changed.",
  );
  expect(asked).toEqual([
    "GET /accounts/account/workers/scripts/iterate-ada-labs-com-boundary/settings",
  ]);
  // In the command, the read of a mind comes before the question that erases a domain's records,
  // before the erase and before the deploy, whatever the flags: its error ends the run there. A
  // mind with no deploy config stops there too. A domain that comes during the run with a
  // boundary's route stops before the erase.
  const command = readFileSync(new URL("./deploy.ts", import.meta.url).pathname, "utf8");
  const at = (text: string) => {
    const index = command.indexOf(text);
    expect(index, text).toBeGreaterThan(0);
    return index;
  };
  const read = at("const deployed = await deployedMind(cf, account.id, stageName);");
  const noDeployConfig = at("if (deployed && !deployed.deployConfig)");
  const ask = at("let holdings = pick.zone\n      ? await holdingsToErase(");
  const arrivedMind = at("if (arrived.stageName)");
  const arrivedErase = at("holdings = await holdingsToErase(arrived.uses");
  expect(read).toBeLessThan(noDeployConfig);
  expect(noDeployConfig).toBeLessThan(ask);
  expect(arrivedMind).toBeLessThan(arrivedErase);
  expect(arrivedErase).toBeLessThan(at("await eraseHoldings(cf, zone.id)"));
  expect(at("await eraseHoldings(cf, zone.id)")).toBeLessThan(at("await deployStack({"));
});

const store = "/workers/scripts/iterate-ada-labs-com-state/settings";
const begun = {
  mindId: "cd".repeat(32),
  controlPlaneHostname: "iterate.ada-labs.com",
  ownerEmails: ["ada@example.org"],
  topology: "full-cloudflare",
  alchemy: { stageName: "ada-labs-com" },
  cloudflare: { accountId: "0".repeat(32), zones: ["ada-labs.com"] },
};
type Cf = Parameters<typeof earlierDeployOf>[0];
const unused = { domain: "ada-labs.com", uses: [] };

test("an account with no state store of the stage has no earlier deploy: the run is a new mind's", async () => {
  const asked: string[] = [];
  expect(
    await earlierDeployOf(
      accountWith({}, asked) as Cf,
      "account",
      "ada-labs-com",
      unused,
      configFileOf(begun),
    ),
  ).toBeUndefined();
  // the store and the stack's other Workers; the boundary was read before (deployedMind)
  expect(asked).toEqual(
    ["state", "telemetry", "auth", "secrets", "mind"].map(
      (part) => `GET /accounts/account/workers/scripts/iterate-ada-labs-com-${part}/settings`,
    ),
  );
});

test("the store with this stage's config on this computer goes on with that config: the same id, owners and hostname, a flag replaces one, and the deploy adopts", async () => {
  const accountId = "0".repeat(32);
  const file = configFileOf({ ...begun, cloudflare: { ...begun.cloudflare, containerImage: "x" } });
  // a half-made stack, or one destroyed here and deployed again: the config decides
  const stacks: Record<string, number>[] = [
    { [store]: 200, "-auth/settings": 200 },
    { [store]: 200 },
  ];
  for (const found of stacks) {
    const earlier = await earlierDeployOf(
      accountWith(found) as Cf,
      accountId,
      "ada-labs-com",
      { domain: "ada-labs.com", uses: ["the MX record ada-labs.com"] },
      file,
    );
    expect(earlier?.mind).toMatchObject({ mindId: "cd".repeat(32), stageName: "ada-labs-com" });
  }
  const { mind } =
    (await earlierDeployOf(
      accountWith({ [store]: 200 }) as Cf,
      accountId,
      "ada-labs-com",
      unused,
      file,
    )) || {};
  // what deployMind writes from it: the whole config again, so the rerun plans no other mind
  expect(deployConfigOf({ accountId, domain: "ada-labs.com", deployed: mind })).toEqual({
    ...begun,
    cloudflare: { ...begun.cloudflare, containerImage: "x" },
  });
  expect(
    deployConfigOf({
      accountId,
      domain: "ada-labs.com",
      owner: "grace@example.org",
      deployed: mind,
    }),
  ).toMatchObject({ mindId: "cd".repeat(32), ownerEmails: ["grace@example.org"] });
  // its deploy adopts what an earlier one made and its state does not hold, and so does a new mind
  // beside a leftover store (a stack that stopped before its first Worker reads the same); no other
  expect(deployArgsOf("ada-labs-com", true)).toEqual([
    "exec",
    "alchemy",
    "deploy",
    "alchemy.run.ts",
    "--stage",
    "ada-labs-com",
    "--yes",
    "--adopt",
  ]);
  expect(deployArgsOf("ada-labs-com")).not.toContain("--adopt");
  const command = readFileSync(new URL("./deploy.ts", import.meta.url).pathname, "utf8");
  expect(command.match(/adopt: .*/g)).toEqual(["adopt: Boolean(earlier),"]);
  expect(command).toContain(
    'This computer holds the config of an earlier deploy of this mind (${configFile.replace(homedir(), "~")}), and the account holds its stack\'s state store: going on with that config. Its owners: ',
  );
});

test("the store alone, with no config here, on a zone that is not in use, is a destroy's leftover: a new mind, with a new identity", async () => {
  const earlier = await earlierDeployOf(
    accountWith({ [store]: 200 }) as Cf,
    "0".repeat(32),
    "ada-labs-com",
    unused,
    configFileOf(),
  );
  expect(earlier).toEqual({ leftover: "iterate-ada-labs-com-state" });
  // a new mind: no config of the earlier one, and an identity made now, never the one this
  // computer may hold for the same hostname
  const command = readFileSync(new URL("./deploy.ts", import.meta.url).pathname, "utf8");
  expect(command).toContain("const unfinished = earlier?.mind;");
  expect(command).toContain(
    "(await identityOfNewMind(controlPlaneHostname, Boolean(earlier?.leftover)))",
  );
  expect(command).toContain(
    "const earlier = fresh ? undefined : await identityMadeFor(controlPlaneHostname, IDENTITIES);",
  );
  expect(command).toContain(
    "the state store that a destroy of a mind at ${domain} leaves, and nothing else of that mind: deploying a new mind there, with a new identity.",
  );
});

test("the store with more of the stack and no config here stops the run with the two ways on, whatever the flags", async () => {
  const accountId = "0".repeat(32);
  const words =
    /^The account holds the state store of a mind's stack at ada-labs\.com, the Worker iterate-ada-labs-com-state, and more of that stack \(([^)]+)\), and no mind answers there yet: a deploy of it stopped before its end\.[^]*Nothing was changed\. Two ways on:\n- Run the command on the computer that began the deploy: it goes on with it\.\n- Or erase the half-made stack: `pnpm run destroy --stage ada-labs-com --yes` in core\/alchemy with a config of that stage and account \(iterate deploy's README, "Erase a mind"\)\. The command then deploys a new mind there\. --erase-records erases no record of a half-made stack\.$/;
  const stop = (found: Record<string, number>, uses: string[], file: string) =>
    earlierDeployOf(
      accountWith(found) as Cf,
      accountId,
      "ada-labs-com",
      { domain: "ada-labs.com", uses },
      file,
    );
  // a Worker of the stack; the zone in use; and either with a config of another account, of
  // another domain, or with no mind id
  await expect(
    stop({ [store]: 200, "-telemetry/settings": 200 }, [], configFileOf()),
  ).rejects.toThrow(words);
  await expect(
    stop({ [store]: 200 }, ["the MX record ada-labs.com"], configFileOf()),
  ).rejects.toThrow(/more of that stack \(the MX record ada-labs\.com\)/);
  for (const config of [
    { ...begun, cloudflare: { ...begun.cloudflare, accountId: "1".repeat(32) } },
    { ...begun, cloudflare: { ...begun.cloudflare, zones: ["ada.example"] } },
    { ...begun, mindId: undefined },
  ])
    await expect(
      stop({ [store]: 200, "-mind/settings": 200 }, [], configFileOf(config)),
    ).rejects.toThrow(/more of that stack \(iterate-ada-labs-com-mind\)/);
  // the command reads this before the zone's question, which then asks nothing and erases nothing
  const command = readFileSync(new URL("./deploy.ts", import.meta.url).pathname, "utf8");
  expect(command.indexOf("await earlierDeployOf(")).toBeGreaterThan(0);
  expect(command.indexOf("await earlierDeployOf(")).toBeLessThan(
    command.indexOf("let holdings = pick.zone\n      ? await holdingsToErase("),
  );
  expect(command).toContain("if (mind || uses.length === 0) return undefined;");
  // a read that Cloudflare refuses says so, and decides nothing
  await expect(stop({ "-auth/settings": 500 }, [], configFileOf(begun))).rejects.toThrow(
    "Cloudflare did not answer whether the account holds the Worker iterate-ada-labs-com-auth (500: refused). Nothing was changed. Run the command again.",
  );
});

test("a deploy that failed says that a run on this computer goes on with it", () => {
  const command = readFileSync(new URL("./deploy.ts", import.meta.url).pathname, "utf8");
  // the config file that the read takes is the one that the deploy writes
  expect(command.match(/join\(work, "config\.json"\)/g)).toHaveLength(1);
  expect(command).toContain(
    "A deploy keeps what it made: run the command again on this computer, and it goes on with this deploy's config.",
  );
});

test("after a deploy the boundary holds the whole config, and the mail forward exactly when the config names one", () => {
  const deployed = { ...deployConfigOf(answers), mail: { forwardTo: "team@group.example" } };
  const settings = (config: object, forwardTo?: string) => ({
    bindings: [
      { type: "plain_text", name: "DEPLOY_CONFIG", text: JSON.stringify(config) },
      ...(forwardTo ? [{ type: "plain_text", name: "MAIL_FORWARD_TO", text: forwardTo }] : []),
    ],
  });
  expect(boundaryMisses(settings(deployed, "team@group.example"), deployed)).toBeNull();
  // the config it holds differs, or is none
  expect(boundaryMisses(settings({ ...deployed, mail: undefined }), deployed)).toMatch(
    /DEPLOY_CONFIG is not the config/,
  );
  expect(boundaryMisses({ bindings: [] }, deployed)).toMatch(/DEPLOY_CONFIG is not the config/);
  // the forward is missing, or left over
  expect(boundaryMisses(settings(deployed), deployed)).toMatch(/forwards none/);
  const { mail: _, ...withoutMail } = deployed;
  expect(boundaryMisses(settings(withoutMail, "team@group.example"), withoutMail)).toMatch(
    /does not name/,
  );
  expect(boundaryMisses(settings(withoutMail), withoutMail)).toBeNull();
});

test("the check after a deploy reads again before it calls a miss, and a read that never answers is no miss", async () => {
  const deployed = { ...deployConfigOf(answers), mail: { forwardTo: "team@group.example" } };
  const held = {
    status: 200,
    result: {
      bindings: [
        { type: "plain_text", name: "DEPLOY_CONFIG", text: JSON.stringify(deployed) },
        { type: "plain_text", name: "MAIL_FORWARD_TO", text: "team@group.example" },
      ],
    },
  };
  const stale = { status: 200, result: { bindings: held.result.bindings.slice(0, 1) } };
  const check = async (...reads: { status: number; result?: unknown }[]) => {
    let pauses = 0;
    const outcome = await boundaryCheck(
      async () => reads.shift() ?? { status: 0 },
      deployed,
      async () => pauses++,
    );
    return { outcome, pauses };
  };
  // 200 at once
  expect(await check(held)).toEqual({ outcome: { held: true }, pauses: 0 });
  // a 429, then a 200
  expect(await check({ status: 429 }, held)).toEqual({ outcome: { held: true }, pauses: 1 });
  // a read that is not fresh yet, then one that holds all
  expect(await check(stale, held)).toEqual({ outcome: { held: true }, pauses: 1 });
  // five reads that each miss the forward
  expect(await check(stale, stale, stale, stale, stale)).toMatchObject({
    outcome: { miss: expect.stringMatching(/forwards none/) },
    pauses: 4,
  });
  // five reads that never answer 200: no miss, the last status
  expect(
    await check(
      { status: 500 },
      { status: 429 },
      { status: 500 },
      { status: 503 },
      { status: 502 },
    ),
  ).toEqual({ outcome: { unread: 502 }, pauses: 4 });
});

test("a product is on at 200 and off at Cloudflare's refusal; a read that failed is read again, and three are a stop, never 'off'", async () => {
  const reads = (...statuses: number[]) => {
    const asked: number[] = [];
    return {
      asked,
      read: async () => {
        const status = statuses[asked.length] ?? 200;
        asked.push(status);
        return { status, error: status === 403 ? "Please enable R2 (code 10042)" : "busy" };
      },
    };
  };
  const pause = async () => undefined;

  const on = reads(200);
  expect(await productRead("R2", on.read, pause)).toEqual({ on: true });
  expect(on).toMatchObject({ asked: [200] });

  const off = reads(403);
  expect(await productRead("R2", off.read, pause)).toEqual({
    on: false,
    why: "403: Please enable R2 (code 10042)",
  });
  expect(off).toMatchObject({ asked: [403] });

  const late = reads(429, 503, 200);
  expect(await productRead("R2", late.read, pause)).toEqual({ on: true });
  expect(late).toMatchObject({ asked: [429, 503, 200] });

  const never = reads(500, 502, 429, 403);
  await expect(productRead("R2", never.read, pause)).rejects.toThrow(
    "Cloudflare did not answer whether R2 is on (429: busy), three times. A read that failed says nothing about the account. Nothing was changed. Run the command again.",
  );
  expect(never).toMatchObject({ asked: [500, 502, 429] });
});

test("the flag's forward is one plain address, or none; an empty one is refused, not read as no flag", () => {
  expect(() => deployConfigOf({ ...answers, mailForwardTo: "" })).toThrow(
    /give an address, or none/,
  );
  // only `none` in lower case removes it: `None` is no address
  expect(() => deployConfigOf({ ...answers, mailForwardTo: "None" })).toThrow(/no email address/);
  expect(() => deployConfigOf({ ...answers, mailForwardTo: "Team <team@group.example>" })).toThrow(
    /no email address/,
  );
});

/** An account's answer for the settings of the Worker at each path in `found`, a 404 elsewhere. */
const accountWith =
  (found: Record<string, number>, asked: string[] = []) =>
  async (method: string, path: string) => {
    asked.push(`${method} ${path}`);
    const status = Object.entries(found).find(([end]) => path.endsWith(end))?.[1] ?? 404;
    return { status, result: { bindings: [] }, total: 0, error: status === 200 ? "" : "refused" };
  };

const configFileOf = (config?: object) => {
  const file = join(mkdtempSync(join(tmpdir(), "deploy-")), "config.json");
  if (config) writeFileSync(file, JSON.stringify(config));
  return file;
};
