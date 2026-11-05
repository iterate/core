// secret-oauth-start.ts — the start link of a secret's OAuth and of a GitHub connect: what
// `beginOAuth` and `connectGithub` hand out instead of the provider's URL, so the consent is bound to
// the browser that gives it (RFC 9700 §4.7.1, the state bound to the user agent).
//
// The provider binds its code to the `state` it was sent. Each opening of a start link mints a random
// `start`, signs it into a fresh `state` and sets it in a cookie of its own; the callback admits a
// code only from the browser that holds the cookie its `state` names (`startedHere`). A stranger who
// opens the link consents in their own browser and gets a code no member's browser can complete; the
// provider's URL never leaves the browser that opened the link. The same idiom as identity.ts's flow
// cookie, reduced to one random value: the attempt's secrets stay in the secret's facet.
//
// The link is short: a random id, `<origin>/.secrets/oauth/start/<id>`, whose row in the control
// plane's key-value table (`oauth_grants`, D1: read-after-write across locations, its rows expiring
// with the attempt) names the attempt (the secret's context, or GitHub's project and connection) and
// its nonce. The row's key is the id's SHA-256, so the table holds no live link. The hop asks the attempt's owner, as the platform, for the provider's
// URL it composed and stored (`itx.secrets.oauthStartTarget`, `itx.integrations.githubStartTarget`),
// so it follows only a URL the platform wrote, and the provider's URL, its `state` and the PKCE
// challenge never appear in a link anyone shares. Called by worker.ts.

import { cookieValueOf } from "iterate/lib";
import { base64url, secretsEqual, sha256Hex, signClaims, verifyClaims } from "./caller.ts";
import { OAuthGrantTable } from "./control-plane/oauth-grants.ts";
import { callbackPage } from "./callback-page.ts";
import { contextStub } from "./context-stub.ts";
import { DurableObjectNameCodec } from "./context/paths.ts";
import type { Env } from "./env.ts";
import { iterateConfigOf, sessionSigningSecretOf } from "./iterate-config.ts";
import { secretOwnerOf } from "./secret-oauth.ts";
import { isRecord } from "./secrets.ts";
import { isDocumentNavigation } from "./project-host-sign-in.ts";

export const SECRET_OAUTH_START_PATH = "/.secrets/oauth/start";

/** The claim sets a start re-signs with its `start`: a secret's OAuth state and GitHub's. */
const STARTABLE_KINDS = ["secret-oauth", "github-connect"];

/** `__Host-itx-`: the edge strips it from project requests and from project responses
 *  (browser-client.ts `appCookies`, worker.ts), so project code on the platform origin can neither
 *  read nor plant one. Named per start, so concurrent starts never overwrite each other. */
const startCookieNameOf = async (start: string) =>
  `__Host-itx-oauth-start-${(await sha256Hex(start)).slice(0, 16)}`;
const cookieAttributes = "HttpOnly; Secure; SameSite=Lax; Path=/";

/** The attempt a start link names: a secret's (its context, the Durable Object name the callback's
 *  `state` carries too) or a GitHub connect's (its project and connection), with its nonce. */
export type StartTarget =
  | { context: string; nonce: string }
  | { projectId: string; connection: string; nonce: string };

/** A start link's row in `oauth_grants`, keyed by its id's SHA-256. */
const startRowKeyOf = async (id: string) => `oauth-start:${await sha256Hex(id)}`;

const isStartTarget = (target: unknown): target is StartTarget =>
  isRecord(target) &&
  typeof target.nonce === "string" &&
  (typeof target.context === "string" ||
    (typeof target.projectId === "string" && typeof target.connection === "string"));

/** The start link for the attempt `target`, on `platformOrigin`, valid until `exp` (epoch ms): a
 *  fresh random id and its row, which expires with the attempt (the table's purge deletes it). */
export async function startLinkOf(
  platformOrigin: string,
  target: StartTarget,
  exp: number,
  env: { DB: D1Database },
): Promise<string> {
  const id = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const now = Math.floor(Date.now() / 1000);
  await new OAuthGrantTable(env.DB).put(
    await startRowKeyOf(id),
    JSON.stringify(target),
    Math.ceil(exp / 1000),
    now,
  );
  return new URL(`${SECRET_OAUTH_START_PATH}/${id}`, platformOrigin).href;
}

/** The attempt the start link `id` names, or null: no such link, or its attempt expired. */
async function startTargetOf(env: Env, id: string): Promise<StartTarget | null> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
  const value = await new OAuthGrantTable(env.DB).get(
    await startRowKeyOf(id),
    Math.floor(Date.now() / 1000),
  );
  const target: unknown = value ? JSON.parse(value) : null;
  return isStartTarget(target) ? target : null;
}

