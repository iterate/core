// cloudflare-access.ts — `iterate deploy`'S AND `iterate recover`'S ACCESS TO A PERSON'S CLOUDFLARE
// ACCOUNT, with no server of iterate's in between. `CLOUDFLARE_API_TOKEN` is used as it stands.
// Without it the person signs in at Cloudflare with the device flow (RFC 8628): this process
// shows a code and a page, the person approves in any browser, and Cloudflare gives this process
// an access token.
//
// The OAuth client is the `cf` CLI's public one, which Alchemy's own `alchemy login` uses too
// (@alchemy.run/cloudflare `Auth/OAuthClient.ts`): it has no secret, so nothing here is one.
// There is no `offline_access`: the token lives about an hour and nothing renews it. It is kept
// in the CLI's config folder (mode 600) so that a second run needs no second approval, and the
// command that works revokes and forgets it.
//
// A SCOPE HERE IS A PERMISSION GROUP OF AN API TOKEN UNDER ANOTHER SPELLING: `workers-scripts.write`
// is "Workers Scripts Write" (`GET /oauth/scopes` lists each pair). So one list says what a
// sign-in asks for, and what an API token that a person makes instead must hold (`apiTokenPage`).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { CONFIG_PATH } from "./config.ts";

// allow-high-entropy-next-line: the id of Cloudflare's public OAuth client for CLIs, no secret
const CLIENT_ID = "cbca97e7-c331-4cdd-8fd8-e25a451b98bf";
const OAUTH = "https://dash.cloudflare.com/oauth2";
const KEPT = join(dirname(CONFIG_PATH), "cloudflare-access.json");
/** A kept token must live this long still: a run needs it for its checks and its deploy. */
const LEAST_LEFT_MS = 20 * 60_000;

/** THE SCOPE THAT MAKES API TOKENS OF THE ACCOUNT. Cloudflare's page shows it as "Account API
 *  Token Provisioning", marks it sensitive and leaves it unticked, so a person who approves the
 *  page as it opens grants everything but this. */
export const MAKES_API_TOKENS = "account_api_tokens:create";

/** WHAT ONE DEPLOY OF THE STACK NEEDS: a scope for each kind of resource that
 *  core/alchemy/src/stack.ts declares, and for nothing else. A Worker's bindings to Workers AI,
 *  Browser Rendering, Images and Analytics Engine are part of its upload and need no scope of
 *  their own. */
export const STACK_SCOPES = [
  // the five Workers with their Durable Objects, the Worker that holds the stack's state, and
  // the telemetry Worker's workers.dev address
  "workers-scripts.write",
  // the auth Worker's and the mind's KV namespaces
  "workers-kv-storage.write",
  // the auth Worker's database and its migrations
  "d1.write",
  // the files bucket and the telemetry bucket
  "workers-r2.write",
  // the telemetry bucket's data catalog, and the catalog token's own right to it
  "r2-catalog.write",
  // telemetry's streams, sinks and pipelines
  "pipelines.write",
  // the queue of Cloudflare events, its consumer and its event subscriptions
  "queues.write",
  // the two destinations that the Workers' logs and spans are exported to
  "workers-observability.write",
  // the repos' namespace, and the config repo's event subscription
  "artifacts.write",
  // the sandboxes' container application
  "containers.write",
  // the two secrets of the Worker that holds the stack's state
  "secrets-store.write",
  // Zero Trust: the account's organization and its one-time PIN login
  "access-acct.write",
  // Zero Trust: the application that proves an owner's address, with its policy
  "access.write",
  // mail in: Email Routing turned on for each zone, which is a setting of the zone
  "zone-settings.write",
  // mail in: the catch-all rule that hands each zone's mail to the boundary
  "email-routing-rule.write",
  // mail out: each zone as a sending domain
  "email-sending.write",
  // each zone, found by its name
  "zone.read",
  // the boundary's two routes on each zone
  "workers-routes.write",
  // the apex and wildcard records of each zone
  "dns.write",
  // the Realtime SFU app and the TURN key that a call app uses. Not the only permission that
  // makes them: "Realtime" or "Realtime Admin" does too (core/alchemy src/realtime.ts)
  "calls.write",
  // telemetry's two API tokens of the account
  MAKES_API_TOKENS,
  // What those two tokens hold beside the catalog's write: a token made through a sign-in may
  // hold only permissions that the sign-in's own scopes cover.
  "workers-r2-bucket-item.write",
  "r2-catalog-sql.read",
  "account-analytics.read",
];

