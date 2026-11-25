import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MindConfig as ScriptConfig } from "../../../alchemy/src/config.ts";
import { DEPLOY_SCOPES, RECOVER_SCOPES, scopesLacking, STACK_SCOPES } from "./cloudflare-access.ts";
import {
  alternativesOf,
  assertSupportedNodeVersion,
  boundaryCheck,
  boundaryRead,
  BOUNDARY_WAIT_MS,
  boundaryMisses,
  candidatesOf,
  createDeployProgress,
  createPalette,
  deployArgsOf,
  deployStack,
  deployConfigOf,
  patternsRefusalOf,
  deployedMind,
  domainPickerOptions,
  earlierDeployOf,
  ENTER_NEW_DOMAIN,
  erateOf,
  FIRST_PAGES_WAIT_MS,
  firstPagesAnswer,
  firstPagesOf,
  formatMindConfigForStdout,
  identityKeyLineOf,
  isColorEnabled,
  isInteractiveEnv,
  mindConfigIn,
  onboardingUrlOf,
  parseExtraOwnerEmails,
  pickDomain,
  planArgsOf,
  setupDestinationOf,
  signInPageOf,
  PNPM_COMPAT_ENV,
  pnpmCommandOf,
  pnpmEnvFor,
  productRead,
  redactMindConfig,
  ONE_MORE_TRY,
  saysTheConsumerIsNotSeenYet,
  saysTheStateStoreRefused,
  seedReposEnvOf,
  stateStoreAddress,
  STORE_WAIT_MS,
  waitForStore,
  WAITING_FOR_STORE,
  WAITING_FOR_BOUNDARY,
  stageNameOf,
  unfinishedDeployIn,
  workersPaidPrompt,
  zeroTrustStep,
  zoneOf,
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

test("the owner email patterns are what --owner-email-patterns says, else what the mind has; none takes them away", () => {
  const { accountId } = answers;
  expect(deployConfigOf(answers)).not.toHaveProperty("ownerEmailPatterns");
  // the MCP target: a method's name as the flag gives it, kept by a later deploy, and `none`
  expect(deployConfigOf(answers)).not.toHaveProperty("mcpTarget");
  expect(deployConfigOf({ ...answers, mcpTarget: "mcp" })).toMatchObject({ mcpTarget: "mcp" });
  expect(
    JSON.parse(JSON.stringify(deployConfigOf({ ...answers, mcpTarget: "none" }))),
  ).not.toHaveProperty("mcpTarget");
  for (const refused of ["", "a.b", "1mcp", "mcp()"])
    expect(() => deployConfigOf({ ...answers, mcpTarget: refused }), refused).toThrow(
      "--mcp-target",
    );
  expect(
    deployConfigOf({ ...answers, ownerEmailPatterns: "*@company.example, *@second.example" }),
  ).toMatchObject({ ownerEmailPatterns: ["*@company.example", "*@second.example"] });
  // as the config is written to its file and to the boundary: JSON
  expect(
    JSON.parse(JSON.stringify(deployConfigOf({ ...answers, ownerEmailPatterns: "none" }))),
  ).not.toHaveProperty("ownerEmailPatterns");
  // a mind that has patterns keeps them with no flag, and loses them by `none` alone
  const withPatterns = {
    ...deployed,
    deployConfig: {
      alchemy: { stageName: "ada" },
      cloudflare: { accountId, zones: deployed.zones },
      ownerEmailPatterns: ["*@company.example"],
    },
  };
  const over = (ownerEmailPatterns?: string) =>
    deployConfigOf({ accountId, domain: "ada.example", deployed: withPatterns, ownerEmailPatterns })
      .ownerEmailPatterns;
  expect(over()).toEqual(["*@company.example"]);
  expect(over("*@second.example")).toEqual(["*@second.example"]);
  expect(over("none")).toBe(undefined);
  for (const refused of [
    "",
    "company.example",
    "*@*",
    "*@Company.example",
    "ada@company.example",
    "*@company.example,",
    // the mind's own zone, and a name under it
    "*@ada-labs.com",
    "*@mail.ada-labs.com",
  ])
    expect(() => deployConfigOf({ ...answers, ownerEmailPatterns: refused }), refused).toThrow(
      /owner.email.pattern/i,
    );
});

test("a source from before the owner email patterns is refused for a config that has some, and for no other", () => {
  const before = "export const MindConfig = z.strictObject({ ownerEmails: z.array(z.email()) })";
  const now = `${before} // ownerEmailPatterns`;
  const withPatterns = deployConfigOf({ ...answers, ownerEmailPatterns: "*@company.example" });
  expect(patternsRefusalOf(before, withPatterns)).toMatch(
    /owner email patterns \(\*@company\.example\).*was not deployed.*--owner-email-patterns none/,
  );
  expect([
    patternsRefusalOf(now, withPatterns),
    patternsRefusalOf(before, deployConfigOf(answers)),
    patternsRefusalOf(before, deployConfigOf({ ...answers, ownerEmailPatterns: "none" })),
  ]).toEqual([null, null, null]);
});

test("the trace sampling is what --trace-sampling says, else what the mind has; default keeps every trace", () => {
  const { accountId } = answers;
  const over = (traceSampling?: string, telemetry?: { traceSampling: number }) =>
    deployConfigOf({
      accountId,
      domain: "ada.example",
      traceSampling,
      deployed: {
        ...deployed,
        deployConfig: {
          alchemy: { stageName: "ada" },
          cloudflare: { accountId, zones: deployed.zones },
          telemetry,
        },
      },
    }).telemetry;
  // a new mind, and a mind with no setting: no setting, so every trace (core/alchemy config.ts)
  expect(deployConfigOf(answers)).not.toHaveProperty("telemetry");
  expect(over()).toBeUndefined();
  expect(over("0.1")).toEqual({ traceSampling: 0.1 });
  expect(over("0")).toEqual({ traceSampling: 0 });
  // no flag keeps the mind's own; a flag replaces it; default removes it
  expect(over(undefined, { traceSampling: 0.25 })).toEqual({ traceSampling: 0.25 });
  expect(over("1", { traceSampling: 0.25 })).toEqual({ traceSampling: 1 });
  expect(over("default", { traceSampling: 0.25 })).toBeUndefined();
  for (const wrong of ["", " ", "1.5", "-0.1", "all", "1/10"])
    expect(() => over(wrong), wrong).toThrow(/--trace-sampling .* is no share/);
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
      `Its identity key: ${keyFile}  (not used right now — don't worry about it or if you lose it)`,
    );
  // a later deploy of a mind whose log has its records, or whose post failed, prints none
  expect(identityKeyLineOf(keyFile, { gaveTheId: false, posted: quiet })).toBeUndefined();
  expect(identityKeyLineOf(keyFile, { gaveTheId: false })).toBeUndefined();
});

