// connect-callback.ts — THE ADMISSION every connect callback shares: a secret's OAuth
// (secret-oauth-callback.ts) and each connect flow (integrations/connect-flows.ts, GitHub's App
// among them). A provider sent a browser back with the platform-signed `state` its start link
// minted (secret-oauth-start.ts); before the flow's own completion runs, this admits it in one
// order:
//   1. the state verifies and has not expired (else 400);
//   2. the browser holds the cookie of the start its `state` names (`startedHere`; else 403, before
//      any session, so a forwarded callback gets no sign-in prompt);
//   3. a platform session (a browser cookie, or a bearer that holds the start cookie too); a
//      signed-out page navigation is sent to sign in with this very callback as its same-origin
//      `next`, and comes back with its start cookie still set; anything else gets a 401;
//   4. the session is one the attempt admits: it reaches the attempt's owner (`reaching`), or it is
//      the one person the attempt was begun for (secret-oauth-callback.ts); else 403;
//   5. the provider did not answer `error` (else 400).
// Nothing before the flow's completion touches the attempt, so a code is still the attempt's after
// the sign-in detour.

import { sameOriginPath } from "iterate/lib";
import { verifyClaims } from "./caller.ts";
import { browserAuthorization } from "./browser-client.ts";
import { callbackPage } from "./callback-page.ts";
import { ControlPlane, type Reach } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import {
  iterateConfigOf,
  sessionSigningSecretOf,
  type PlatformAddresses,
} from "./iterate-config.ts";
import { signInHref } from "./login-search.ts";
import { authorizationForToken } from "./oauth.ts";
import { isDocumentNavigation } from "./project-host-sign-in.ts";
import { notStartedHere, startedHere } from "./secret-oauth-start.ts";

/** The human at a callback: their platform session — a browser cookie, or a bearer — or null. */
async function callbackAuthorization(request: Request, env: Env, addresses: PlatformAddresses) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  return bearer
    ? authorizationForToken(env, bearer, addresses, "secret-oauth-callback")
    : browserAuthorization(env, request);
}

export type CallbackAuthorization = NonNullable<Awaited<ReturnType<typeof callbackAuthorization>>>;

/** An admitted callback: its session and the start the browser proved (the cookie a completed
 *  attempt clears, secret-oauth-start.ts `withStartCleared`). */
export type Admitted = { authorization: CallbackAuthorization; start: string };

/** Who may complete an attempt: the check on a session, and what a caller who fails it reads. */
export type Admission = {
  admits: (controlPlane: ControlPlane, authorization: CallbackAuthorization) => Promise<boolean>;
  /** The 401 of a client with no session, which is no browser to send to sign in. */
  signedOut: string;
  /** The 403 of a session the attempt does not admit. */
  refused: string;
};

/** The admission of an attempt that belongs to `name` (a project, or the secrets of a project, a
 *  person or an organization): any session that reaches it. */
export const reaching = (
  name: string,
  reachedBy: (controlPlane: ControlPlane, reach: Reach) => Promise<boolean>,
): Admission => ({
  admits: (controlPlane, { reach }) => reachedBy(controlPlane, reach),
  signedOut: `Sign in to iterate in this browser first, then open this link again — it connects to ${name}, which you must be a member of.`,
  refused: `Your session cannot access ${name}.`,
});

/** The callback's `state`, verified and unexpired, when `isState` takes it; otherwise null. */
export async function callbackStateOf<T extends { exp: number }>(
  url: URL,
  env: Env,
  isState: (claims: unknown) => claims is T,
): Promise<T | null> {
  const claims = await verifyClaims(
    url.searchParams.get("state") ?? "",
    await sessionSigningSecretOf(iterateConfigOf(env)),
  );
  return isState(claims) && claims.exp > Date.now() ? claims : null;
}

export const notIssuedHere = () =>
  callbackPage(400, "This link is not one the platform issued, or it has expired.");

/** Steps 2 to 5 of the header for a callback whose state verified (`callbackStateOf`): the admitted
 *  session, or the response that refuses it or sends it to sign in. */
export async function admitCallback(
  request: Request,
  env: Env,
  addresses: PlatformAddresses,
  input: { start: unknown; admission: Admission },
): Promise<Response | Admitted> {
  const { start, admission } = input;
  if (typeof start !== "string" || !start || !(await startedHere(request, start)))
    return notStartedHere();
  const url = new URL(request.url);
  const authorization = await callbackAuthorization(request, env, addresses);
  // No session in a browser: sign in here and come back to this callback, the platform's own page
  // (`sameOriginPath`: never another origin). A bearer that did not verify, or a client that is no
  // browser, gets the 401.
  if (!authorization && !request.headers.has("authorization") && isDocumentNavigation(request))
    return new Response(null, {
      status: 302,
      headers: {
        location: signInHref(sameOriginPath(url.pathname + url.search, url.origin), null),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  if (!authorization) return callbackPage(401, admission.signedOut);
  if (!(await admission.admits(new ControlPlane(env), authorization)))
    return callbackPage(403, admission.refused);
  const denied = url.searchParams.get("error");
  if (denied) return callbackPage(400, `The provider declined: ${denied}`);
  return { authorization, start };
}

/** `admitCallback`'s answer was a refusal or a redirect. */
export const refused = (admitted: Response | Admitted): admitted is Response =>
  admitted instanceof Response;
