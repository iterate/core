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
// A KEPT SIGN-IN is the way to deploy with nobody at Cloudflare's page: `iterate cloudflare
// sign-in` asks the same client for the deploy's scopes and `offline_access`, and keeps the access
// and refresh tokens in one file (or prints them for a secret store). `iterate deploy` with
// ITERATE_CLOUDFLARE_SIGN_IN_FILE uses it as a sign-in, renews it, and writes each renewal back
// to that file before it uses it: Cloudflare replaces the refresh token at each renewal, so a
// renewal that is not written is lost, and the file's earlier one is then stale.
//
// A SCOPE HERE IS A PERMISSION GROUP OF AN API TOKEN UNDER ANOTHER SPELLING: `workers-scripts.write`
// is "Workers Scripts Write" (`GET /oauth/scopes` lists each pair). One list says what a sign-in
// asks for.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** WHAT ONE DEPLOY OF THE STACK NEEDS: a scope for each kind of resource that
 *  core/alchemy/src/stack.ts declares, and for nothing else. A Worker's bindings to Workers AI,
 *  Browser Rendering, Images and Analytics Engine are part of its upload and need no scope of
 *  their own. The deploy makes no telemetry token: the mind turns its tables on itself. */
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
  // turning on the telemetry bucket's data catalog
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

