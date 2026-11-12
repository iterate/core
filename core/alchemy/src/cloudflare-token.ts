// cloudflare-token.ts — WHAT THE MIND'S OWN CLOUDFLARE API TOKEN MAY DO (stack.ts makes the token
// when the config says `cloudflareToken: true`).
//
// THE RULE. The token reads everything of its account and of the account's zones, except what
// yields a credential that can do more than the token itself. It writes observability, telemetry,
// pipelines and alerts. It deploys nothing: it has no write of Workers scripts, routes,
// containers, builds or Pages, no write of DNS, a zone, the registrar or a setting, and nothing
// of the account's API tokens. So what holds the token can look at the whole account and cannot
// become more than it is.
import { PERMISSION_GROUPS, type Policy } from "@alchemy.run/cloudflare/ApiToken";

/** A read that the token does not have, and the stronger credential that the read could yield. */
export const CLOUDFLARE_TOKEN_READS_LEFT_OUT = {
  "Account API Tokens Read": "the account's API tokens; Cloudflare lets no token hold this group",
  "D1 Read": "it runs SELECT on any database: the stack's own private key is in the auth Worker's",
  "Workers KV Storage Read":
    "the values of any namespace: the auth Worker's OAuth grants, and the live Cloudflare sign-ins of an iterate Cloud in the same account",
  "Workers R2 Storage Read": "the objects of any bucket of the account, whatever they hold",
  "Logs Read": "a Logpush job's destination, with its access keys in clear",
  "Images Read": "the signing keys of Images, in clear",
  "Stream Read": "the webhook's secret and a live input's passphrase, in clear",
  "Access: Apps and Policies Read": "an Access app's SCIM password, token or client secret",
  "SSL and Certificates Read": "a client certificate's private key",
  "Zaraz Read": "the values of Zaraz's variables",
  "Workers AI Custom Models Read": "no credential: Cloudflare no longer lists this group",
} as const;

/** What the token may change. "Workers Observability Write" is also what reads a Worker's logs:
 *  Cloudflare's query of them is a POST that takes no read group. */
export const CLOUDFLARE_TOKEN_WRITES = [
  "Workers Observability Write",
  "Workers Observability Telemetry Write",
  "Pipelines Write",
  "Pipelines Send",
  "Workers R2 Data Catalog Write",
  "Zone Observability Write",
  "Notifications Write",
  "Health Checks Write",
] as const;

const ACCOUNT_SCOPE = "com.cloudflare.api.account";
const ZONE_SCOPE = "com.cloudflare.api.account.zone";

/** The token's permission groups among Alchemy's catalog, by the scope of the policy that each
 *  goes in. The catalog lists a renamed group under both of its names: each id counts once. */
export function cloudflareTokenGroupsOf() {
  const leftOut: Record<string, string> = CLOUDFLARE_TOKEN_READS_LEFT_OUT;
  const writes: readonly string[] = CLOUDFLARE_TOKEN_WRITES;
  const held = new Map(
    PERMISSION_GROUPS.filter(
      ({ name }) => (/ read$/i.test(name) && !(name in leftOut)) || writes.includes(name),
    ).map((group) => [group.id, group]),
  );
  const scoped = (scope: string) => [...held.values()].filter(({ scopes }) => scopes[0] === scope);
  return { account: scoped(ACCOUNT_SCOPE), zone: scoped(ZONE_SCOPE) };
}

/** The token's two policies: the account's groups on the account, and the zones' groups on every
 *  zone of it. Each group goes by its id: the catalog has some names at both scopes. */
export function cloudflareTokenPoliciesOf(accountId: string): Policy[] {
  const groups = cloudflareTokenGroupsOf();
  const account = `${ACCOUNT_SCOPE}.${accountId}`;
  return [
    {
      effect: "allow",
      permissionGroups: groups.account.map(({ id }) => ({ id })),
      resources: { [account]: "*" },
    },
    {
      effect: "allow",
      permissionGroups: groups.zone.map(({ id }) => ({ id })),
      resources: { [account]: { [`${ZONE_SCOPE}.*`]: "*" } },
    },
  ];
}
