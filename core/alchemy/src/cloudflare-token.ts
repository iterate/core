// cloudflare-token.ts — WHAT THE MIND'S OWN CLOUDFLARE API TOKEN MAY DO (stack.ts makes the token
// when the config says `cloudflareToken: true`).
//
// THE RULE. The account is the mind's sandbox, so the token may debug, profile and configure what
// the account runs: it reads everything of the account and of its zones, and writes the Workers
// platform (scripts and their settings, versions and deployments, Durable Objects, tails, D1, KV,
// R2, queues, containers, AI Gateway, Workers AI, Browser Rendering, observability, pipelines),
// and the zones' DNS records, Workers routes and settings. It reaches nothing beyond the account
// and changes nobody's access: no API token, member, billing, registrar or zone of its own. A
// few reads stay out (`CLOUDFLARE_TOKEN_READS_LEFT_OUT`): secrets of other products, which the
// mind's work does not need. Every member and agent of the mind can use the token: it is the
// mind's, kept in its vault (core/mind-worker/src/context/cloudflare-token.ts).
import * as Cloudflare from "@alchemy.run/cloudflare";
import { PERMISSION_GROUPS, resolvePolicies, type Policy } from "@alchemy.run/cloudflare/ApiToken";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { z } from "zod";

/** A read that the token does not have, and the secret of another product that it would read. */
export const CLOUDFLARE_TOKEN_READS_LEFT_OUT = {
  "Account API Tokens Read": "the account's API tokens; Cloudflare lets no token hold this group",
  "Logs Read": "a Logpush job's destination, with its access keys in clear",
  "Images Read": "the signing keys of Images, in clear",
  "Stream Read": "the webhook's secret and a live input's passphrase, in clear",
  "Access: Apps and Policies Read": "an Access app's SCIM password, token or client secret",
  "SSL and Certificates Read": "a client certificate's private key",
  "Zaraz Read": "the values of Zaraz's variables",
  "Workers AI Custom Models Read": "no credential: Cloudflare no longer lists this group",
  "Turnstile Sites Read": "a Turnstile widget's secret",
} as const;

/** What the token may change: the account's Workers platform, and its zones' DNS records,
 *  routes and settings. Each is covered by a scope that iterate Cloud's consent asks
 *  (internal-packages/installer/worker/scopes.js). Left out on purpose: Account API Tokens,
 *  Account Settings, Billing and Registrar writes, Zone Write (add or delete a zone), and
 *  Notifications and Logs writes (a webhook or a Logpush job: a lasting export to any URL). */
export const CLOUDFLARE_TOKEN_WRITES = [
  // account
  "Workers Scripts Write",
  "Workers Containers Write",
  "D1 Write",
  "Workers KV Storage Write",
  "Workers R2 Storage Write",
  "Queues Write",
  "AI Gateway Write",
  "AI Gateway Run",
  "Workers AI Write",
  "Browser Rendering Write",
  "Workers Observability Write",
  "Workers Observability Telemetry Write",
  "Pipelines Write",
  "Pipelines Send",
  "Workers R2 Data Catalog Write",
  // zone, on the policy for every zone of the account
  "DNS Write",
  "Workers Routes Write",
  "Zone Settings Write",
  "Zone Observability Write",
] as const;

/** Groups that iterate Cloud's consent cannot grant. A token that a person's OAuth sign-in makes may
 *  hold only what the sign-in's scopes cover, and Cloudflare refuses the WHOLE token for one group
 *  more, naming each such group: these are the ones it names for the consent's scopes, which ask
 *  nothing for Access, Zero Trust or the network products (internal-packages/installer/worker/
 *  scopes.js says why). "Billing Read" has no OAuth scope at all (GET /client/v4/oauth/scopes,
 *  13 November 2026). The list is fixed, so that the token's list changes only in a release: a
 *  changed list is an update of the token, which needs the right to make tokens. A group that
 *  Cloudflare refuses all the same is dropped at that deploy (`mindCloudflareTokenProvider`). */
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
  // zone-scoped, on the policy for every zone of the account
  "DNS Read",
  "Domain API Gateway Read",
  "Firewall Services Read",
  "Fraud Detection Read",
  "HTTP DDoS Managed Ruleset Read",
  "Health Checks Read",
  "Health Checks Write",
  "Payments Gateway Read",
  "Precursor Read",
  "Web3 Hostnames Read",
  "Zone Security Center Insights Read",
  "Zone Security Insights Partner Assets Read",
  "Zone Versioning Read",
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

/** The stack's resource id of the mind's token (stack.ts `cloudflareTokenPart`). */
export const MIND_CLOUDFLARE_TOKEN = "MindCloudflareToken";

/** Cloudflare's answer to a token made through a person's OAuth sign-in that asks a group the
 *  sign-in's scopes do not cover. It names the refused groups of one policy, comma-separated. */
const REFUSAL =
  /does not include the scopes required for the requested permission groups:\s*(.+)$/s;

/** At most this many tries of one token: Cloudflare names one policy's refused groups per try, and
 *  the token has two policies. */
const TOKEN_TRIES = 4;

