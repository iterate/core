// What the mind's own Cloudflare API token may do (cloudflare-token.ts), held against the catalog
// of permission groups that Alchemy ships.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { PERMISSION_GROUPS } from "@alchemy.run/cloudflare/ApiToken";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import {
  CLOUDFLARE_TOKEN_EDITION,
  CLOUDFLARE_TOKEN_NOT_GRANTED_BY_THE_CLOUD,
  CLOUDFLARE_TOKEN_READS_LEFT_OUT,
  CLOUDFLARE_TOKEN_WRITES,
  cloudflareTokenGroupsOf,
  cloudflareTokenNameOf,
  cloudflareTokenPoliciesOf,
  editionOfCloudflareTokenName,
  MIND_CLOUDFLARE_TOKEN,
  mindCloudflareTokenProvider,
  withCloudflareToken,
  withoutRefusedGroups,
} from "./cloudflare-token.ts";

const ACCOUNT = "0".repeat(32);
const groups = cloudflareTokenGroupsOf();
const held = [...groups.account, ...groups.zone];
const names = new Set<string>(held.map(({ name }) => name));

void test("the token holds reads, and the writes that are named: nothing else", () => {
  const writes = CLOUDFLARE_TOKEN_WRITES;
  for (const { name } of held) assert.ok(/ read$/i.test(name) || writes.includes(name), name);
  for (const name of writes) assert.ok(names.has(name), name);
});

void test("the one kind of write is the query of logs and traces", () => {
  assert.deepEqual(
    held.map(({ name }) => name).filter((name) => !/ read$/i.test(name)),
    ["Workers Observability Write"],
  );
});

void test("the token reads what the account runs and how it is set up", () => {
  for (const name of [
    "Workers Observability Read",
    "Workers Containers Read",
    "Workers Routes Read",
    "Zone Settings Read",
    "AI Gateway Read",
    "Queues Read",
    "Email Sending Read",
    "Email Routing Rules Read",
    // the names and sizes of databases, namespaces and buckets, and none of their data
    "D1 Metadata Read",
    "Workers KV Storage Metadata Read",
    "Workers R2 Storage Metadata Read",
  ])
    assert.ok(names.has(name), name);
});

// Each of these is a way to take the stack over, or to read what the stack trusts. The check is
// by id, under every name that the catalog has for a group.
void test("the token cannot take the stack over: it holds none of these", () => {
  const heldIds = new Set(held.map(({ id }) => id));
  for (const name of [
    // the code, the bindings and the secrets of the stack's own Workers
    "Workers Scripts Write",
    "Workers Containers Write",
    // a Durable Object's database (the vault's records, every context's log), and a live tail
    "Workers Scripts Read",
    "Workers Tail Read",
    // the keys that the stack trusts, its sign-ins, the code that the mind loads
    "D1 Read",
    "D1 Write",
    "Workers KV Storage Read",
    "Workers KV Storage Write",
    "Workers R2 Storage Read",
    "Workers R2 Storage Write",
    // events that the stack takes as Cloudflare's
    "Queues Write",
    // where the sign-in's hostname leads
    "DNS Write",
    "Workers Routes Write",
    "Zone Settings Write",
    // nothing uses these
    "AI Gateway Write",
    "AI Gateway Run",
    "Workers AI Write",
    "Browser Rendering Write",
    "Pipelines Write",
    "Pipelines Send",
    "Workers R2 Data Catalog Write",
    "Workers Observability Telemetry Write",
    "Zone Observability Write",
    "Account Settings Read",
  ]) {
    const ids = PERMISSION_GROUPS.filter((group) => group.name === name).map(({ id }) => id);
    assert.ok(ids.length, `the catalog has ${name}`);
    for (const id of ids) assert.ok(!heldIds.has(id), name);
  }
});

