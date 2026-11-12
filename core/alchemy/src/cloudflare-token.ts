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
  "Workers Scripts Read":
    "a Worker's plain-text bindings, in clear: in a shared account another's API token can be one",
  "Workers Tail Read": "a live tail of any Worker: its requests, their URLs and headers",
  "Turnstile Sites Read": "a Turnstile widget's secret",
  "Account Settings Read": "a Turnstile widget's secret, and a secondary DNS TSIG secret",
} as const;

/** What the token may change. No write makes a lasting export of the account's data, but one:
 *  "Workers Observability Write" can make an observability destination (logs and traces sent to
 *  a URL). It stays because it is also what reads a Worker's logs: Cloudflare's query of them is a
 *  POST that takes no read group, and no narrower group exists. The template's call refuses a
 *  destinations path (core/configs/default/cloudflare.ts); the token itself does not. */
export const CLOUDFLARE_TOKEN_WRITES = [
  "Workers Observability Write",
  "Workers Observability Telemetry Write",
  "Pipelines Write",
  "Pipelines Send",
  "Workers R2 Data Catalog Write",
  "Zone Observability Write",
  "Health Checks Write",
] as const;

/** Groups that iterate Cloud's consent cannot grant. A token that a person's OAuth sign-in makes may
 *  hold only what the sign-in's scopes cover, and Cloudflare refuses the WHOLE token for one group
 *  more, naming each such group: these are the ones it names for the consent's scopes, which ask
 *  nothing for Access, Zero Trust or the network products (internal-packages/installer/worker/
 *  scopes.js says why). The list is fixed, not found at each deploy: a token whose list changes is
 *  updated in place, and an update needs the right to make tokens, which an everyday Update of the
 *  Cloud does not hold. */
export const CLOUDFLARE_TOKEN_NOT_GRANTED_BY_THE_CLOUD = [
  "Access: Audit Logs Read",
  "Access: Custom Pages Read",
  "Access: Device Posture Read",
  "Access: Groups Read",
  "Access: Identity Providers Read",
  "Access: Keys Read",
  "Access: Mutual TLS Certificates Read",
  "Access: Organizations Read",
  "Access: Organizations, Identity Providers, and Groups Read",
  "Access: Policy Test Read",
  "Access: SAML Certificates Read",
  "Access: SCIM Logs Read",
  "Access: SCIM Population Read",
  "Access: SSH Auditing Read",
  "Access: Service Tokens Read",
  "Access: Users Read",
  "Account API Gateway Read",
  "Account Abuse Protection PII Read",
  "Account Firewall Access Rules Read",
  "Account Security Center Insights Read",
  "Account Security Insights Partner Integrations Read",
  "Account WAF Read",
  "Account Waiting Rooms Read",
  "Address Maps Read",
  "Allow Request Tracer Read",
  "Application Security Reports Read",
  "Billing Read",
  "CASB Read",
  "China Network Steering Read",
  "Cloud Email Security: Read",
  "Cloud Workload Security Read",
  "Cloudflare CDS Compute Account Read",
  "Cloudflare DEX Read",
  "Cloudflare One Connector: WARP Read",
  "Cloudflare One Connector: cloudflared Read",
  "Cloudflare One Connectors Read",
  "Cloudflare One Networks Read",
  "Cloudforce One Read",
  "Connectivity Directory Read",
  "DDoS Botnet Feed Read",
  "DDoS Protection Read",
  "DLS: Read",
  "DNS Firewall Read",
  "DNS View Read",
  "Field Extractors Read",
  "Fraud Feedback Read",
  "HTTP Applications Read",
  "IOT Read",
  "IP Prefixes: BGP On Demand Read",
  "IP Prefixes: Read",
  "Load Balancers Account Read",
  "Load Balancing: Monitors and Pools Read",
  "Magic Network Monitoring Config Read",
  "Magic Transit Read",
  "Magic WAN Read",
  "OAuth Client Read",
  "Resource Library Read",
  "Rule Policies Read",
  "SSO Connector Read",
  "Tag Read",
  "Trust and Safety Read",
  "URL Scanner Read",
  "Zero Trust Read",
  "Zero Trust Resilience Read",
  "Zero Trust: PII Read",
] as const;

const ACCOUNT_SCOPE = "com.cloudflare.api.account";
const ZONE_SCOPE = "com.cloudflare.api.account.zone";

/** The token's permission groups among Alchemy's catalog, by the scope of the policy that each
 *  goes in. The catalog lists a renamed group under both of its names: each id counts once. */
export function cloudflareTokenGroupsOf() {
  const leftOut: Record<string, string> = CLOUDFLARE_TOKEN_READS_LEFT_OUT;
  const writes: readonly string[] = CLOUDFLARE_TOKEN_WRITES;
  // by id: a renamed group is in the catalog under both its names
  const notGranted: readonly string[] = CLOUDFLARE_TOKEN_NOT_GRANTED_BY_THE_CLOUD;
  const refusedIds = new Set(
    PERMISSION_GROUPS.filter(({ name }) => notGranted.includes(name)).map(({ id }) => id),
  );
  const held = new Map(
    PERMISSION_GROUPS.filter(
      ({ id, name }) =>
        !refusedIds.has(id) &&
        ((/ read$/i.test(name) && !(name in leftOut)) || writes.includes(name)),
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