/** `policies` without the groups that Cloudflare's refusal `message` names, by every name the
 *  catalog has for a group. Cloudflare names the groups of one policy, and some names are at both
 *  scopes ("Disable ESC Read"), so the cut is in the one policy that holds the most of them.
 *  Undefined when the message is no such refusal, names none of the groups, or leaves no group. A
 *  policy left with no group goes: Cloudflare takes none such. */
export function withoutRefusedGroups(
  policies: Policy[],
  message: string,
): { policies: Policy[]; refused: string[] } | undefined {
  const named = REFUSAL.exec(message)?.[1]?.trim().replace(/\.$/, "");
  if (!named) return undefined;
  // whole items only: a group's name can hold a comma ("Access: Organizations, Identity …")
  const list = `, ${named}, `;
  const refusedName = (id: string) =>
    PERMISSION_GROUPS.find((group) => group.id === id && list.includes(`, ${group.name}, `))?.name;
  const resolved = resolvePolicies(policies);
  const hits = resolved.map(
    (policy) => policy.permissionGroups.filter(({ id }) => refusedName(id)).length,
  );
  const at = hits.indexOf(Math.max(...hits));
  if (!hits[at]) return undefined;
  const refused: string[] = [];
  const kept = resolved.flatMap((policy, index) => {
    const groups = policy.permissionGroups.filter(({ id }) => {
      const name = index === at && refusedName(id);
      if (name) refused.push(name);
      return !name;
    });
    return groups.length ? [{ ...policy, permissionGroups: groups.map(({ id }) => ({ id })) }] : [];
  });
  if (!kept.length) return undefined;
  // The cast: `resolvePolicies` types a policy's resource keys as plain strings, and Alchemy's
  // `Policy` as its own key type; the keys are the ones this policy came in with, unchanged.
  return { policies: kept as Policy[], refused };
}

type TokenService = Provider.ProviderService<Cloudflare.ApiToken.AccountApiToken>;

/** Alchemy's provider `base` of account API tokens, with two changes for the mind's token alone:
 *
 *  - `keep`: the deploy's access may not change API tokens (an Update of iterate Cloud without the
 *    scope that makes them). A token that exists then stays as it is, and its stored list with it,
 *    so the next deploy with that scope still updates it.
 *  - A group that Cloudflare refuses (`withoutRefusedGroups`) is dropped, and the token is made
 *    with the rest: `say` names each dropped group in the deploy's output. The stack keeps the
 *    list it asked for, so a later deploy asks Cloudflare nothing until a release changes it. */
export function mindCloudflareTokenProvider(
  base: TokenService,
  options: { keep: boolean; say: (line: string) => void },
): TokenService {
  const ours = (id: string) => id === MIND_CLOUDFLARE_TOKEN;
  return {
    ...base,
    diff: (input) =>
      ours(input.id) && options.keep && input.output
        ? Effect.succeed({ action: "noop" as const })
        : base.diff!(input),
    reconcile: (input) => {
      if (!ours(input.id)) return base.reconcile(input);
      const attempt = (
        policies: Policy[],
        refused: string[],
        tries: number,
      ): ReturnType<TokenService["reconcile"]> =>
        base.reconcile({ ...input, news: { ...input.news, policies } }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (refused.length)
                options.say(
                  `[${MIND_CLOUDFLARE_TOKEN}] Cloudflare refused ${refused.length} permission groups that this access to Cloudflare does not cover; the token holds the rest. Refused: ${refused.join(", ")}`,
                );
            }),
          ),
          Effect.catchIf(
            (error: unknown) =>
              tries < TOKEN_TRIES && Boolean(withoutRefusedGroups(policies, messageOf(error))),
            (error: unknown) => {
              const cut = withoutRefusedGroups(policies, messageOf(error))!;
              return attempt(cut.policies, [...refused, ...cut.refused], tries + 1);
            },
          ),
        );
      return attempt(input.news?.policies || [], [], 1);
    },
    // The cast: the object above is Alchemy's own provider with two of its members replaced, and
    // the spread loses the service's type.
  } as TokenService;
}

/** An error's message: Cloudflare's errors through Alchemy carry one. */
const messageOf = (error: unknown) => ErrorWithMessage.safeParse(error).data?.message || "";
const ErrorWithMessage = z.object({ message: z.string() });

/** The provider layer: put it over `Cloudflare.providers()`. `ITERATE_KEEP_CLOUDFLARE_TOKEN=1`
 *  says that this deploy's access may not change API tokens (internal-packages/installer/
 *  container/run.sh sets it). */
export const MindCloudflareTokenProvider = () =>
  Provider.effect(
    Cloudflare.ApiToken.AccountApiToken,
    Effect.gen(function* () {
      const base = yield* Cloudflare.ApiToken.AccountApiToken.Provider;
      return mindCloudflareTokenProvider(base, {
        keep: process.env.ITERATE_KEEP_CLOUDFLARE_TOKEN === "1",
        say: (line) => console.log(line),
      });
    }),
  ).pipe(Layer.provide(Cloudflare.ApiToken.AccountApiTokenProvider()));
