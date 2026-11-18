// cloudflare-access.ts — `iterate deploy`'S ACCESS TO A PERSON'S CLOUDFLARE ACCOUNT, with no server
// of iterate's in between. `CLOUDFLARE_API_TOKEN` is used as it stands. Without it the person
// signs in at Cloudflare with the device flow (RFC 8628): this process shows a code and a page,
// the person approves in any browser, and Cloudflare gives this process an access token.
//
// The OAuth client is the `cf` CLI's public one, which Alchemy's own `alchemy login` uses too
// (@alchemy.run/cloudflare `Auth/OAuthClient.ts`): it has no secret, so nothing here is one.
// There is no `offline_access`: the token lives about an hour and nothing renews it. It is kept
// in the CLI's config folder (mode 600) so that a second run needs no second approval, and the
// deploy that works revokes and forgets it.
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

/** What a deploy of a mind's stack needs (core/alchemy README, "The API token"), and what this
 *  command's own steps need: the person, their accounts, the plan's checks, the domains and their
 *  prices. Nothing here spends money or adds a zone: a domain is bought or added on Cloudflare's
 *  own page. The scope that makes API tokens (`account_api_tokens:create`, which Cloudflare lists
 *  as sensitive) is not asked for, so a deploy with this access has no telemetry and no Cloudflare
 *  token for the mind. */
const SCOPES = [
  "user-details.read",
  "account-settings.read",
  "memberships.read",
  "workers-scripts.write",
  "workers-kv-storage.write",
  "workers-r2.write",
  "d1.write",
  "containers.write",
  "cloudchamber.write",
  "artifacts.write",
  "ai.write",
  "browser-rendering.write",
  "email-sending.write",
  "email-routing-rule.write",
  "queues.write",
  "secrets-store.write",
  "zone.read",
  "zone-settings.write",
  "workers-routes.write",
  "dns.write",
  "registrar-domains.read",
];

export type Access = {
  token: string;
  /** Where it is from: the environment's is the caller's own, and is never revoked here. */
  from: "environment" | "sign-in";
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
  error: z.string().optional(),
  error_description: z.string().optional(),
});
type OAuthAnswer = z.infer<typeof OAuthAnswer>;
const Kept = z.object({ token: z.string(), expiresAt: z.number() });

/** JSON text as `schema`, or undefined for text that is none. */
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
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

function kept(): string | undefined {
  if (!existsSync(KEPT)) return undefined;
  const before = parsed(Kept, readFileSync(KEPT, "utf8"));
  return before && before.expiresAt - Date.now() > LEAST_LEFT_MS ? before.token : undefined;
}

/** Forgets the kept token, and asks Cloudflare to revoke it. Never throws. */
export async function endAccess(access: Access) {
  if (access.from !== "sign-in") return;
  rmSync(KEPT, { force: true });
  await form(`${OAUTH}/revoke`, { token: access.token, client_id: CLIENT_ID }).catch(() => {});
}

/** A token for Cloudflare's API: the environment's, the kept one, or a new sign-in, for which
 *  `show` gets the page to open and the code the person checks there. `fresh` skips the kept one. */
export async function cloudflareAccess(
  show: (page: { url: URL; code: string; minutes: number }) => void,
  fresh = false,
): Promise<Access> {
  const given = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (given) return { token: given, from: "environment" };
  const before = fresh ? undefined : kept();
  if (before) return { token: before, from: "sign-in" };

  const asked = await form(`${OAUTH}/device/auth`, {
    client_id: CLIENT_ID,
    scope: SCOPES.join(" "),
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
      mkdirSync(dirname(KEPT), { recursive: true, mode: 0o700 });
      writeFileSync(
        KEPT,
        JSON.stringify({
          token: answer.access_token,
          expiresAt: Date.now() + (answer.expires_in || 3600) * 1000,
        }),
        { mode: 0o600 },
      );
      chmodSync(KEPT, 0o600);
      return { token: answer.access_token, from: "sign-in" };
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
