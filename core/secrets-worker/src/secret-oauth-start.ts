// RFC 9700 §4.7.1: the state is bound to the browser that opened the start page, by a cookie, so no
// link the mind writes skips the page and a start learned from one attempt completes no other.
import { cookieValueOf } from "iterate/lib";
import { base64url } from "iterate/signed";
import { admitted, callbackPage, escaped, plainPage, useLines } from "./callback-page.ts";
import { parseSecretOAuthState, stateOf } from "./secret-oauth.ts";
import { secretsEqual, sha256Hex } from "./secrets.ts";

export const SECRET_OAUTH_START_PATH = "/secrets/oauth/start";

// `__Host-itx-`: only the platform's own pages set it. Named by the start, the secret and the
// attempt, so concurrent starts never overwrite each other.
const startCookieNameOf = async (start: string, path: string, nonce: string) =>
  `__Host-itx-oauth-start-${(await sha256Hex(JSON.stringify([start, path, nonce]))).slice(0, 16)}`;
const cookieAttributes = "HttpOnly; Secure; SameSite=Lax; Path=/";

export function startLinkOf(platformOrigin: string, path: string, nonce: string): string {
  const url = new URL(SECRET_OAUTH_START_PATH, platformOrigin);
  url.searchParams.set("path", path);
  url.searchParams.set("nonce", nonce);
  return url.href;
}

// A link preview or a prefetch is no navigation, and wakes no attempt.
function isDocumentNavigation(request: Request): boolean {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return false;
  const mode = request.headers.get("sec-fetch-mode");
  const destination = request.headers.get("sec-fetch-dest");
  if (!mode && !destination) return (request.headers.get("accept") ?? "").includes("text/html");
  return mode === "navigate" && destination === "document";
}

type StartTarget = {
  authorizationUrl: string;
  urls: string[];
  use: Parameters<typeof useLines>[0];
  anyoneWithLink: boolean;
  // For a client of iterate Cloud's: the provider's `state` is this URL as base64url, a dot, then
  // the attempt's own state, which iterate Cloud's callback relies on.
  returnTo?: string;
  // And iterate Cloud's own page, where the person confirms once, before the provider: it says
  // which deployment gets access, and to which accounts when the link names them (`?accounts=`;
  // internal-packages/cloud-clients `begin`). This page is then not shown.
  beginAt?: string;
};

export async function secretOAuthStart(
  request: Request,
  targetOf: (path: string, nonce: string) => Promise<StartTarget | null>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  const nonce = url.searchParams.get("nonce");
  if (!path || !nonce) return noLongerInFlight();
  if (!isDocumentNavigation(request))
    return callbackPage(200, "Open this link in your browser to continue.");
  const target = await targetOf(path, nonce);
  if (!target) return noLongerInFlight();
  const admission = admitted(request, target.anyoneWithLink);
  if (admission instanceof Response) return admission;
  const given = url.searchParams.get("start");
  const began = !!given && (await startedHere(request, given, path, nonce));
  const start = began ? given : base64url(crypto.getRandomValues(new Uint8Array(16)));
  // as long as an attempt may live: secret-oauth.ts SECRET_OAUTH_TTL_MS
  const bound = `${await startCookieNameOf(start, path, nonce)}=${start}; ${cookieAttributes}; Max-Age=3600`;
  // ONE PAGE TO CONFIRM ON. A client of iterate Cloud's has it at the Cloud, before the provider,
  // so this browser is bound to the attempt here and goes straight on. Any other client has it
  // here.
  if (!began && !target.beginAt) {
    url.searchParams.set("start", start);
    const page = plainPage(
      200,
      `<h1>${escaped(path)}</h1><p>You are connecting an account for this secret. Its tokens are only ever sent to ${target.urls.map(escaped).join(", ")}.</p>${target.returnTo ? "<p>The app you approve is iterate's own. iterate Cloud adds the app's secret when the tokens are fetched, and keeps none of them.</p>" : ""}${useLines(target.use, target.anyoneWithLink)}<p><a href="${escaped(url.href)}">Continue</a></p>`,
    );
    page.headers.append("set-cookie", bound);
    return page;
  }
  const to = new URL(target.authorizationUrl);
  const state = parseSecretOAuthState(to.searchParams.get("state"));
  if (!state) return callbackPage(400, "This link is not one the platform issued.");
  const own = stateOf({ ...state, start });
  to.searchParams.set(
    "state",
    target.returnTo ? `${base64url(new TextEncoder().encode(target.returnTo))}.${own}` : own,
  );
  const begin = target.beginAt ? new URL(target.beginAt) : null;
  begin?.searchParams.set("to", to.href);
  const headers = new Headers({
    location: (begin || to).href,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  if (!began) headers.append("set-cookie", bound);
  return new Response(null, { status: 302, headers });
}

const noLongerInFlight = () =>
  callbackPage(
    400,
    "This link is no longer in flight: a newer link replaced it, or it already finished. Ask for a new one.",
  );

export async function startedHere(
  request: Request,
  start: string,
  path: string,
  nonce: string,
): Promise<boolean> {
  const held = cookieValueOf(
    request.headers.get("cookie"),
    await startCookieNameOf(start, path, nonce),
  );
  if (!held) return false;
  return secretsEqual(held, start);
}

export const notStartedHere = () =>
  callbackPage(
    403,
    "This sign-in was not started in this browser, or it already finished. Open the link you were given again, in this browser.",
  );

// Only on a completed attempt: a failed one keeps the cookie, so a refreshed tab can retry.
export async function withStartCleared(
  response: Response,
  { start, path, nonce }: { start: string; path: string; nonce: string },
): Promise<Response> {
  const cleared = new Response(response.body, response);
  cleared.headers.append(
    "set-cookie",
    `${await startCookieNameOf(start, path, nonce)}=; ${cookieAttributes}; Max-Age=0`,
  );
  return cleared;
}
