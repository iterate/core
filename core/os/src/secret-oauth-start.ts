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
// The link is a signed `{ to, exp }`: `to` is the provider's URL the platform composed, so the hop
// follows only a URL the platform wrote. Called by worker.ts.

import { cookieValueOf } from "iterate/lib";
import { base64url, secretsEqual, sha256Hex, signClaims, verifyClaims } from "./caller.ts";
import { callbackPage } from "./callback-page.ts";
import type { Env } from "./env.ts";
import { iterateConfigOf, sessionSigningSecretOf } from "./iterate-config.ts";
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

/** The signed `s` of a start link. `kind` keeps it apart from every other claim set the same key
 *  signs; a start link is never a callback's `state`, nor the reverse. */
type OAuthStartLink = { kind: "oauth-start"; to: string; exp: number };

/** The start link for the provider's URL `to`, on `platformOrigin`, valid until `exp`. */
export async function startLinkOf(
  platformOrigin: string,
  to: string,
  exp: number,
  signingSecret: string,
): Promise<string> {
  const link: OAuthStartLink = { kind: "oauth-start", to, exp };
  const url = new URL(SECRET_OAUTH_START_PATH, platformOrigin);
  url.searchParams.set("s", await signClaims(link, signingSecret));
  return url.href;
}

/** A browser opens a start link: a fresh `start` in the provider's `state` and in a cookie, then on
 *  to the provider. Anything but a page navigation (a link preview, a prefetch) gets a page and no
 *  cookie. */
export async function secretOAuthStart(request: Request, env: Env): Promise<Response> {
  const signingSecret = await sessionSigningSecretOf(iterateConfigOf(env));
  const link = await verifyClaims(new URL(request.url).searchParams.get("s") ?? "", signingSecret);
  if (
    !isRecord(link) ||
    link.kind !== "oauth-start" ||
    typeof link.to !== "string" ||
    typeof link.exp !== "number" ||
    link.exp <= Date.now()
  )
    return callbackPage(400, "This link is not one the platform issued, or it has expired.");
  if (!isDocumentNavigation(request))
    return callbackPage(200, "Open this link in your browser to continue.");
  const to = new URL(link.to);
  const state = await verifyClaims(to.searchParams.get("state") ?? "", signingSecret);
  if (!isRecord(state) || !STARTABLE_KINDS.includes(String(state.kind)))
    return callbackPage(400, "This link is not one the platform issued, or it has expired.");
  const start = base64url(crypto.getRandomValues(new Uint8Array(16)));
  to.searchParams.set("state", await signClaims({ ...state, start }, signingSecret));
  const maxAge = Math.ceil((link.exp - Date.now()) / 1000);
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