test("sign-in never asks for Account API Token Provisioning, and the stack makes a telemetry token only in minted mode", () => {
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
  // AccountApiToken is declared only in minted mode; given mode uses TelemetryToken
  expect(script).toContain('if (telemetryMode === "minted")');
  expect(script).toContain('TelemetryToken("TelemetryToken"');
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

test("alternativesOf builds stem variations via candidatesOf without the taken domain itself", () => {
  const acme = alternativesOf("acme.com");
  expect(acme).not.toContain("acme.com");
  expect(acme.slice(0, 8)).toEqual([
    "acme.dev",
    "acme.net",
    "acme.xyz",
    "acmerate.com",
    "acmerate.dev",
    "acmes.com",
    "heyacme.com",
    "acmehq.com",
  ]);
  expect(acme.length).toBeLessThanOrEqual(20);

  const hyphenated = alternativesOf("Ada-Labs.com");
  expect(hyphenated).not.toContain("ada-labs.com");
  expect(hyphenated.slice(0, 5)).toEqual([
    "ada-labs.dev",
    "ada-labs.net",
    "ada-labs.xyz",
    "aderate.com",
    "labserate.com",
  ]);
  expect(hyphenated).toContain("adalabs.com");
  expect(hyphenated).toHaveLength(19);
});

test("pickDomain checks stem alternatives and shows them in the picker when a typed domain is taken and not theirs", async () => {
  const checked: string[][] = [];
  const cf = (async (method: string, path: string, body?: unknown) => {
    if (method === "POST" && path.endsWith("/registrar/domain-check")) {
      const domains = (body as { domains: string[] }).domains;
      checked.push(domains);
      if (domains.includes("acme.com")) {
        return {
          status: 200,
          result: { domains: [{ name: "acme.com", registrable: false }] },
          total: 1,
          error: "",
        };
      }
      if (domains.includes("acme.dev")) {
        return {
          status: 200,
          result: {
            domains: [
              { name: "acme.dev", registrable: true, pricing: { registration_cost: "12.18" } },
              { name: "acmerate.com", registrable: true, pricing: { registration_cost: "10.44" } },
              { name: "acmes.com", registrable: false },
            ],
          },
          total: 3,
          error: "",
        };
      }
      return {
        status: 200,
        result: {
          domains: [
            { name: "aderate.com", registrable: true, pricing: { registration_cost: "10.44" } },
          ],
        },
        total: 1,
        error: "",
      };
    }
    return { status: 200, result: [], total: 0, error: "" };
  }) as Parameters<typeof pickDomain>[0];

  const seenSelects: { message: string; values: string[] }[] = [];
  const selectAnswers = [ENTER_NEW_DOMAIN, "acme.dev"];
  const confirmAnswers = [false, true];
  const warnings: string[] = [];

  const picked = await pickDomain(cf, "acct-1", {}, [], "Ada Lovelace", {
    select: async ({ message, options }) => {
      seenSelects.push({ message, values: options.map((option) => option.value) });
      return selectAnswers.shift()!;
    },
    text: async () => "acme.com",
    confirm: async () => confirmAnswers.shift()!,
    warn: (message) => warnings.push(message),
  });

  expect(picked).toEqual({
    domain: "acme.dev",
    offer: { name: "acme.dev", registrable: true, pricing: { registration_cost: "12.18" } },
  });
  expect(warnings).toEqual([]);
  expect(checked).toEqual([candidatesOf("Ada Lovelace"), ["acme.com"], alternativesOf("acme.com")]);
  expect(seenSelects[0]?.message).toContain(
    "It takes the whole domain, so the mind can be its site, mail and apps.",
  );
  // the alternatives from the taken domain appear before the earlier offers on the second prompt
  expect(seenSelects[1]?.values.slice(0, 4)).toEqual([
    "\0heading-buy",
    "acme.dev",
    "acmerate.com",
    "aderate.com",
  ]);
});

test("pickDomain skips alternative checks when a taken domain is theirs at another registrar", async () => {
  const checked: string[][] = [];
  const cf = (async (method: string, path: string, body?: unknown) => {
    if (method === "POST" && path.endsWith("/registrar/domain-check")) {
      const domains = (body as { domains: string[] }).domains;
      checked.push(domains);
      return {
        status: 200,
        result: { domains: domains.map((name) => ({ name, registrable: false })) },
        total: domains.length,
        error: "",
      };
    }
    return { status: 200, result: [], total: 0, error: "" };
  }) as Parameters<typeof pickDomain>[0];

  const picked = await pickDomain(cf, "acct-1", {}, [], "Ada", {
    select: async () => ENTER_NEW_DOMAIN,
    text: async () => "acme.com",
    confirm: async () => true,
  });

  expect(picked).toEqual({ domain: "acme.com" });
  expect(checked).toEqual([candidatesOf("Ada"), ["acme.com"]]);
});

test("zoneOf prints nameservers and the DNSSEC reminder once while waiting for a pending outside zone", async () => {
  const pause = async () => undefined;
  const makeZoneCf = (
    polls: { id: string; name: string; status: string; name_servers?: string[] }[],
  ) =>
    (async (_method: string, _path: string) => ({
      status: 200,
      result: polls.shift() ?? { id: "z1", name: "example.org", status: "active" },
      total: 1,
      error: "",
    })) as Parameters<typeof zoneOf>[0];

  // name_servers present on the pending zone from the start: printed once across multiple polls
  const saidFromZone: string[] = [];
  const activeFromZone = await zoneOf(
    makeZoneCf([
      {
        id: "z1",
        name: "example.org",
        status: "pending",
        name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      },
      { id: "z1", name: "example.org", status: "active" },
    ]),
    "acct-1",
    {
      domain: "example.org",
      zone: {
        id: "z1",
        name: "example.org",
        status: "pending",
        name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      },
    },
    { say: (line) => saidFromZone.push(line), pause },
  );
  expect(activeFromZone).toMatchObject({ status: "active" });
  expect(saidFromZone).toEqual([
    "Set example.org's nameservers at your registrar to:\n  ada.ns.cloudflare.com\n  bob.ns.cloudflare.com\nTurn DNSSEC off at your current registrar before changing nameservers.",
  ]);

  // name_servers returned only on GET /zones/<id>: still printed once, not on every poll
  const saidFromPoll: string[] = [];
  await zoneOf(
    makeZoneCf([
      {
        id: "z1",
        name: "example.org",
        status: "pending",
        name_servers: ["carol.ns.cloudflare.com", "dave.ns.cloudflare.com"],
      },
      {
        id: "z1",
        name: "example.org",
        status: "pending",
        name_servers: ["carol.ns.cloudflare.com", "dave.ns.cloudflare.com"],
      },
      { id: "z1", name: "example.org", status: "active" },
    ]),
    "acct-1",
    { domain: "example.org", zone: { id: "z1", name: "example.org", status: "pending" } },
    { say: (line) => saidFromPoll.push(line), pause },
  );
  expect(saidFromPoll).toEqual([
    "Set example.org's nameservers at your registrar to:\n  carol.ns.cloudflare.com\n  dave.ns.cloudflare.com\nTurn DNSSEC off at your current registrar before changing nameservers.",
  ]);

  // a domain bought at Cloudflare's registrar prints no nameserver instructions
  const saidForBought: string[] = [];
  await zoneOf(
    makeZoneCf([{ id: "z1", name: "bought.dev", status: "active" }]),
    "acct-1",
    {
      domain: "bought.dev",
      offer: { name: "bought.dev", registrable: true },
      zone: {
        id: "z1",
        name: "bought.dev",
        status: "pending",
        name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      },
    },
    { say: (line) => saidForBought.push(line), pause },
  );
  expect(saidForBought).toEqual([]);
});

test("workersPaidPrompt covers Purchase, bank confirmation, card declines, and the reload hint only for newly created accounts", () => {
  const existing = workersPaidPrompt(false);
  expect(existing).toContain("Purchase");
  expect(existing).toContain("confirm the payment");
  expect(existing).toContain("declines a card on a new account");
  expect(existing).not.toContain("not authorized");

  const created = workersPaidPrompt(true);
  expect(created).toContain(existing);
  expect(created).toContain("not authorized, wait a minute and reload");
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
  expect(
    pnpmEnvFor("npx", {
      PATH: "/usr/bin",
      npm_config_manage_package_manager_versions: "false",
    }),
  ).toEqual({
    PATH: "/usr/bin",
    npm_config_engine_strict: "false",
    COREPACK_ENABLE_STRICT: "0",
  });
  expect(pnpmEnvFor("pnpm", { PATH: "/usr/bin" })).toEqual({
    PATH: "/usr/bin",
    ...PNPM_COMPAT_ENV,
  });
});

test("createDeployProgress summarizes Alchemy resource progress and ignores plan previews, raw stack output, and warnings", () => {
  const progress = createDeployProgress();
  expect(progress.onLine('npm warn Unknown env config "manage-package-manager-versions"')).toBe(
    undefined,
  );
  expect(progress.onLine("Bootstrapping Cloudflare State Store 'iterate-ada-state'")).toBe(
    "preparing state store",
  );
  // Plan-time adopted preview lines must not be counted before Plan: finishes
  expect(progress.onLine("[AuthDb] adopted")).toBe(undefined);
  expect(progress.onLine("[21:45:42.000] INFO: [AuthDb] adopted")).toBe(undefined);
  expect(progress.onLine("Plan: 45 to create, 2 to update, 1 to adopted, 2 binding changes")).toBe(
    "0 of 48 resources",
  );
  expect(progress.onLine("[AuthDb] adopted")).toBe(undefined);
  expect(progress.onLine("[21:45:43.607] INFO: [AuthDb] create")).toBe(undefined);
  expect(progress.onLine("[21:45:44.100] INFO: [AuthDb] created (0.5s)")).toBe("1 of 48 resources");
  expect(progress.onLine("[21:45:45.200] INFO: [Auth] updated (1.1s)")).toBe("2 of 48 resources");
  expect(progress.onLine("[21:45:46.000] INFO: [Bucket] adopted (0.4s)")).toBe("3 of 48 resources");
  expect(progress.onLine("{ controlPlaneHostname: 'iterate.alpiti.com' }")).toBe(undefined);
});

test("the deploy runs again by itself after the state store's refusal, and after no other failure", () => {
  expect(
    saysTheStateStoreRefused("error: State store request failed (DecodeError, HTTP 404)."),
  ).toBe(true);
  expect(saysTheStateStoreRefused("StateStoreError: the store did not answer")).toBe(true);
  expect(saysTheStateStoreRefused("error: Authentication error (code 10000)")).toBe(false);
  expect(saysTheStateStoreRefused("[15:25:30.212] INFO: Computing plan")).toBe(false);
  // the error of a run that reads the store while Cloudflare does not serve its address
  expect(
    saysTheStateStoreRefused(
      "HttpClientError: Decode: undeclared status code (404 GET https://iterate-blunfin-com-state.iterate-dev-preview.workers.dev/state/stacks)",
    ),
  ).toBe(true);
  expect(
    saysTheStateStoreRefused(
      "HttpClientError: Decode: undeclared status code (404 GET https://api.cloudflare.com/client/v4/accounts)",
    ),
  ).toBe(false);
});

test("waitForStore goes on after three 200 answers in a row, 2 s apart, and says a line each 30 s", async () => {
  expect(ADDRESS).toBe("https://iterate-blunfin-com-state.iterate-dev-preview.workers.dev");
  const said: string[] = [];
  // 404 for a minute, one 200, 404 again, then the address serves
  const clock = storeClock([...Array<boolean>(30).fill(false), true, false, true, true, true]);
  expect(await waitForStore(ADDRESS, (line) => said.push(line), clock)).toBe(true);
  expect(clock.reads).toHaveLength(35);
  expect(clock.reads.at(-1)).toBe(68_000);
  expect(said).toEqual([
    `0 s: ${WAITING_FOR_STORE} at ${ADDRESS}, for at most 6 min`,
    `30 s: ${WAITING_FOR_STORE}`,
    `1 min: ${WAITING_FOR_STORE}`,
  ]);
});

test("waitForStore stops at its bound when the address never serves", async () => {
  const said: string[] = [];
  const clock = storeClock([]);
  expect(await waitForStore(ADDRESS, (line) => said.push(line), clock)).toBe(false);
  expect(clock.reads.at(-1)).toBe(STORE_WAIT_MS);
  expect(said).toHaveLength(1 + STORE_WAIT_MS / 30_000 - 1);
  expect(said.at(-1)).toBe(`5 min 30 s: ${WAITING_FOR_STORE}`);
});

test("after the state store's refusal the deploy waits for the store, then runs exactly once more", async () => {
  const refused = { code: 1, storeRefused: true, consumerNotSeen: false };
  const done = { code: 0, storeRefused: false, consumerNotSeen: false };
  const said: string[] = [];
  const run = {
    stageName: "blunfin-com",
    storeAddress: ADDRESS,
    say: (line: string) => said.push(line),
  };

  // the store serves: one more run, and it deploys
  let clock = storeClock([true, true, true]);
  let outcomes = [refused, done];
  let runs = 0;
  const once = async () => {
    runs++;
    return outcomes.shift()!;
  };
  expect(await deployStack(run, once, clock)).toEqual({ code: 0, consumerNotSeen: false });
  expect(runs).toBe(2);
  expect(said).toEqual([
    `The new state store refused the deploy: ${ONE_MORE_TRY} at most 6 min, when Cloudflare serves it`,
    `0 s: ${WAITING_FOR_STORE} at ${ADDRESS}, for at most 6 min`,
  ]);

  // the store serves, and the second run is refused again: no third run, and it names the address
  clock = storeClock([true, true, true]);
  outcomes = [refused, refused, done];
  runs = 0;
  expect(await deployStack(run, once, clock)).toEqual({
    code: 1,
    consumerNotSeen: false,
    storeNotServed: ADDRESS,
  });
  expect(runs).toBe(2);

  // the store never serves: no second run
  clock = storeClock([]);
  outcomes = [refused, done];
  runs = 0;
  expect(await deployStack(run, once, clock)).toEqual({
    code: 1,
    consumerNotSeen: false,
    storeNotServed: ADDRESS,
  });
  expect(runs).toBe(1);
});

// the line Alchemy prints when its read-back of a new queue consumer ends unbound
const UNSEEN_CONSUMER =
  "[00:02:32.141] ERROR: [CloudflareEventsConsumer] fail — ConsumerScriptUnbound: Queue consumer is not bound to Worker script 'iterate-ada-labs-com-boundary' (1m 26s)";

test("the deploy runs again by itself, once, when Alchemy did not yet see the queue's consumer", async () => {
  expect(saysTheConsumerIsNotSeenYet(UNSEEN_CONSUMER)).toBe(true);
  expect(
    saysTheConsumerIsNotSeenYet("[00:01:06.528] INFO: [CloudflareEventsConsumer] creating"),
  ).toBe(false);

  const runs: (string[] | undefined)[] = [];
  const said: string[] = [];
  const pauses: number[] = [];
  const unseen = { code: 1, storeRefused: false, consumerNotSeen: true };
  const run = {
    stageName: "ada-labs-com",
    storeAddress: "https://iterate-ada-labs-com-state.ada.workers.dev",
    say: (line: string) => said.push(line),
  };
  const pause = async (ms: number) => pauses.push(ms);
  const recorded = (outcome: typeof unseen) => async (_: unknown, args?: string[]) => {
    runs.push(args);
    return outcome;
  };

  // a second failure of the same kind ends the command: no third run
  const twice = await deployStack(run, recorded(unseen), { pause });
  expect(twice).toEqual({ code: 1, consumerNotSeen: true });
  expect(runs).toEqual([undefined, deployArgsOf("ada-labs-com", true)]);
  expect(pauses).toEqual([60_000]);
  expect(said).toEqual([
    `Cloudflare did not yet confirm the boundary Worker as the event queue's consumer: ${ONE_MORE_TRY} a minute`,
  ]);

  // the second run that finds the consumer ends the deploy
  const outcomes = [unseen, { code: 0, storeRefused: false, consumerNotSeen: false }];
  expect(await deployStack(run, async () => outcomes.shift()!, { pause })).toEqual({
    code: 0,
    consumerNotSeen: false,
  });

  // any other failure is not run again
  runs.length = 0;
  const other = { code: 1, storeRefused: false, consumerNotSeen: false };
  expect(await deployStack(run, recorded(other), { pause })).toEqual({
    code: 1,
    consumerNotSeen: false,
  });
  expect(runs).toHaveLength(1);
});

test("createDeployProgress names what Alchemy is still making, for a line in a quiet stretch", () => {
  const progress = createDeployProgress();
  expect(progress.stillAt()).toBe(undefined);
  progress.onLine("[23:54:42.739] INFO: Plan: 31 to create, 39 binding changes");
  progress.onLine("[23:54:42.741] INFO: [Boundary] create");
  expect(progress.stillAt()).toBe(undefined);
  progress.onLine("[23:56:50.260] INFO: [Secrets] creating");
  progress.onLine(
    "[23:56:50.261] INFO: [Auth] created — Uploading worker (535.10 KB) ... (1m 57s)",
  );
  progress.onLine("[23:58:50.646] INFO: [Mind] creating");
  progress.onLine("[23:58:50.646] INFO: [Boundary] creating");
  progress.onLine(
    "[23:58:47.987] INFO: [Secrets] created — Uploading worker (339.81 KB) ... (1m 58s)",
  );
  expect(progress.stillAt()).toBe("2 of 31 resources; still making Mind, Boundary");
  progress.onLine("[00:01:06.528] INFO: [CloudflareEventsConsumer] creating");
  progress.onLine("[00:01:06.528] INFO: [ApexRoute-ada-labs.com] creating");
  expect(progress.stillAt()).toBe(
    "2 of 31 resources; still making Mind, Boundary, CloudflareEventsConsumer and 1 more",
  );
  progress.onLine(UNSEEN_CONSUMER);
  progress.onLine("[00:01:09.673] INFO: [ApexRoute-ada-labs.com] created (3.1s)");
  expect(progress.stillAt()).toBe("3 of 31 resources; still making Mind, Boundary");
});

test("the sign-in after a first deploy goes through the first passkey to the issuer's page; a redeploy's goes straight there", () => {
  const authorize =
    "https://iterate.ada-labs.com/oauth/authorize?client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A5050%2Fcallback";
  const first = new URL(
    signInPageOf({ controlPlaneHostname: "iterate.ada-labs.com", firstDeploy: true }, authorize),
  );
  expect({
    first: `${first.origin}${first.pathname}`,
    next: first.searchParams.get("next"),
    again: signInPageOf(
      { controlPlaneHostname: "iterate.ada-labs.com", firstDeploy: false },
      authorize,
    ),
  }).toEqual({
    first: "https://iterate.ada-labs.com/sign-in/access",
    next: authorize,
    again: authorize,
  });
});

test("deploy has no OAuth-client token prompt or Account API Token Provisioning, isolates token env vars, prints MindConfig, respects CI=1, waits for Enter before opening browser, and ends at onboarding.<zone>", () => {
  expect(onboardingUrlOf("ada-labs.com")).toBe("https://onboarding.ada-labs.com/");
  expect(
    setupDestinationOf({
      controlPlaneHostname: "iterate.ada-labs.com",
      zone: "ada-labs.com",
      ownerEmails: ["ada@example.org"],
      firstDeploy: true,
    }),
  ).toEqual({
    url: "https://iterate.ada-labs.com/sign-in/access",
    prompt: "Continue setup in your browser (sign in with ada@example.org):",
  });
  expect(
    setupDestinationOf({
      controlPlaneHostname: "iterate.ada-labs.com",
      zone: "ada-labs.com",
      ownerEmails: ["ada@example.org"],
      firstDeploy: false,
    }),
  ).toEqual({
    url: "https://onboarding.ada-labs.com/",
    prompt: "Continue setup in your browser (sign in with ada@example.org):",
  });
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
    ownerEmailPatterns: ["*@company.example"],
    mcpTarget: "mcp",
    topology: "full-cloudflare",
    alchemy: { stageName: "ada-labs-com" },
    cloudflare: {
      accountId,
      zones: ["ada-labs.com"],
      containerImage: `registry.cloudflare.com/${accountId}/iterate-sandbox@sha256:${"ab".repeat(32)}`,
      egressGatewayWorker: "ada-egress",
    },
    mail: { forwardTo: "team@group.example" },
    telemetry: { traceSampling: 0.25 },
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
  expect(overMind(whole, { traceSampling: "1" })).toEqual({
    ...whole,
    telemetry: { traceSampling: 1 },
  });
  const { telemetry: _telemetry, ...withoutTelemetry } = whole;
  expect(JSON.parse(JSON.stringify(overMind(whole, { traceSampling: "default" })))).toEqual(
    withoutTelemetry,
  );
  expect(() => overMind(whole, { mailForwardTo: "team@ada-labs.com" })).toThrow(
    /domain of the mind/,
  );
  // the zones: the flag is the whole list, the mind's first zone stays first, no flag keeps them
  expect(overMind(whole, { zones: "ada-labs.com,second.example" })).toEqual({
    ...whole,
    cloudflare: { ...whole.cloudflare, zones: ["ada-labs.com", "second.example"] },
  });
  for (const zones of [
    "",
    "second.example",
    "second.example,ada-labs.com",
    "ada-labs.com,not a domain",
    "ada-labs.com,ada-labs.com",
  ])
    expect(() => overMind(whole, { zones }), zones).toThrow(/--zones/);
  // an owner or a forward at a zone that joins is refused, as at any zone of the mind
  expect(() => overMind(whole, { zones: "ada-labs.com,example.org" })).toThrow(
    /domain of the mind/,
  );
  // the egress gateway: a flag names another Worker, `none` takes it away, no flag keeps it
  expect(overMind(whole, { egressGateway: "other-egress" })).toEqual({
    ...whole,
    cloudflare: { ...whole.cloudflare, egressGatewayWorker: "other-egress" },
  });
  const { egressGatewayWorker: __, ...withoutGateway } = whole.cloudflare;
  expect(JSON.parse(JSON.stringify(overMind(whole, { egressGateway: "none" })))).toEqual({
    ...whole,
    cloudflare: withoutGateway,
  });
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
  expect(at("await eraseHoldings(cf, zone.id)")).toBeLessThan(at("await deployStack(\n      {"));
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
  expect(command.match(/adopt: .*/g)).toEqual(["adopt: Boolean(earlier || resuming),"]);
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

test("the check after a deploy waits, bounded, until the boundary holds the new settings; a read that never answers is no miss", async () => {
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
  // the reads of a new Worker's lag: the empty script that Alchemy makes first, and a Worker that
  // Cloudflare says does not exist
  const empty = { status: 200, result: { bindings: [] } };
  const absent = { status: 404, error: "This Worker does not exist on your account. (code 10007)" };
  const other = {
    status: 200,
    result: {
      bindings: [
        {
          type: "plain_text",
          name: "DEPLOY_CONFIG",
          text: JSON.stringify({ ...deployed, mindId: "another-run" }),
        },
        held.result.bindings[1],
      ],
    },
  };
  // each read takes no time; each pause moves the clock on
  const check = async (...reads: { status: number; result?: unknown; error?: string }[]) => {
    let t = 0;
    let pauses = 0;
    const said: string[] = [];
    const last = reads.at(-1);
    const outcome = await boundaryCheck(async () => reads.shift() ?? last!, deployed, {
      say: (line) => said.push(line),
      pause: async (ms) => {
        pauses++;
        t += ms;
      },
      now: () => t,
    });
    return { outcome, pauses, said, waited: t };
  };
  // a Worker that exists holds the new settings at the first read, and nothing is said
  expect(await check(held)).toEqual({ outcome: { held: true }, pauses: 0, said: [], waited: 0 });
  // a new Worker: "does not exist", then the empty script, then for 75 s a stale read, then all
  const lag = Array<typeof stale>(25).fill(stale);
  expect(await check(absent, empty, ...lag, held)).toEqual({
    outcome: { held: true },
    pauses: 27,
    said: [
      `0 s: ${WAITING_FOR_BOUNDARY}, for at most 3 min`,
      `30 s: ${WAITING_FOR_BOUNDARY}`,
      `1 min: ${WAITING_FOR_BOUNDARY}`,
    ],
    waited: 81_000,
  });
  // another run's config, to the bound: a miss, with each read for the deploy's log
  const missed = await check(absent, other);
  expect(missed).toMatchObject({
    outcome: { miss: expect.stringMatching(/DEPLOY_CONFIG is not the config/) },
    waited: BOUNDARY_WAIT_MS,
  });
  expect(missed.said).toHaveLength(BOUNDARY_WAIT_MS / 30_000);
  expect(missed.said.at(-1)).toBe(`2 min 30 s: ${WAITING_FOR_BOUNDARY}`);
  const reads = "reads" in missed.outcome ? missed.outcome.reads : [];
  expect(reads).toHaveLength(BOUNDARY_WAIT_MS / 3000 + 1);
  expect(reads.slice(0, 2)).toEqual([
    "0 s: 404 This Worker does not exist on your account. (code 10007)",
    "3 s: 200 bindings DEPLOY_CONFIG,MAIL_FORWARD_TO; DEPLOY_CONFIG differs at mindId",
  ]);
  expect(reads.at(-1)).toMatch(/^3 min: 200/);
  // a read names no value of the config
  expect(reads.join("\n")).not.toContain("another-run");
  expect(reads.join("\n")).not.toContain("team@group.example");
  // a forward that never shows is a miss too; the empty script's read says so
  expect(await check(stale)).toMatchObject({
    outcome: { miss: expect.stringMatching(/forwards none/) },
  });
  expect(boundaryRead(empty, deployed)).toBe("200 bindings none; DEPLOY_CONFIG absent");
  // reads that never answer 200: no miss, the last status
  expect(await check({ status: 500 }, { status: 429 }, { status: 502 })).toMatchObject({
    outcome: { unread: 502 },
    waited: BOUNDARY_WAIT_MS,
  });
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

test("unfinishedDeployIn matches only a marker for the same account, stage, domain, and mind id", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-marker-"));
  const markerFile = join(dir, "deploying.json");
  const expected = {
    accountId: "a".repeat(32),
    stageName: "alpiti-com",
    domain: "alpiti.com",
    mindId: "b".repeat(64),
  };

  expect(unfinishedDeployIn(markerFile, expected)).toBeUndefined();

  writeFileSync(markerFile, JSON.stringify({ ...expected, firstDeploy: true }));
  expect(unfinishedDeployIn(markerFile, expected)).toEqual({ ...expected, firstDeploy: true });
  expect(unfinishedDeployIn(markerFile, { ...expected, mindId: undefined })).toBeUndefined();
  expect(unfinishedDeployIn(markerFile, { ...expected, mindId: "c".repeat(64) })).toBeUndefined();
  expect(unfinishedDeployIn(markerFile, { ...expected, domain: "other.com" })).toBeUndefined();
  expect(unfinishedDeployIn(markerFile, { ...expected, stageName: "other" })).toBeUndefined();
  expect(
    unfinishedDeployIn(markerFile, { ...expected, accountId: "d".repeat(32) }),
  ).toBeUndefined();

  writeFileSync(markerFile, "not json");
  expect(unfinishedDeployIn(markerFile, expected)).toBeUndefined();

  // deployMind writes deploying.json before deployStack, removes it on success, resumes without
  // asking --yes when no config changed, adopts unfinished resources, and says "deployed" when
  // finishing a first deploy.
  const source = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8");
  expect(source).toContain('const markerFile = join(work, "deploying.json");');
  expect(source).toContain(
    "if (resuming && changes.length === 0 && forwardAfter === forwardBefore)",
  );
  expect(source).toContain("adopt: Boolean(earlier || resuming)");
  expect(source).toContain("rmSync(markerFile, { force: true });");
  expect(source).toContain("deployed && !resuming?.firstDeploy");
});

test("the deploy opens no page until the pages a browser asks first work: iterate.<domain>, the apex, onboarding.<zone>, dash.<zone> and, for a new mind, the app description and Cloudflare Access", async () => {
  const mind = { controlPlaneHostname: "iterate.ada-labs.com", zone: "ada-labs.com" };
  const CONTROL_PLANE = "https://iterate.ada-labs.com/";
  const SIGN_IN = "https://iterate.ada-labs.com/sign-in";
  const OAUTH_META = "https://iterate.ada-labs.com/.well-known/oauth-authorization-server";
  const APEX = "https://ada-labs.com/";
  const ONBOARDING = "https://onboarding.ada-labs.com/";
  const DASH = "https://dash.ada-labs.com/";
  const ONBOARDING_APP = "https://onboarding.ada-labs.com/.well-known/iterate-app";
  const ACCESS = "https://iterate.ada-labs.com/sign-in/access";
  const pages = firstPagesOf({ ...mind, firstDeploy: true });
  expect(pages.map((page) => page.address)).toEqual([
    CONTROL_PLANE,
    SIGN_IN,
    OAUTH_META,
    APEX,
    ONBOARDING,
    DASH,
    ONBOARDING_APP,
    ACCESS,
  ]);
  // a deploy over a mind asks no first owner's way, and takes the mind's own 404 for an app
  // that its owner removed
  const over = firstPagesOf({ ...mind, firstDeploy: false });
  expect(over.map((page) => page.address)).toEqual([
    CONTROL_PLANE,
    SIGN_IN,
    OAUTH_META,
    APEX,
    ONBOARDING,
    DASH,
  ]);
  expect(over[4]!.works({ status: 404, location: null })).toBe(true);
  expect(over[4]!.works({ status: 522, location: null })).toBe(false);
  // a new mind's Onboarding and Dash apps answer 401 to Node's fetch, which is no navigation; a
  // 404 says that the app is not there yet
  expect(pages[4]!.works({ status: 401, location: null })).toBe(true);
  expect(pages[4]!.works({ status: 404, location: null })).toBe(false);
  expect(pages[5]!.works({ status: 401, location: null })).toBe(true);
  expect(pages[5]!.works({ status: 404, location: null })).toBe(false);
  expect(pages[6]!.works({ status: 200, location: null })).toBe(true);
  expect(pages[6]!.works({ status: 404, location: null })).toBe(false);

  type Answer = { status: number; location: string | null } | { error: string };
  const works: Record<string, Answer> = {
    [CONTROL_PLANE]: { status: 302, location: "https://dash.ada-labs.com/" },
    [SIGN_IN]: { status: 200, location: null },
    [OAUTH_META]: { status: 200, location: null },
    [APEX]: { status: 200, location: null },
    [ONBOARDING]: { status: 401, location: null },
    [DASH]: { status: 401, location: null },
    [ONBOARDING_APP]: { status: 200, location: null },
    [ACCESS]: {
      status: 302,
      location: "https://ada.cloudflareaccess.com/cdn-cgi/access/login/iterate.ada-labs.com",
    },
  };
  // each read takes no time; each pause moves the clock on. `rounds` are the answers that
  // differ from `works`, one entry a round of reads; after them every page works
  const wait = async (...rounds: Record<string, Answer>[]) => {
    let t = 0;
    let round = 0;
    const said: string[] = [];
    const outcome = await firstPagesAnswer(pages, {
      read: async (page) => ({ ...works, ...rounds[round] })[page.address]!,
      say: (line) => said.push(line),
      pause: async (ms) => {
        t += ms;
        round++;
      },
      now: () => t,
    });
    return { outcome, said, waited: t };
  };
  // all work: five reads in a row, 3 s apart
  expect(await wait()).toEqual({ outcome: { answered: true }, said: [], waited: 12_000 });
  // DNS THAT COMES LATE: the wildcard's name does not resolve until 60 s, then one 522 breaks the
  // row of good reads, which starts again
  const late = Array<Record<string, Answer>>(20).fill({ [ONBOARDING]: { error: "ENOTFOUND" } });
  expect(await wait(...late, {}, {}, { [ONBOARDING]: { status: 522, location: null } })).toEqual({
    outcome: { answered: true },
    said: [`30 s: ${ONBOARDING} gave no answer (ENOTFOUND)`],
    waited: 81_000,
  });
  // A FAULT THAT STAYS, each to the bound, with the page and its answer: a certificate that is
  // not there, a route that is not there, and an Access application that is not live, where the
  // auth Worker's own 403 answers and the provider's deploy and three pages are fine
  const never = (answer: Record<string, Answer>) =>
    wait(...Array<Record<string, Answer>>(FIRST_PAGES_WAIT_MS / 3000 + 1).fill(answer));
  expect(
    await never({ [ONBOARDING]: { error: "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE" } }),
  ).toMatchObject({
    outcome: { fault: `${ONBOARDING} gave no answer (ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE)` },
    waited: FIRST_PAGES_WAIT_MS,
  });
  expect(await never({ [APEX]: { status: 522, location: null } })).toMatchObject({
    outcome: { fault: `${APEX} answered 522` },
  });
  expect(await never({ [ACCESS]: { status: 403, location: null } })).toMatchObject({
    outcome: { fault: `${ACCESS} answered 403` },
  });
  // a redirect of the first owner's way to anything but Cloudflare Access is no proof of it
  expect(
    await never({ [ACCESS]: { status: 302, location: "https://iterate.ada-labs.com/sign-in" } }),
  ).toMatchObject({ outcome: { fault: `${ACCESS} answered 302 to https://iterate.ada-labs.com` } });
});

test("parseExtraOwnerEmails and deployConfigOf support adding additional owner sign-in emails", () => {
  expect(parseExtraOwnerEmails("")).toEqual([]);
  expect(parseExtraOwnerEmails("  ")).toEqual([]);
  expect(parseExtraOwnerEmails("Personal@Gmail.com, other@example.org personal@gmail.com")).toEqual(
    ["personal@gmail.com", "other@example.org"],
  );
  const config = deployConfigOf({
    accountId: "a".repeat(32),
    domain: "ada-labs.com",
    owner: "cf@work.com",
    extraOwners: ["Personal@Gmail.com", "cf@work.com"],
  });
  expect(config).toMatchObject({ ownerEmails: ["cf@work.com", "personal@gmail.com"] });
});

test("assertSupportedNodeVersion rejects Node < 24.7 before sign-in and accepts Node 24.7+", () => {
  for (const old of ["18.20.0", "20.19.0", "22.14.0", "24.0.0", "24.6.9"]) {
    expect(() => assertSupportedNodeVersion(old)).toThrow(/requires Node 24\.7 or newer.*HTTP 403/);
  }
  for (const ok of ["24.7.0", "24.12.1", "25.0.0", "26.13.0"]) {
    expect(() => assertSupportedNodeVersion(ok)).not.toThrow();
  }
});

test("a source that holds core/repos/onboarding tells the mind Worker's build to seed /repos/onboarding from it; an older source names no repo", () => {
  const source = mkdtempSync(join(tmpdir(), "deploy-seed-"));
  expect(seedReposEnvOf(source)).toEqual({});
  mkdirSync(join(source, "core/repos/onboarding"), { recursive: true });
  expect(JSON.parse(seedReposEnvOf(source).ITERATE_SEED_REPOS!)).toEqual({
    "/repos/onboarding": join(source, "core/repos/onboarding"),
  });
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

const ADDRESS = stateStoreAddress("blunfin-com", "iterate-dev-preview");

/** A clock that only `pause` moves, and a store that answers as `answers` says, read by read. */
function storeClock(answers: boolean[]) {
  let at = 0;
  const reads: number[] = [];
  return {
    reads,
    pause: async (ms: number) => {
      at += ms;
    },
    now: () => at,
    answers: async () => {
      reads.push(at);
      return answers.shift() ?? false;
    },
  };
}
