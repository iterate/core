import { authorizationCodeRequest, authorizationServer as upstreamServer } from "iterate/oauth";
import { sameOriginPath } from "iterate/lib";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import {
  clearFlowCookie,
  clearSessionCookie,
  flowCookie,
  flowOf,
  sessionCookie,
} from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { errorPage } from "./pages.ts";
import { EMAIL_SIGN_IN_PATH } from "./email-sign-in.ts";
import { addressProven } from "./keys.ts";
import { linkIdentity } from "./users.ts";

export const SIGN_IN_PATH = "/sign-in";
export const ITERATE_SIGN_IN_PATH = "/sign-in/iterate";
export const ITERATE_SIGN_IN_CALLBACK_PATH = `${ITERATE_SIGN_IN_PATH}/callback`;
export const ITERATE_SIGN_IN_CLIENT_PATH = `${ITERATE_SIGN_IN_PATH}/client.json`;
export const SIGN_OUT_PATH = "/sign-out";

export function signInHref(env: Env, next: string) {
  const { methods } = iterateConfigOf(env).login;
  // Each of the two pages has the passkey's button, so no stack sends straight to the upstream.
  return `${methods.iterate ? SIGN_IN_PATH : EMAIL_SIGN_IN_PATH}?${new URLSearchParams({ next })}`;
}

const USERINFO_PATH = "/oauth2/userinfo";

export function clientMetadata(env: Env) {
  const origin = issuerOf(env);
  return Response.json(
    {
      client_id: `${origin}${ITERATE_SIGN_IN_CLIENT_PATH}`,
      client_name: iterateConfigOf(env).domain,
      client_uri: origin,
      redirect_uris: [`${origin}${ITERATE_SIGN_IN_CALLBACK_PATH}`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

export async function iterateSignInResponse(env: Env, request: Request) {
  const origin = issuerOf(env);
  const method = iterateConfigOf(env).login.methods.iterate;
  if (!method) return new Response("Not found", { status: 404 });
  const { issuer } = method;
  const next = sameOriginPath(new URL(request.url).searchParams.get("next") || "/", origin);
  const { url, state, verifier } = await authorizationCodeRequest({
    issuer,
    clientId: `${origin}${ITERATE_SIGN_IN_CLIENT_PATH}`,
    redirectUri: `${origin}${ITERATE_SIGN_IN_CALLBACK_PATH}`,
    resources: [`${issuer}${USERINFO_PATH}`],
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: url.href,
      "set-cookie": await flowCookie(env, { next, state, verifier }),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

// Identity is not membership: anyone the upstream vouches for signs in, and signing in grants
// nothing. Membership is decided where a token is asked for (./authorize.ts).
export async function iterateSignInCallbackResponse(env: Env, request: Request) {
  const method = iterateConfigOf(env).login.methods.iterate;
  if (!method) return new Response("Not found", { status: 404 });
  const { issuer } = method;
  const refused = (message: string) =>
    errorPage(message, 403, new Headers({ "set-cookie": clearFlowCookie }));
  const checked = await whoSignedIn(env, request, issuer).catch((error: unknown) => {
    console.warn({ event: "auth.sign-in-check-failed", message: String(error) });
    return { error: `We could not confirm who you are at ${issuer}. Try again.` };
  });
  if ("error" in checked) return refused(checked.error);
  const user = await linkIdentity(env.DB, {
    provider: issuer,
    subject: checked.subject,
    email: checked.email,
  }).catch((error: unknown) => {
    console.warn({
      event: "auth.sign-in-link-failed",
      email: checked.email,
      message: String(error),
    });
    return null;
  });
  if (!user)
    return refused(`${checked.email} belongs to another account here. Ask the mind's owner.`);
  const proven = await addressProven(env, user, checked.next);
  if ("refused" in proven) {
    console.info({ event: "auth.sign-in-refused", method: "iterate", userId: user.id });
    return errorPage(proven.refused, 403, new Headers({ "set-cookie": clearFlowCookie }), [
      { href: signInHref(env, checked.next), label: "Sign in with the passkey" },
    ]);
  }
  console.info({ event: "auth.signed-in", userId: user.id, email: user.email });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "iterate", issuer, at: Date.now() },
  });
  const headers = new Headers({
    location: proven.location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", await sessionCookie(env, user, "iterate"));
  headers.append("set-cookie", clearFlowCookie);
  return facts.on(new Response(null, { status: 302, headers }));
}

export function signOutResponse(env: Env, request: Request) {
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Sign out from this site's own page.", 403);
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": clearSessionCookie, "cache-control": "no-store" },
  });
}

async function whoSignedIn(
  env: Env,
  request: Request,
  issuer: string,
): Promise<{ email: string; subject: string; next: string } | { error: string }> {
  const flow = await flowOf(env, request);
  if (!flow) return { error: "This sign-in expired or began in another browser. Start it again." };
  const origin = issuerOf(env);
  // the library serves revocation at its token endpoint (RFC 7009)
  const as = { ...upstreamServer(issuer) };
  as.revocation_endpoint = as.token_endpoint;
  const client = { client_id: `${origin}${ITERATE_SIGN_IN_CLIENT_PATH}` };
  let callback: URLSearchParams;
  try {
    callback = oauth.validateAuthResponse(
      as,
      client,
      new URL(request.url).searchParams,
      flow.state,
    );
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError)
      return { error: `You cancelled the sign-in at ${issuer}. Start it again.` };
    return { error: "This sign-in expired or began in another browser. Start it again." };
  }
  const resource = `${issuer}${USERINFO_PATH}`;
  const tokens = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.None(),
      callback,
      `${origin}${ITERATE_SIGN_IN_CALLBACK_PATH}`,
      flow.verifier,
      { additionalParameters: { resource }, signal: AbortSignal.timeout(10_000) },
    ),
  );
  try {
    const response = await fetch(resource, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${resource} answered ${response.status}`);
    const { sub, email } = z
      .object({ sub: z.string().min(1), email: z.string().min(1) })
      .parse(await response.json());
    return { email, subject: sub, next: flow.next };
  } finally {
    await oauth
      .revocationRequest(as, client, oauth.None(), tokens.access_token, {
        signal: AbortSignal.timeout(10_000),
      })
      .then((response) => response.body?.cancel())
      .catch((error: unknown) =>
        console.warn({ event: "auth.upstream-token-not-revoked", message: String(error) }),
      );
  }
}