void test("the token reaches nothing beyond the account, and changes nobody's access", () => {
  for (const name of [
    "Account API Tokens Write",
    "Account Settings Write",
    "Billing Write",
    "Registrar Domains Admin",
    "Zone Write",
    // a webhook destination and a Logpush job: a lasting export of the account's data to any URL
    "Notifications Write",
    "Logs Write",
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

void test("the token holds no group that iterate Cloud's consent cannot grant: Cloudflare refuses the whole token for one", () => {
  for (const name of CLOUDFLARE_TOKEN_NOT_GRANTED_BY_THE_CLOUD) assert.ok(!names.has(name), name);
});

// THE TOKEN TAKES EVERY GROUP OF THE CATALOG WHOSE NAME ENDS IN "Read", LESS TWO LISTS. So a catalog
// that gains a read group gives it to the token. This test then fails and names the group. Before
// you add a name here, ask what the group reads: a credential, or data of D1, KV, R2 or a Durable
// Object, belongs in CLOUDFLARE_TOKEN_READS_LEFT_OUT. Then raise CLOUDFLARE_TOKEN_EDITION, here
// and where the test below names it.
void test("each group of the token was looked at, by name, and none is there twice", () => {
  const sorted = (given: { name: string }[]) => given.map(({ name }) => name).sort();
  assert.deepEqual(sorted(groups.account), ACCOUNT_GROUPS_LOOKED_AT);
  assert.deepEqual(sorted(groups.zone), ZONE_GROUPS_LOOKED_AT);
  assert.equal(new Set(held.map(({ id }) => id)).size, held.length);
});

void test("the token's name at Cloudflare ends with the edition of its list", () => {
  assert.equal(
    cloudflareTokenNameOf("iterate-example-cloudflare"),
    `iterate-example-cloudflare-${CLOUDFLARE_TOKEN_EDITION}`,
  );
  assert.equal(
    editionOfCloudflareTokenName(cloudflareTokenNameOf("iterate-example-cloudflare")),
    String(CLOUDFLARE_TOKEN_EDITION),
  );
  // a token made before the name said its edition, also for a stack whose name ends in a digit
  // group of its own: the name's last part is then no edition of a list that the mind takes
  assert.equal(editionOfCloudflareTokenName("iterate-example-cloudflare"), "1");
  assert.equal(editionOfCloudflareTokenName("iterate-example-2-cloudflare"), "1");
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

/** Cloudflare's refusal, as it names the groups of one policy. */
const refusal = (names: string[]) =>
  `BadRequest: The OAuth session does not include the scopes required for the requested permission groups: ${names.join(", ")}`;

const idOf = (name: string) => PERMISSION_GROUPS.find((group) => group.name === name)!.id;
const policies = cloudflareTokenPoliciesOf(ACCOUNT);
const idsOf = (given: { permissionGroups: unknown[] }[]) =>
  given.flatMap(({ permissionGroups }) =>
    permissionGroups.map((group) => (group as { id: string }).id),
  );

void test("a refusal's groups leave the token, by whole names, and nothing else does", () => {
  const cut = withoutRefusedGroups(
    policies,
    refusal(["Workers Observability Write", "Queues Read"]),
  );
  assert.deepEqual(cut?.refused.toSorted(), ["Queues Read", "Workers Observability Write"]);
  assert.equal(idsOf(cut!.policies).length, held.length - 2);
  assert.ok(!idsOf(cut!.policies).includes(idOf("Workers Observability Write")));
  // "Queues Read" is a whole item, not a piece of "Queues Metadata Read"
  assert.ok(idsOf(cut!.policies).includes(idOf("Queues Metadata Read")));
  // a name with a comma in it is one item
  assert.equal(
    withoutRefusedGroups(
      policies,
      refusal(["Access: Organizations, Identity Providers, and Groups Read"]),
    ),
    undefined,
  );
  // another error, or a refusal that names none of the token's groups, is no cut
  assert.equal(
    withoutRefusedGroups(policies, "Unauthorized to access requested resource"),
    undefined,
  );
  assert.equal(withoutRefusedGroups(policies, refusal(["Billing Write"])), undefined);
});

void test("a policy whose every group is refused goes", () => {
  const zoneNames = groups.zone.map(({ name }) => name);
  const cut = withoutRefusedGroups(policies, refusal(zoneNames));
  assert.equal(cut?.policies.length, 1);
  assert.equal(cut?.refused.length, groups.zone.length);
});

/** Alchemy's provider of account tokens, made to refuse the groups of `refuse`, one list per try. */
function pretendAlchemy(refuse: string[][]) {
  const tries: string[][] = [];
  const service = {
    diff: () => Effect.succeed({ action: "update" as const }),
    reconcile: ({ news }: { news: { policies: { permissionGroups: unknown[] }[] } }) =>
      Effect.suspend(() => {
        tries.push(idsOf(news.policies));
        const names = refuse[tries.length - 1];
        if (names) return Effect.fail({ _tag: "BadRequest", message: refusal(names) });
        return Effect.succeed({ tokenId: "token-1" });
      }),
  };
  // The cast: the two members the wrapper calls, of Alchemy's provider service.
  return {
    service: service as unknown as Parameters<typeof mindCloudflareTokenProvider>[0],
    tries,
  };
}

const input = (id: string, output?: unknown) =>
  // The cast: the fields of a lifecycle call that the wrapper reads.
  ({ id, news: { name: "iterate-one-cloudflare", policies }, output, bindings: [] }) as never;

void test("Cloudflare refuses the account's groups, then the zones': the token is made with the rest, and the deploy says which", async () => {
  const alchemy = pretendAlchemy([
    ["Workers Observability Write"],
    ["Workers Routes Read", "Zone Settings Read"],
  ]);
  const said: string[] = [];
  const provider = mindCloudflareTokenProvider(alchemy.service, {
    keep: false,
    say: (line) => said.push(line),
  });
  const made = await Effect.runPromise(provider.reconcile(input(MIND_CLOUDFLARE_TOKEN)));
  assert.deepEqual(made, { tokenId: "token-1" });
  assert.deepEqual(
    alchemy.tries.map((ids) => ids.length),
    [held.length, held.length - 1, held.length - 3],
  );
  assert.equal(said.length, 1);
  assert.match(said[0]!, /refused 3 permission groups/);
  for (const name of ["Workers Observability Write", "Workers Routes Read", "Zone Settings Read"])
    assert.ok(said[0]!.includes(name), name);
});

void test("another error, another token, or a refusal without end, fails as Cloudflare said", async () => {
  const say = () => assert.fail("nothing to say");
  const other = pretendAlchemy([["Queues Read"]]);
  const exit = await Effect.runPromiseExit(
    mindCloudflareTokenProvider(other.service, { keep: false, say }).reconcile(
      input("TelemetryCatalogToken"),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  assert.equal(other.tries.length, 1);
  const endless = pretendAlchemy([
    ["Queues Read"],
    ["Pipelines Read"],
    ["Hyperdrive Read"],
    ["Vectorize Read"],
    ["Pages Read"],
  ]);
  const failed = await Effect.runPromiseExit(
    mindCloudflareTokenProvider(endless.service, { keep: false, say }).reconcile(
      input(MIND_CLOUDFLARE_TOKEN),
    ),
  );
  assert.ok(Exit.isFailure(failed));
  assert.equal(endless.tries.length, 4);
});

void test("with an access that may not change API tokens, the token that exists stays as it is", async () => {
  const alchemy = pretendAlchemy([]);
  const keep = mindCloudflareTokenProvider(alchemy.service, { keep: true, say: () => {} });
  const existing = { tokenId: "token-1" };
  assert.deepEqual(await Effect.runPromise(keep.diff!(input(MIND_CLOUDFLARE_TOKEN, existing))), {
    action: "noop",
  });
  // a token not made yet, and any other token, go to Alchemy's diff
  assert.deepEqual(await Effect.runPromise(keep.diff!(input(MIND_CLOUDFLARE_TOKEN))), {
    action: "update",
  });
  assert.deepEqual(await Effect.runPromise(keep.diff!(input("TelemetryCatalogToken", existing))), {
    action: "update",
  });
});

void test("with a token that makes tokens, each call of the provider uses it, at the deploy's base URL", async () => {
  // a pretend provider whose calls answer with the credential they were given
  const seen = Effect.gen(function* () {
    const credential = yield* yield* Cloudflare.Credentials;
    const token = credential.type === "apiToken" ? Redacted.value(credential.apiToken) : "none";
    return `${token} ${credential.apiBaseUrl}`;
  });
  // The cast: two members of Alchemy's provider service.
  const service = { stables: ["tokenId"], diff: () => seen, delete: () => seen } as never;
  const deploy = Effect.succeed({
    type: "apiToken" as const,
    apiToken: Redacted.make("deploy"),
    apiBaseUrl: "https://api.example",
  });
  const run = (provider: { diff?: unknown; delete: unknown }, call: "diff" | "delete") =>
    Effect.runPromise(
      Effect.provideService(
        (provider[call] as () => Effect.Effect<string, never, Cloudflare.Credentials>)(),
        Cloudflare.Credentials,
        deploy,
      ),
    );
  const wrapped = withCloudflareToken(service, "makes-tokens");
  assert.deepEqual((wrapped as { stables: unknown }).stables, ["tokenId"]);
  assert.equal(await run(wrapped, "diff"), "makes-tokens https://api.example");
  assert.equal(await run(wrapped, "delete"), "makes-tokens https://api.example");
  // without the token, the provider is as it was
  assert.equal(withCloudflareToken(service, undefined), service);
  assert.equal(await run(service, "delete"), "deploy https://api.example");
});

const ACCOUNT_GROUPS_LOOKED_AT = [
  "AI Gateway Metadata Read",
  "AI Gateway Read",
  "AI Search Metadata Read",
  "AI Search Read",
  "Access: Apps Read",
  "Access: Policies Read",
  "Access: Tags Read",
  "Account Analytics Read",
  "Account Custom Asset Read",
  "Account Custom Error Rules Read",
  "Account Custom Pages Read",
  "Account DNS Settings Read",
  "Account Rule Lists Read",
  "Account Rulesets Read",
  "Account: SSL and Certificates Read",
  "Agents Gateway Read",
  "Artifacts Read",
  "Auto Rag Read",
  "Browser Rendering Read",
  "CF Agents Read",
  "Calls Read",
  "Cloudchamber Read",
  "Cloudflare Tunnel Read",
  "Constellation Read",
  "D1 Metadata Read",
  "Disable ESC Read",
  "Email Routing Account Rules Read",
  "Email Routing Addresses Read",
  "Email Routing Suppressions Read",
  "Email Sending Read",
  "Flagship Read",
  "Hyperdrive Read",
  "Images Metadata Read",
  "Intel Read",
  "K2 Config Read",
  "L4 DDoS Managed Ruleset Read",
  "MCP Portals Read",
  "Magic Firewall Read",
  "Mass URL Redirects Read",
  "Messaging Metadata Read",
  "Messaging Read",
  "MoQ Read",
  "Network Quality Read",
  "Notifications Read",
  "Page Shield Read",
  "Pages Metadata Read",
  "Pages Read",
  "Pipelines Read",
  "Pubsub Configuration Read",
  "Queues Metadata Read",
  "Queues Read",
  "Radar Read",
  "Realtime Read",
  "Registrar Domains Read",
  "Registrar Sandbox Domains Read",
  "Resource Sharing Read",
  "Secrets Store Read",
  "Select Configuration Read",
  "Stream Metadata Read",
  "Transform Rules Read",
  "Vectorize Read",
  "Websearch Metadata Read",
  "Websearch Read",
  "Workers AI Metadata Read",
  "Workers AI Read",
  "Workers CI Read",
  "Workers Containers Read",
  "Workers KV Storage Metadata Read",
  "Workers Observability Read",
  "Workers Observability Write",
  "Workers R2 Data Catalog Read",
  "Workers R2 SQL Read",
  "Workers R2 Storage Metadata Read",
];

const ZONE_GROUPS_LOOKED_AT = [
  "AI Audit Read",
  "Analytics Read",
  "Bot Management Feedback Report Read",
  "Bot Management Read",
  "Cache Settings Read",
  "Cloud Connector Read",
  "Config Settings Read",
  "Custom Errors Read",
  "Custom Pages Read",
  "Disable ESC Read",
  "Domain Page Shield Read",
  "Dynamic URL Redirects Read",
  "Email Routing Rules Read",
  "Email Security DMARC Reports Read",
  "Firewall for AI Read",
  "Load Balancers Read",
  "Managed headers Read",
  "Origin Read",
  "Page Rules Read",
  "Response Compression Read",
  "Sanitize Read",
  "Snippets Read",
  "Waiting Rooms Read",
  "Workers Routes Read",
  "Zone Custom Asset Read",
  "Zone DNS Settings Read",
  "Zone Observability Read",
  "Zone Read",
  "Zone Settings Read",
  "Zone Transform Rules Read",
  "Zone WAF Read",
];