/** WHAT `iterate deploy` ASKS A SIGN-IN FOR: the stack's scopes, and those of the command's own
 *  steps. Nothing here adds a zone: a domain from another registrar is added on Cloudflare's own
 *  page. The command's other calls need no scope beyond the stack's: the zone's routes and
 *  records (read, and erased after a yes), the account's workers.dev name, whether Workers Paid
 *  and R2 are on, and a deployed mind's config, which is in its boundary Worker's settings. */
export const DEPLOY_SCOPES = [
  // the person: their address is the owner's, and their name makes the domain names offered
  "user-details.read",
  // the person's accounts, and which of them the approval covers
  "memberships.read",
  "account-settings.read",
  // which domains Cloudflare's registrar sells, and for how much
  "registrar-domains.read",
  // the purchase of a domain, which the command makes only after a yes to its price
  "registrar-domains.admin",
  ...STACK_SCOPES,
];

/** WHAT `iterate recover` ASKS FOR: the reads that find the mind (its zone with the zone's
 *  account, the zone's routes, the boundary Worker's settings), and D1's write for the two
 *  statements. */
export const RECOVER_SCOPES = [
  "zone.read",
  "workers-routes.read",
  "workers-scripts.read",
  "d1.write",
];

/** The scopes of `asked` that a sign-in did not grant. `granted` is the token answer's `scope`:
 *  with none, everything asked for was granted (RFC 6749 §5.1). */
export const scopesLacking = (asked: readonly string[], granted: string | undefined) =>
  granted ? asked.filter((scope) => !granted.split(/\s+/).includes(scope)) : [];

/** CLOUDFLARE'S OWN PAGE THAT MAKES AN API TOKEN OF AN ACCOUNT, with the stack's permissions
 *  filled in: for a person who does not let a sign-in make API tokens. The person chooses the
 *  account, presses Create, and pastes the token into the command. Each permission is named by
 *  its key, which is the scope's own name with `_` for each `-`, and by `read` or `edit`
 *  (https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
 *  The page names in a notice each key that it does not know. */
export function apiTokenPage() {
  const page = new URL("https://dash.cloudflare.com/?to=/:account/api-tokens");
  page.searchParams.set(
    "permissionGroupKeys",
    JSON.stringify([
      ...STACK_SCOPES.map((scope) => ({
        key: scope.replace(/[.:][a-z]+$/, "").replaceAll("-", "_"),
        type: scope.endsWith(".read") ? "read" : "edit",
      })),
      // "OAuth Client Write", which makes the stack's own OAuth client (core/alchemy
      // src/cloudflare-oauth-client.ts). No OAuth scope names it, so it has no short key: the
      // page takes a permission group's id too (the id read from the dev account's
      // permission_groups, 18 Nov 2026; not yet tried on the page itself).
      // the group's id (Cloudflare calls a group id canonical)
      // allow-high-entropy-next-line: the id of a Cloudflare permission group, public and the same in every account
      { key: "50fc2f43318f40e4855a35d8de5bf643", type: "edit" },
    ]),
  );
  page.searchParams.set("name", "iterate deploy");
  return page;
}

