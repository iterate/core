import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import {
  apiTokenPage,
  DEPLOY_SCOPES,
  MAKES_API_TOKENS,
  RECOVER_SCOPES,
  scopesLacking,
  STACK_SCOPES,
} from "./cloudflare-access.ts";
import {
  candidatesOf,
  chatgptPlanWay,
  deployConfigOf,
  erateOf,
  firstSignInWords,
  identityKeyLineOf,
  mcpInstalls,
  mindConfigIn,
  onboardingTurnScript,
  saysTheStateStoreRefused,
  stageNameOf,
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

test("a deploy asks for ML-DSA-65 only for a mind with no id, before anything changes; the identity steps ask for themselves where they sign or check", () => {
  const source = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8");
  expect(source.match(/.*mlDsaRequired\(.*/g)).toEqual([
    "    if (!config.mindId) await mlDsaRequired();",
  ]);
  expect(source).not.toContain("canVerifyMlDsa65");
  const identity = readFileSync(new URL("./identity.ts", import.meta.url), "utf8");
  // a birth, and a check of the records here; nothing before a post with no records here
  expect(identity.match(/^ {2}await mlDsaRequired\(\);$/gm)).toHaveLength(2);
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

test("a sign-in asks for the scope that makes API tokens, and for a scope that covers each permission of the script's two tokens", () => {
  // The script's tokens name permission groups, and a token made through a sign-in may hold only
  // groups that the sign-in's scopes cover: each group here, with the scope that is its other
  // spelling. A group that the script names and this table does not fails the test.
  const scopeOfGroup: Record<string, string> = {
    "Workers R2 Data Catalog Write": "r2-catalog.write",
    "Workers R2 Storage Bucket Item Write": "workers-r2-bucket-item.write",
    "Workers R2 SQL Read": "r2-catalog-sql.read",
    "Account Analytics Read": "account-analytics.read",
  };
  const script = readFileSync(
    new URL("../../../alchemy/src/stack.ts", import.meta.url).pathname,
    "utf8",
  );
  const groups = [...script.matchAll(/permissionGroups: \[([^\]]*)\]/g)].flatMap(([, names]) =>
    [...(names || "").matchAll(/"([^"]+)"/g)].map(([, name]) => name || ""),
  );
  expect(groups.length).toBeGreaterThan(0);
  expect([...new Set(groups)].toSorted()).toEqual(Object.keys(scopeOfGroup).toSorted());
  expect(STACK_SCOPES).toContain(MAKES_API_TOKENS);
  for (const scope of Object.values(scopeOfGroup)) expect(STACK_SCOPES).toContain(scope);
  // the deploy's sign-in asks for the stack's scopes whole, and no scope twice
  expect(DEPLOY_SCOPES).toEqual(expect.arrayContaining(STACK_SCOPES));
  expect([...new Set(DEPLOY_SCOPES)]).toEqual(DEPLOY_SCOPES);
  // the recovery's sign-in can write to D1, and can deploy and make nothing else
  expect(RECOVER_SCOPES.filter((scope) => !scope.endsWith(".read"))).toEqual(["d1.write"]);
});

test("what a sign-in did not grant is read from the token answer's scope, and an answer with none granted all", () => {
  expect(scopesLacking(DEPLOY_SCOPES, undefined)).toEqual([]);
  expect(scopesLacking(DEPLOY_SCOPES, DEPLOY_SCOPES.join(" "))).toEqual([]);
  const unticked = DEPLOY_SCOPES.filter((scope) => scope !== MAKES_API_TOKENS).join(" ");
  expect(scopesLacking(DEPLOY_SCOPES, unticked)).toEqual([MAKES_API_TOKENS]);
  expect(scopesLacking(["zone.read", "d1.write"], "d1.write offline_access")).toEqual([
    "zone.read",
  ]);
});

test("the page that makes an API token instead names each of the stack's permissions by its key, as read or edit", () => {
  const page = apiTokenPage();
  expect(page.origin + page.pathname).toBe("https://dash.cloudflare.com/");
  expect(page.searchParams.get("to")).toBe("/:account/api-tokens");
  const keys = JSON.parse(page.searchParams.get("permissionGroupKeys") || "");
  // and "OAuth Client Write", by its group's id, for the stack's own OAuth client
  expect(keys).toHaveLength(STACK_SCOPES.length + 1);
  expect(keys).toEqual(
    expect.arrayContaining([
      { key: "workers_scripts", type: "edit" },
      { key: "zone", type: "read" },
      { key: "r2_catalog_sql", type: "read" },
      { key: "access_acct", type: "edit" },
      { key: "account_api_tokens", type: "edit" },
      // allow-high-entropy-next-line: the id of the permission group "OAuth Client Write", public and the same in every account
      { key: "50fc2f43318f40e4855a35d8de5bf643", type: "edit" },
    ]),
  );
});

test("the deploy runs again by itself after the state store's refusal, and after no other failure", () => {
  expect(
    saysTheStateStoreRefused("error: State store request failed (DecodeError, HTTP 404)."),
  ).toBe(true);
  expect(saysTheStateStoreRefused("StateStoreError: the store did not answer")).toBe(true);
  expect(saysTheStateStoreRefused("error: Authentication error (code 10000)")).toBe(false);
  expect(saysTheStateStoreRefused("[15:25:30.212] INFO: Computing plan")).toBe(false);
});

test("the onboarding turn runs in the mind: it says hi to the onboarding agent and answers how the model's request ended", async () => {
  const said: string[] = [];
  const result = { status: "succeeded", text: "Welcome" };
  const itx = {
    agents: {
      get: (path: string) => ({
        message: async (text: string) => {
          said.push(`${path}: ${text}`);
          return { offset: 7 };
        },
      }),
    },
    cd: () => ({
      readEvents: async () => ({
        events: [
          { type: "events.iterate.com/agent/llm-request-started", payload: {} },
          { type: "events.iterate.com/agent/llm-request-settled", payload: { result } },
        ],
      }),
    }),
  };
  // the script is text for the mind: here it runs as the function it spells
  const turn = runInNewContext(`(${onboardingTurnScript()})`, { setTimeout });
  expect(await turn(itx)).toEqual(result);
  expect(said).toEqual(["/agents/onboarding: hi"]);
});

test("the MCP server goes to Claude Code and Codex for the whole user, under the control-plane hostname's own name", () => {
  expect(
    mcpInstalls("iterate.ada-labs.com").map(({ command, args }) => [command, ...args].join(" ")),
  ).toEqual([
    "claude mcp add --transport http --scope user iterate-ada-labs-com https://iterate.ada-labs.com/mcp",
    "codex mcp add iterate-ada-labs-com --url https://iterate.ada-labs.com/mcp",
  ]);
});

test("the words before the first sign-in fit the flow: the device flow names the page to open and the page with the terminal's code", () => {
  const browser = firstSignInWords("browser", ["ada@example.org"]).join(" ");
  const device = firstSignInWords("device", ["ada@example.org", "charles@example.org"]).join(" ");
  for (const words of [browser, device]) {
    expect(words).toContain('"prove your email address with Cloudflare"');
    expect(words).toContain("add your passkey");
  }
  expect(browser).toContain("opens now");
  expect(browser).toContain("Cloudflare mails a code to ada@example.org.");
  expect(browser).toContain("The same page then signs this terminal in.");
  expect(device).toContain("Open the page below in your browser, on any computer.");
  expect(device).toContain("Cloudflare mails a code to ada@example.org or charles@example.org.");
  expect(device).toContain("shows the same code as this terminal");
  expect(device).not.toContain("opens now");
});

test("with the browser on another computer, the ChatGPT plan is a command to run there, and here it is the command's own step", () => {
  expect(chatgptPlanWay("browser", "iterate.ada-labs.com")).toEqual({
    hint: "recommended",
    runThere: undefined,
  });
  expect(chatgptPlanWay("device", "iterate.ada-labs.com")).toMatchObject({
    hint: "connected from the computer with your browser",
    runThere: expect.stringContaining("  npx iterate@latest chatgpt connect iterate.ada-labs.com"),
  });
  // a control plane at a zone's apex is typed as a URL: a bare `ada-labs.com` reads as iterate.ada-labs.com
  expect(chatgptPlanWay("device", "ada-labs.com").runThere).toContain(
    "chatgpt connect https://ada-labs.com",
  );
});
