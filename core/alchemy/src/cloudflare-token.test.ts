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
  CLOUDFLARE_TOKEN_NOT_GRANTED_BY_THE_CLOUD,
  CLOUDFLARE_TOKEN_READS_LEFT_OUT,
  CLOUDFLARE_TOKEN_WRITES,
  cloudflareTokenGroupsOf,
  cloudflareTokenPoliciesOf,
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
  const writes: readonly string[] = CLOUDFLARE_TOKEN_WRITES;
  for (const { name } of held) assert.ok(/ read$/i.test(name) || writes.includes(name), name);
  for (const name of writes) assert.ok(names.has(name), name);
});

void test("the token debugs, profiles and configures what the account runs", () => {
  for (const name of [
    "Workers Scripts Write",
    "Workers Tail Read",
    "Workers Observability Write",
    "D1 Write",
    "Workers KV Storage Write",
    "Workers R2 Storage Write",
    "Queues Write",
    "AI Gateway Write",
    "Workers AI Write",
    "Browser Rendering Write",
    "DNS Write",
    "Workers Routes Write",
    "Zone Settings Write",
    "Email Sending Read",
    "Email Routing Rules Read",
  ])
    assert.ok(names.has(name), name);
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

// A catalog that gains or loses a read group changes these numbers. Before you change them, ask
// of each new read whether it reads another product's secret (CLOUDFLARE_TOKEN_READS_LEFT_OUT).
// Then see internal-packages/installer/worker/scopes.js `CLOUDFLARE_TOKEN_EDITION`.
void test("the token's groups are as many as were looked at, and none is there twice", () => {
  assert.equal(groups.account.length, 93);
  assert.equal(groups.zone.length, 35);
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
  const cut = withoutRefusedGroups(policies, refusal(["Workers Scripts Write", "D1 Read"]));
  assert.deepEqual(cut?.refused, ["D1 Read", "Workers Scripts Write"]);
  assert.equal(idsOf(cut!.policies).length, held.length - 2);
  assert.ok(!idsOf(cut!.policies).includes(idOf("Workers Scripts Write")));
  // "D1 Read" is a whole item, not a piece of "D1 Metadata Read"
  assert.ok(idsOf(cut!.policies).includes(idOf("D1 Metadata Read")));
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
  const alchemy = pretendAlchemy([["Workers Scripts Write"], ["DNS Write", "Zone Settings Write"]]);
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
  assert.match(said[0]!, /Workers Scripts Write, DNS Write, Zone Settings Write$/);
});

void test("another error, another token, or a refusal without end, fails as Cloudflare said", async () => {
  const say = () => assert.fail("nothing to say");
  const other = pretendAlchemy([["Workers Scripts Write"]]);
  const exit = await Effect.runPromiseExit(
    mindCloudflareTokenProvider(other.service, { keep: false, say }).reconcile(
      input("TelemetryCatalogToken"),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  assert.equal(other.tries.length, 1);
  const endless = pretendAlchemy([
    ["D1 Read"],
    ["D1 Write"],
    ["Queues Write"],
    ["Queues Read"],
    ["KV"],
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