export type Access = {
  token: string;
  /** Where it is from: the environment's is the caller's own, and is never revoked here. */
  from: "environment" | "sign-in";
  /** The scopes asked for that the sign-in did not grant. None is known of a token from the
   *  environment. */
  lacks: string[];
};
/** What Cloudflare's OAuth server answers, at its device, token and revoke endpoints. */
const OAuthAnswer = z.object({
  device_code: z.string().optional(),
  user_code: z.string().optional(),
  verification_uri: z.string().optional(),
  verification_uri_complete: z.string().optional(),
  interval: z.number().optional(),
  expires_in: z.number().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
type OAuthAnswer = z.infer<typeof OAuthAnswer>;
/** `scopes`: what the sign-in asked for. A token from a sign-in that asked for other scopes is
 *  not used: it may lack a right that this command needs. */
const Kept = z.object({
  token: z.string(),
  expiresAt: z.number(),
  scopes: z.string(),
  lacks: z.array(z.string()),
});

/** JSON text as `schema`, or undefined for text that is none. */
export function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    return schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/** POST a form to Cloudflare's OAuth server: its JSON, or `{ error }` for an answer that is none. */
async function form(url: string, fields: Record<string, string>): Promise<OAuthAnswer> {
  const answer = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const said = parsed(OAuthAnswer, await answer.text());
  if (said) return said;
  if (answer.ok) return {};
  return { error: answer.status >= 500 ? "temporarily_unavailable" : `HTTP ${answer.status}` };
}

/** Forgets the kept token, and asks Cloudflare to revoke it. Never throws. */
export async function endAccess(access: Access) {
  if (access.from !== "sign-in") return;
  rmSync(KEPT, { force: true });
  await form(`${OAUTH}/revoke`, { token: access.token, client_id: CLIENT_ID }).catch(() => {});
}

/** A token for Cloudflare's API: the environment's, the kept one of a sign-in that asked for
 *  these `scopes`, or a new sign-in, for which `show` gets the page to open and the code the
 *  person checks there. `fresh` skips the kept one. */
export async function cloudflareAccess(
  scopes: readonly string[],
  show: (page: { url: URL; code: string; minutes: number }) => void,
  fresh = false,
): Promise<Access> {
  const given = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (given) return { token: given, from: "environment", lacks: [] };
  const before = !fresh && existsSync(KEPT) ? parsed(Kept, readFileSync(KEPT, "utf8")) : undefined;
  if (before && before.scopes === scopes.join(" ") && before.expiresAt - Date.now() > LEAST_LEFT_MS)
    return { token: before.token, from: "sign-in", lacks: before.lacks };

  const asked = await form(`${OAUTH}/device/auth`, {
    client_id: CLIENT_ID,
    scope: scopes.join(" "),
  });
  if (!asked.device_code || !asked.user_code || !asked.verification_uri)
    throw new Error(
      `Cloudflare started no sign-in: ${asked.error_description || asked.error || "an answer with no code"}`,
    );
  // the server names the page: only its own, over https (RFC 8628 §5.4)
  const url = new URL(asked.verification_uri_complete || asked.verification_uri);
  if (url.protocol !== "https:" || url.host !== "dash.cloudflare.com")
    throw new Error(`Cloudflare named a sign-in page that is not its own: ${url.href}`);
  const seconds = asked.expires_in || 300;
  show({ url, code: asked.user_code, minutes: Math.round(seconds / 60) });

  let interval = Math.max(asked.interval || 5, 1);
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    await sleep(interval * 1000);
    const answer = await form(`${OAUTH}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: asked.device_code,
      client_id: CLIENT_ID,
    });
    if (answer.access_token) {
      // none was asked for: one that comes all the same is ended at once
      if (answer.refresh_token)
        await form(`${OAUTH}/revoke`, { token: answer.refresh_token, client_id: CLIENT_ID }).catch(
          () => {},
        );
      const lacks = scopesLacking(scopes, answer.scope);
      mkdirSync(dirname(KEPT), { recursive: true, mode: 0o700 });
      writeFileSync(
        KEPT,
        JSON.stringify({
          token: answer.access_token,
          expiresAt: Date.now() + (answer.expires_in || 3600) * 1000,
          scopes: scopes.join(" "),
          lacks,
        }),
        { mode: 0o600 },
      );
      chmodSync(KEPT, 0o600);
      return { token: answer.access_token, from: "sign-in", lacks };
    }
    if (answer.error === "slow_down") interval += 5;
    else if (answer.error !== "authorization_pending" && answer.error !== "temporarily_unavailable")
      throw new Error(
        `Cloudflare refused the sign-in: ${answer.error_description || answer.error}`,
      );
  }
  throw new Error("Nobody approved the sign-in at Cloudflare in time. Run the command again.");
}

/** The envelope of every answer of Cloudflare's API. */
const Envelope = z.object({
  result: z.unknown().optional(),
  result_info: z.object({ total_count: z.number().optional() }).nullish(),
  errors: z
    .array(z.object({ code: z.number().optional(), message: z.string().optional() }))
    .nullish(),
});
export type Answer = { status: number; result: unknown; total: number; error: string };
export type Cloudflare = (method: string, path: string, body?: unknown) => Promise<Answer>;

/** `answer.result` as `schema`, or undefined when Cloudflare sent something else. */
export const resultOf = <T>(schema: z.ZodType<T>, answer: Answer): T | undefined =>
  schema.safeParse(answer.result).data;

/** One request to Cloudflare's API with `token`: the status, `result`, the list's total count, and
 *  Cloudflare's errors as one line. It never throws for a status: the caller reads it. */
export const cloudflare =
  (token: string): Cloudflare =>
  async (method, path, body) => {
    const answer = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await answer.text();
    const said = parsed(Envelope, text);
    const errors = (said?.errors || [])
      .map((error) => `${error.message || ""}${error.code ? ` (code ${error.code})` : ""}`)
      .join("; ");
    return {
      status: answer.status,
      result: said?.result,
      total: said?.result_info?.total_count ?? 0,
      error: errors || text.slice(0, 200),
    };
  };
