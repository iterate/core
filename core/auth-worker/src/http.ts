// http.ts — THE AUTH WORKER'S ANSWER TO A REQUEST: every page and endpoint of the platform's host,
// `iterate.<domain>`. Each path is tried in turn; what no path here takes is the OAuth provider's.
import { KEY_TOKEN_PATH, STATEMENTS_PATH } from "iterate/signed";
import { askingAppOf } from "./asking-app.ts";
import { authorizeResponse } from "./authorize.ts";
import { FIRST_OWNER_PATH } from "./config.ts";
import { sessionOf } from "./cookies.ts";
import { cloudflareSignInResponse } from "./cloudflare-sign-in.ts";
import { deviceCallbackResponse } from "./device/callback.ts";
import { devicePageResponse } from "./device/page.ts";
import { devicePollResponse } from "./device/poll.ts";
import {
  CALLBACK_PATH as DEVICE_CALLBACK_PATH,
  DEVICE_AUTHORIZATION_PATH,
  VERIFICATION_PATH,
} from "./device/protocol.ts";
import {
  deviceAuthorizationResponse,
  deviceRegistrationResponse,
  metadataResponse,
} from "./device/start.ts";
import { emailSignInResponse } from "./email-sign-in.ts";
import { type Env, issuerOf, iterateConfigOf, offersGoogle } from "./env.ts";
import { firstOwnerResponse } from "./first-owner.ts";
import { googleSignInResponse } from "./google-sign-in.ts";
import { keyTokenResponse } from "./key-tokens.ts";
import { keysPagesResponse } from "./keys-pages.ts";
import { membersResponse, standingOf } from "./members.ts";
import {
  AUTHORIZE_ENDPOINT,
  authorizationServer,
  CLIENT_REGISTRATION_ENDPOINT,
  withKnownResource,
  tokenEndpointResponse,
  TOKEN_ENDPOINT,
} from "./oauth.ts";
import {
  methodsSignInPage,
  nobodySignsInPage,
  notMemberPage,
  signInPage,
  SIGN_OUT_PATH,
} from "./pages.ts";
import { passkeySignInResponse } from "./passkey-sign-in.ts";
import { selfTestResponse } from "./self-test.ts";
import { methodsAskedIn, SIGN_IN_PATH, signInHref, signOutResponse } from "./sign-in.ts";
import { signInsResponse } from "./sign-ins-page.ts";
import { statementsResponse } from "./statements.ts";
import { whoIs } from "./who-is.ts";

/** The Dash, the default config's app on its own host of the mind's domain. */
const dashOriginOf = (domain: string) => `https://dash.${domain}`;

export async function authResponse(asked: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(asked.url);
  // the cookies and the metadata name the issuer's origin alone
  if (url.origin !== issuerOf(env)) return new Response("Not found", { status: 404 });
  const { pathname } = url;
  const request =
    pathname === AUTHORIZE_ENDPOINT || pathname === TOKEN_ENDPOINT
      ? await withKnownResource(env, asked)
      : asked;
  const get = request.method === "GET" || request.method === "HEAD";
  if (pathname === AUTHORIZE_ENDPOINT) return authorizeResponse(env, request);
  if (pathname === TOKEN_ENDPOINT && request.method === "POST")
    return (
      (await devicePollResponse(env, request, ctx)) || tokenEndpointResponse(env, request, ctx)
    );
  if (pathname === "/.well-known/oauth-authorization-server" && request.method === "GET")
    return metadataResponse(env, request, ctx);
  if (pathname === CLIENT_REGISTRATION_ENDPOINT && request.method === "POST") {
    const registered = await deviceRegistrationResponse(env, request, ctx);
    if (registered) return registered;
  }
  if (pathname === DEVICE_AUTHORIZATION_PATH && request.method === "POST")
    return deviceAuthorizationResponse(env, request);
  if (pathname === VERIFICATION_PATH && (get || request.method === "POST"))
    return devicePageResponse(env, request);
  if (pathname === DEVICE_CALLBACK_PATH && get) return deviceCallbackResponse(env, request);
  // The platform's host has no start page: `/` leads to the Dash, whose own sign-in decides the
  // rest. A signed-in person who is no member would only be refused there: that person reads it
  // here.
  if (pathname === "/" && get) {
    const { domain } = iterateConfigOf(env);
    const session = await sessionOf(env, request);
    if (session && (await standingOf(env, session)) === "not-member")
      return notMemberPage({ domain, email: session.email });
    return new Response(null, {
      status: 302,
      headers: { location: `${dashOriginOf(domain)}/`, "cache-control": "no-store" },
    });
  }
  const selfTest = await selfTestResponse(env, request);
  if (selfTest) return selfTest;
  if (pathname === SIGN_IN_PATH && get) {
    const next = url.searchParams.get("next") || "/";
    const { domain, login } = iterateConfigOf(env);
    // an app that names the ways it takes gets those ways' buttons (./sign-in.ts `methodsAskedIn`)
    const methods = methodsAskedIn(env, next);
    if (methods?.length === 0) return nobodySignsInPage();
    if (methods)
      return methodsSignInPage({ domain, next, methods, app: await askingAppOf(env, next) });
    return login.methods.email
      ? Response.redirect(`${issuerOf(env)}${signInHref(env, next)}`, 302)
      : signInPage(domain, next, offersGoogle(env), await askingAppOf(env, next));
  }
  const members = await membersResponse(env, request, (token, resource) =>
    whoIs(env, token, resource),
  );
  if (members) return members;
  const emailSignIn = await emailSignInResponse(env, request);
  if (emailSignIn) return emailSignIn;
  const googleSignIn = await googleSignInResponse(env, request);
  if (googleSignIn) return googleSignIn;
  const cloudflareSignIn = await cloudflareSignInResponse(env, request);
  if (cloudflareSignIn) return cloudflareSignIn;
  const passkeySignIn = await passkeySignInResponse(env, request);
  if (passkeySignIn) return passkeySignIn;
  if (pathname === SIGN_OUT_PATH && request.method === "POST") return signOutResponse(env, request);
  if (pathname === FIRST_OWNER_PATH && (get || request.method === "POST"))
    return firstOwnerResponse(env, request);
  if (pathname === KEY_TOKEN_PATH && request.method === "POST")
    return keyTokenResponse(env, request);
  const signIns = await signInsResponse(env, request);
  if (signIns) return signIns;
  const keys = await keysPagesResponse(env, request);
  if (keys) return keys;
  if (pathname === STATEMENTS_PATH && request.method === "POST")
    return statementsResponse(env, request);
  return authorizationServer(env).fetch(request, env, ctx);
}
