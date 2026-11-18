import { sameOriginPath } from "iterate/lib";
import { SignInMethod } from "iterate/principal";
import { AccountFacts } from "./account-facts.ts";
import {
  clearCloudflareSessionCookie,
  clearGuestSessionCookie,
  clearSessionCookie,
  endThisSession,
} from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf, offersMethod } from "./env.ts";
import { errorPage } from "./pages.ts";
import type { AskingApp } from "./asking-app.ts";
import { anyoneGetsACode } from "./email-sign-in.ts";
import { mindHostResourceOf } from "./oauth.ts";

export const SIGN_IN_PATH = "/sign-in";

/** On the sign-in link of a person who just signed out: the passkey's page waits for a press. */
export const AFTER_SIGN_OUT = "signed-out";

/** Where a person signs in (./http.ts): the page of the ways an app takes, when the request names
 *  them (`methodsAskedIn`); else the passkey's page, or the mailed code's (`codeComesFirst`). */
export const signInHref = (next: string) => `${SIGN_IN_PATH}?${new URLSearchParams({ next })}`;

/** Opens on the mailed code's page when the mind mails codes and has no active passkey, or
 *  for an app's own people on a stack where anyone may sign in. */
export async function codeComesFirst(env: Env, app: AskingApp | null) {
  if (!iterateConfigOf(env).login.methods.email) return false;
  if (app && !app.members && anyoneGetsACode(env)) return true;
  return !(await env.DB.prepare(
    "select 1 from keys where format = 'webauthn' and revoked_at is null limit 1",
  ).first());
}

/** THE WAYS TO SIGN IN THAT AN APP TAKES, as the authorization request `next` (a path of this
 *  issuer) names them: RFC 9470's `acr_values`, which ingress copies there from the app's guard
 *  (iterate/sdk `auth.requirePerson`), or the authorization endpoint from the app's manifest when
 *  the request named none (./authorize.ts, ./asking-app.ts). Those this stack offers (./env.ts `offersMethod`), in the
 *  request's order. Null when it names none, or asks for no mind hostname (the mind's API or MCP
 *  server): the mind's own sign-in. Empty when it names only ways this stack does not offer:
 *  nobody can sign in. It is routing: a browser can change it, and the app's guard judges the
 *  session that comes back. */
export function methodsAskedIn(env: Env, next: string): SignInMethod[] | null {
  const issuer = issuerOf(env);
  if (!URL.canParse(next, issuer)) return null;
  const { searchParams } = new URL(next, issuer);
  if (!mindHostResourceOf(env, searchParams.get("resource"))) return null;
  const named = (searchParams.get("acr_values") || "").split(" ").filter(Boolean);
  if (!named.length) return null;
  const offered = named.flatMap((value) => {
    const method = SignInMethod.safeParse(value);
    return method.success && offersMethod(env, method.data) ? [method.data] : [];
  });
  return [...new Set(offered)];
}

/** Ends this browser's session at the issuer: its row, and its cookie. The sign-in follows, and
 *  waits for a press (`AFTER_SIGN_OUT`): a person who just signed out is not asked for a passkey.
 *  It comes back to `next` (a path of this origin; the start page with none): that is how a person
 *  changes account, since a browser holds one session. An app's own session on a mind hostname is
 *  the boundary's, and is not ended here. */
export async function signOutResponse(env: Env, request: Request) {
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Sign out from this site's own page.", 403);
  const form = await request.formData().catch(() => null);
  const next = sameOriginPath(String(form?.get("next") || "/"), issuerOf(env));
  const headers = new Headers({
    location: `${signInHref(next)}&${AFTER_SIGN_OUT}=1`,
    "cache-control": "no-store",
  });
  // a sign-in at Cloudflare is this browser's too, and so is the guest it was
  headers.append("set-cookie", clearSessionCookie);
  headers.append("set-cookie", clearCloudflareSessionCookie);
  headers.append("set-cookie", clearGuestSessionCookie);
  const facts = new AccountFacts();
  await endThisSession(env, request, facts);
  return facts.on(new Response(null, { status: 303, headers }));
}