/** The provider's URL the link's attempt stored, asked of its owner as the platform: the secret's
 *  context, or the project's root for GitHub. Throws `GONE` when no attempt in flight has the link's
 *  nonce. */
async function providerUrlOf(env: Env, link: StartTarget): Promise<string> {
  const platform = { principal: null, platform: true } as const;
  if ("context" in link) {
    // `invoke` is untyped across the DO hop: this is the built-in's own declared answer
    // (context/built-ins.ts `secrets.oauthStartTarget`)
    return (await contextStub(
      env.ITERATE_CONTEXT,
      DurableObjectNameCodec.parse(link.context),
      "secret-oauth",
    ).invoke(
      [
        "itx",
        "builtins",
        "secrets",
        ["oauthStartTarget", secretOwnerOf(link.context).path, { nonce: link.nonce }],
      ],
      [],
      platform,
    )) as string;
  }
  // `invoke` is untyped across the DO hop: this is the built-in's own declared answer
  // (context/built-ins.ts `integrations.githubStartTarget`)
  return (await contextStub(
    env.ITERATE_CONTEXT,
    DurableObjectNameCodec.address({ projectId: link.projectId, path: "/" }),
    "integrations",
  ).invoke(
    [
      "itx",
      "builtins",
      "integrations",
      ["githubStartTarget", { connection: link.connection, nonce: link.nonce }],
    ],
    [],
    platform,
  )) as string;
}

/** A browser opens a start link: a fresh `start` in the provider's `state` and in a cookie, then on
 *  to the provider. Anything but a page navigation (a link preview, a prefetch) gets a page and no
 *  cookie, and wakes no attempt. */
export async function secretOAuthStart(request: Request, env: Env): Promise<Response> {
  const signingSecret = await sessionSigningSecretOf(iterateConfigOf(env));
  // `/.secrets/oauth/start/<id>`; the bare path names no attempt
  const id = new URL(request.url).pathname.slice(SECRET_OAUTH_START_PATH.length + 1);
  const link = id ? await startTargetOf(env, id) : null;
  if (!link) return noLongerInFlight();
  if (!isDocumentNavigation(request))
    return callbackPage(200, "Open this link in your browser to continue.");
  let to: URL;
  try {
    to = new URL(await providerUrlOf(env, link));
  } catch (error) {
    // only the attempt's own "gone" is a dead link; a platform failure (a deploy's reset, an
    // overload) propagates, so the human retries the same link instead of asking for a new one,
    // which would replace an attempt a browser may already be completing
    if (!isRecord(error) || error.code !== "GONE") throw error;
    return noLongerInFlight();
  }
  const state = await verifyClaims(to.searchParams.get("state") ?? "", signingSecret);
  if (!isRecord(state) || !STARTABLE_KINDS.includes(String(state.kind)))
    return callbackPage(400, "This link is not one the platform issued, or it has expired.");
  const start = base64url(crypto.getRandomValues(new Uint8Array(16)));
  to.searchParams.set("state", await signClaims({ ...state, start }, signingSecret));
  // the cookie lives as long as the `state` it pairs with
  const maxAge =
    Number(state.exp) > Date.now() ? Math.ceil((Number(state.exp) - Date.now()) / 1000) : 0;
  if (!maxAge) return noLongerInFlight();
  return new Response(null, {
    status: 302,
    headers: {
      location: to.href,
      "set-cookie": `${await startCookieNameOf(start)}=${start}; ${cookieAttributes}; Max-Age=${maxAge}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** A start link that names no attempt in flight: unknown, expired, replaced or finished. */
const noLongerInFlight = () =>
  callbackPage(
    400,
    "This link is no longer in flight: a newer link replaced it, or it already finished. Ask for a new one.",
  );

/** Whether this browser opened the start link the callback's `state` names: it holds the cookie of
 *  that `start`. A callback whose `state` has no `start` (lifted out of a start link, or issued
 *  before start links) is refused without asking. */
export async function startedHere(request: Request, start: string): Promise<boolean> {
  const held = cookieValueOf(request.headers.get("cookie"), await startCookieNameOf(start));
  if (!held) return false;
  return secretsEqual(held, start);
}

/** The callback's refusal when `startedHere` is false: before any session check, so a forwarded
 *  callback gets no sign-in prompt. */
export const notStartedHere = () =>
  callbackPage(
    403,
    "This sign-in was not started in this browser, or it already finished. Open the link you were given again, in this browser.",
  );

/** `response` with the start cookie cleared: on a completed attempt. A failed one keeps it, so a
 *  refreshed tab can retry (the facet's replay lands what the first try could not). */
export async function withStartCleared(response: Response, start: string): Promise<Response> {
  const cleared = new Response(response.body, response);
  cleared.headers.append(
    "set-cookie",
    `${await startCookieNameOf(start)}=; ${cookieAttributes}; Max-Age=0`,
  );
  return cleared;
}