export type Access = {
  token: string;
  /** Where it is from: the environment's is the caller's own, and is never revoked here. */
  from: "environment" | "sign-in";
  /** The scopes asked for that the sign-in did not grant. None is known of a token from the
   *  environment. */
  lacks: string[];
  /** The file of a kept sign-in (`iterate cloudflare sign-in`): the caller's, so never revoked or
   *  forgotten here, and never replaced by a new sign-in, since nobody may be at the page. */
  keptIn?: string;
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

/** Asks Cloudflare to revoke `token`: Cloudflare's error, or undefined when it took the request.
 *  Never throws. */
const revoke = async (token: string | undefined) =>
  token
    ? (
        await form(`${OAUTH}/revoke`, { token, client_id: CLIENT_ID }).catch((error: unknown) => ({
          error: String(error),
        }))
      ).error
    : undefined;

/** Forgets the kept token, and asks Cloudflare to revoke it. Never throws. A kept sign-in of
 *  `iterate cloudflare sign-in` stays: it is the caller's. */
export async function endAccess(access: Access) {
  if (access.from !== "sign-in" || access.keptIn) return;
  rmSync(KEPT, { force: true });
  await revoke(access.token);
}

/** THE DEVICE FLOW: Cloudflare's answer with an access token, once the person approved. `show`
 *  gets the page to open and the code the person checks there. */
async function deviceSignIn(
  scopes: readonly string[],
  show: (page: { url: URL; code: string; minutes: number }) => void | Promise<void>,
): Promise<OAuthAnswer & { access_token: string }> {
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
  const end = Date.now() + seconds * 1000;
  await show({ url, code: asked.user_code, minutes: Math.round(seconds / 60) });

  let interval = Math.max(asked.interval || 5, 1);
  while (Date.now() < end) {
    await sleep(interval * 1000);
    const answer = await form(`${OAUTH}/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: asked.device_code,
      client_id: CLIENT_ID,
    });
    if (answer.access_token) return { ...answer, access_token: answer.access_token };
    if (answer.error === "slow_down") interval += 5;
    else if (answer.error !== "authorization_pending" && answer.error !== "temporarily_unavailable")
      throw new Error(
        `Cloudflare refused the sign-in: ${answer.error_description || answer.error}`,
      );
  }
  throw new Error("Nobody approved the sign-in at Cloudflare in time. Run the command again.");
}

/** A token for Cloudflare's API: the environment's, the kept sign-in in the file `keptIn`, the
 *  kept one of a sign-in that asked for these `scopes`, or a new sign-in, for which `show` gets the
 *  page to open and the code the person checks there. `fresh` skips the token in the config
 *  folder. */
export async function cloudflareAccess(
  scopes: readonly string[],
  show: (page: { url: URL; code: string; minutes: number }) => void | Promise<void>,
  fresh = false,
  keptIn?: string,
): Promise<Access> {
  const given = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (keptIn) {
    if (given)
      throw new Error(
        `Both CLOUDFLARE_API_TOKEN and ${SIGN_IN_FILE} are set, and each is a way into the account. Unset one.`,
      );
    return keptAccess(keptIn, scopes);
  }
  if (given) return { token: given, from: "environment", lacks: [] };
  const before = !fresh && existsSync(KEPT) ? parsed(Kept, readFileSync(KEPT, "utf8")) : undefined;
  if (before && before.scopes === scopes.join(" ") && before.expiresAt - Date.now() > LEAST_LEFT_MS)
    return { token: before.token, from: "sign-in", lacks: before.lacks };

  const answer = await deviceSignIn(scopes, show);
  // none was asked for: one that comes all the same is ended at once
  await revoke(answer.refresh_token);
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

// ---------------------------------------------------------------------------------------------
// A kept sign-in: `iterate cloudflare sign-in`, `iterate cloudflare sign-out`, and the deploy's
// use of one with nobody at Cloudflare's page.

/** THE ENVIRONMENT VARIABLE THAT NAMES THE FILE OF A KEPT SIGN-IN for `iterate deploy`. A path and
 *  no token: the command rewrites the file at each renewal. It is a variable and no flag, as
 *  `CLOUDFLARE_API_TOKEN` is. */
export const SIGN_IN_FILE = "ITERATE_CLOUDFLARE_SIGN_IN_FILE";

/** THE EXIT CODE OF A COMMAND WHOSE KEPT SIGN-IN NO LONGER WORKS: a person must sign in again.
 *  Any other failure exits 1. */
export const SIGN_IN_ENDED_EXIT = 3;

/** A kept sign-in that no longer works, or that the command could not keep: it stops the command
 *  with SIGN_IN_ENDED_EXIT. */
export class SignInEnded extends Error {}

/** A KEPT SIGN-IN AT CLOUDFLARE, as one JSON document: the file of `iterate cloudflare sign-in
 *  --file`, or what `--print` prints for a secret store. It can do everything that a deploy can,
 *  until it is signed out of. `scopes`: what the sign-in asked for, `offline_access` aside;
 *  `lacks`: what Cloudflare said it did not grant. */
export const KeptSignIn = z.object({
  kind: z.literal("iterate-cloudflare-sign-in"),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  scopes: z.string(),
  lacks: z.array(z.string()),
  signedInAt: z.string(),
  renewedAt: z.string().optional(),
});
export type KeptSignIn = z.infer<typeof KeptSignIn>;

/** Whether a kept sign-in's access token serves a run as it is, or is renewed first. */
export const keptSignInStep = (kept: KeptSignIn, now: number) =>
  kept.expiresAt - now > LEAST_LEFT_MS ? ("use" as const) : ("renew" as const);

/** What Cloudflare's answer to a renewal means: the renewed sign-in, or why there is none, and
 *  whether the sign-in has `ended` (Cloudflare refused the grant, `invalid_grant`: a person signs in again) or
 *  may work on a later try (an outage, an answer that was no OAuth answer). Each renewal REPLACES
 *  the refresh token (measured, 18 Nov 2026): the renewed sign-in holds the new one. */
export function renewedSignIn(
  kept: KeptSignIn,
  answer: OAuthAnswer,
  now: number,
): { renewed: KeptSignIn } | { ended: boolean; why: string } {
  if (answer.access_token)
    return {
      renewed: {
        ...kept,
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token || kept.refreshToken,
        expiresAt: now + (answer.expires_in || 3600) * 1000,
        lacks: answer.scope ? scopesLacking(kept.scopes.split(" "), answer.scope) : kept.lacks,
        renewedAt: new Date(now).toISOString(),
      },
    };
  const error = answer.error || "an answer with no token";
  // only the grant's own refusal ends it (RFC 6749 §5.2): any other answer may pass
  return {
    ended: error === "invalid_grant",
    why: answer.error_description ? `${error}: ${answer.error_description}` : error,
  };
}

/** Whether the text of a lock file names a process that is alive. */
export const lockHeld = (text: string, alive: (pid: number) => boolean) => {
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && alive(pid);
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** The files that this process holds the lock of, until it exits. */
const locked = new Set<string>();

/** ONE COMMAND AT A TIME ON A KEPT SIGN-IN: two that renewed it at once would each get a refresh
 *  token, and only the one written last is kept. The lock is `<file>.lock`, made only if it is not
 *  there, with this process's id; a lock whose process is gone is taken over. */
export function lockKept(file: string) {
  if (locked.has(file)) return;
  const lock = `${file}.lock`;
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      locked.add(file);
      process.once("exit", () => rmSync(lock, { force: true }));
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const holder = existsSync(lock) ? readFileSync(lock, "utf8") : "";
    if (lockHeld(holder, alive))
      throw new Error(
        `Another command (process ${holder.trim()}) uses the kept sign-in in ${file}. Two at once would each renew it, and Cloudflare keeps only the last renewal. Run one at a time.`,
      );
    rmSync(lock, { force: true });
  }
  throw new Error(`Could not take the lock ${lock}.`);
}

/** Writes a kept sign-in to `file`, mode 600: a new file, or (`replace`) through a temporary
 *  file beside it and a rename, so that the file holds the earlier sign-in or the new one whole. */
export function writeKeptSignIn(file: string, kept: KeptSignIn, replace = false) {
  const text = `${JSON.stringify(kept, null, 2)}\n`;
  if (!replace) {
    writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** THE ACCESS OF A KEPT SIGN-IN: its access token, renewed first when it has too little left. The
 *  renewal is written to the file before anything uses it. */
async function keptAccess(file: string, scopes: readonly string[]): Promise<Access> {
  lockKept(file);
  const again = `Sign in again: iterate cloudflare sign-in --file ${file} (or --print, for a secret store).`;
  const kept = existsSync(file) ? parsed(KeptSignIn, readFileSync(file, "utf8")) : undefined;
  if (!kept)
    throw new SignInEnded(
      `${SIGN_IN_FILE} names ${file}, which holds no sign-in of iterate cloudflare sign-in. ${again}`,
    );
  const missing = scopes.filter((scope) => !kept.scopes.split(" ").includes(scope));
  if (missing.length > 0)
    throw new SignInEnded(
      `The kept sign-in in ${file} did not ask for ${missing.join(", ")}, which this version of the command needs. Sign out of it (iterate cloudflare sign-out --file ${file}), then sign in with this version.`,
    );
  if (keptSignInStep(kept, Date.now()) === "use")
    return { token: kept.accessToken, from: "sign-in", lacks: kept.lacks, keptIn: file };

  const answer = await form(`${OAUTH}/token`, {
    grant_type: "refresh_token",
    refresh_token: kept.refreshToken,
    client_id: CLIENT_ID,
  }).catch((error: unknown) => ({
    error: "temporarily_unavailable",
    error_description: String(error),
  }));
  const next = renewedSignIn(kept, answer, Date.now());
  if (!("renewed" in next)) {
    if (next.ended)
      throw new SignInEnded(
        `The kept sign-in at Cloudflare in ${file} no longer works (Cloudflare: ${next.why}). ${again}`,
      );
    throw new Error(
      `Cloudflare did not renew the kept sign-in in ${file} (${next.why}). The file is unchanged. Run the command again later.`,
    );
  }
  // THE RENEWAL IS KEPT FIRST: the file's earlier refresh token is stale from here on
  try {
    writeKeptSignIn(file, next.renewed, true);
  } catch (error) {
    const elsewhere = join(
      dirname(CONFIG_PATH),
      `cloudflare-sign-in-renewed-${new Date().toISOString().replaceAll(":", "-")}.json`,
    );
    const stale = `Cloudflare renewed the kept sign-in, and it could not be written to ${file} (${error instanceof Error ? error.message : String(error)}). The sign-in in ${file} is stale now: Cloudflare replaced its refresh token.`;
    try {
      mkdirSync(dirname(elsewhere), { recursive: true, mode: 0o700 });
      writeKeptSignIn(elsewhere, next.renewed);
    } catch {
      // nobody holds it: it is ended, so that no live sign-in is left where nobody can end it
      await revoke(next.renewed.refreshToken);
      await revoke(next.renewed.accessToken);
      throw new SignInEnded(
        `${stale} Nor could it be written to ${elsewhere}, so it is revoked. ${again}`,
      );
    }
    throw new SignInEnded(
      `${stale} The renewed one is in ${elsewhere}: put it where ${file}'s came from, and delete it there. The command stops here.`,
    );
  }
  return {
    token: next.renewed.accessToken,
    from: "sign-in",
    lacks: next.renewed.lacks,
    keptIn: file,
  };
}

/** `iterate cloudflare sign-in`: a sign-in with the deploy's scopes and `offline_access`, by the
 *  same client and page as the deploy's. A grant that lacks a scope, or comes with no refresh
 *  token, could not deploy with nobody there: it is revoked and nothing is kept. */
export async function keptSignInOf(
  show: (page: { url: URL; code: string; minutes: number }) => void | Promise<void>,
): Promise<KeptSignIn> {
  const answer = await deviceSignIn([...DEPLOY_SCOPES, "offline_access"], show);
  const lacks = scopesLacking(DEPLOY_SCOPES, answer.scope);
  const refreshToken = answer.refresh_token;
  if (lacks.length > 0 || !refreshToken) {
    await revoke(refreshToken);
    await revoke(answer.access_token);
    const problem = lacks.length
      ? `The sign-in at Cloudflare did not grant ${lacks.join(", ")}, and a deploy needs it.`
      : "Cloudflare gave no refresh token (offline_access was not granted), so the sign-in would end within the hour.";
    throw new Error(`${problem} Nothing is kept, and the grant is revoked. Run the command again.`);
  }
  return {
    kind: "iterate-cloudflare-sign-in",
    accessToken: answer.access_token,
    refreshToken,
    expiresAt: Date.now() + (answer.expires_in || 3600) * 1000,
    scopes: DEPLOY_SCOPES.join(" "),
    lacks: [],
    signedInAt: new Date().toISOString(),
  };
}

/** WHETHER AN API TOKEN OF AN ACCOUNT IS ONE THAT A DEPLOY MADE: the stack's two telemetry tokens,
 *  `iterate-<stage>-telemetry-catalog` and `-analytics` (core/alchemy src/stack.ts). A token that a
 *  sign-in made outlives the sign-in's revocation: only a delete ends it. */
export const madeByTheDeploy = (name: string) =>
  /^iterate-[a-z0-9-]+-telemetry-(catalog|analytics)$/.test(name);

/** The API tokens that deploys made in the accounts that a kept sign-in reaches, by account, for a
 *  person to delete; undefined when the access token has ended or Cloudflare did not answer. */
export async function tokensMadeThrough(kept: KeptSignIn) {
  if (kept.expiresAt <= Date.now()) return undefined;
  const api = cloudflare(kept.accessToken);
  const accounts = resultOf(
    z.array(z.object({ id: z.string(), name: z.string() })),
    await api("GET", "/accounts?per_page=50"),
  );
  if (!accounts) return undefined;
  const found: { account: string; page: string; tokens: string[] }[] = [];
  for (const account of accounts) {
    const tokens = resultOf(
      z.array(z.object({ name: z.string() })),
      await api("GET", `/accounts/${account.id}/tokens?per_page=100`),
    );
    const made = (tokens || []).map((token) => token.name).filter(madeByTheDeploy);
    if (made.length > 0)
      found.push({
        account: account.name,
        page: `https://dash.cloudflare.com/${account.id}/api-tokens`,
        tokens: made,
      });
  }
  return found;
}

/** `iterate cloudflare sign-out`: asks Cloudflare to revoke both tokens of a kept sign-in.
 *  Cloudflare's errors, none when it took both requests. */
export async function endKeptSignIn(kept: KeptSignIn) {
  return [await revoke(kept.refreshToken), await revoke(kept.accessToken)].filter(
    (error): error is string => Boolean(error),
  );
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
