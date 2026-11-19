// http.ts — THE AUTH WORKER'S ANSWER TO A REQUEST: every page and endpoint of the mind's control-plane
// hostname. Each path is tried in turn; what no path here takes is the OAuth provider's.
import { MIND_IDENTITY_PATH } from "iterate/mind-identity-log";
import { KEY_TOKEN_PATH, STATEMENTS_PATH } from "iterate/signed";
import { accessSignInResponse } from "./access-sign-in.ts";
import { signInOf } from "./asking-app.ts";
import { authorizeResponse } from "./authorize.ts";
import { personSessionOf } from "./cookies.ts";
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
import { TOO_MANY } from "./device/limits.ts";
import { emailAddressPage, emailSignInResponse } from "./email-sign-in.ts";
import { guestFormHref, guestSignInResponse } from "./guest-sign-in.ts";
import { mindSignInResponse } from "./mind-sign-in.ts";
import { vouchResponse } from "./vouch.ts";
import { firstPasskeyResponse } from "./enrolment.ts";
import { configOf, dashOf, type Env, issuerOf } from "./env.ts";
import { identityIntakeResponse, identityLogResponse } from "./identity.ts";
import { keyTokenResponse } from "./key-tokens.ts";
import { keysPagesResponse } from "./keys-pages.ts";
import { isMemberSession, membersResponse } from "./members.ts";
import { mindsPageResponse } from "./minds-page.ts";
import {
  AUTHORIZE_ENDPOINT,
  authorizationServer,
  CLIENT_REGISTRATION_ENDPOINT,
  withKnownResource,
  tokenEndpointResponse,
  TOKEN_ENDPOINT,
} from "./oauth.ts";
import { errorPage, notMemberPage, signInPage, SIGN_OUT_PATH } from "./pages.ts";
import { passkeySignInResponse } from "./passkey-sign-in.ts";
import { selfTestResponse } from "./self-test.ts";
import { SESSIONS_PATH, sessionsResponse } from "./sessions-page.ts";
import { AFTER_SIGN_OUT, SIGN_IN_PATH, signOutResponse } from "./sign-in.ts";
import { statementDraftsResponse } from "./statement-drafts.ts";
import { statementsResponse } from "./statements.ts";
import { whoIs } from "./who-is.ts";

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
  // THE MIND'S IDENTITY (./identity.ts): its log of signed records to read, and the next record
  // to post. Neither asks who sends: a record proves itself.
  if (pathname === MIND_IDENTITY_PATH && get)
    return identityLogResponse(env, {
      hostname: url.hostname,
      after: url.searchParams.get("after"),
    });
  if (pathname === MIND_IDENTITY_PATH && request.method === "POST")
    return identityIntakeResponse(env, request);
  // The control-plane hostname has no start page: `/` leads to the mind's Dash, whose own
  // sign-in decides the rest. A signed-in person who is no member would only be refused there:
  // that person reads it here.
  if (pathname === "/" && get) {
    const session = await personSessionOf(env, request);
    if (session && !(await isMemberSession(env, session)))
      return notMemberPage({ mind: configOf(env).controlPlaneHostname, email: session.email });
    // A control plane at `dash.<zone>` is the Dash's own address: a redirect there would
    // come back here for ever, so this address shows where the person is signed in.
    const dash = dashOf(env);
    return new Response(null, {
      status: 302,
      headers: {
        location: dash === `${issuerOf(env)}/` ? SESSIONS_PATH : dash,
        "cache-control": "no-store",
      },
    });
  }
  const selfTest = await selfTestResponse(env, request);
  if (selfTest) return selfTest;
  // THE SIGN-IN PAGE OPENS ON THE FIRST METHOD of the sign-in that `next` goes on to
  // (./asking-app.ts `signInOf`): the mailed code's address form for an app whose people sign in
  // by mail first, else the passkey's prompt, as on the control plane's own sign-in.
  if (pathname === SIGN_IN_PATH && get) {
    const next = url.searchParams.get("next") || "/";
    const signIn = await signInOf(env, next);
    if (!signIn) return errorPage(TOO_MANY, 429);
    // a guest comes in by an app's own sign-in alone (./guest-sign-in.ts)
    const methods = signIn.app
      ? signIn.methods
      : signIn.methods.filter((m) => m !== "guest" && m !== "mind");
    if (methods[0] === "guest") return Response.redirect(guestFormHref(env, next), 302);
    // a member of another mind comes in by an app's own sign-in alone (./mind-sign-in.ts)
    if (methods[0] === "mind")
      return Response.redirect(
        `${issuerOf(env)}/sign-in/mind?${new URLSearchParams({ next })}`,
        302,
      );
    if (methods[0] === "email") return emailAddressPage(env, next, signIn);
    return signInPage({
      mind: configOf(env).controlPlaneHostname,
      next,
      app: signIn.app,
      offersEmail: methods.includes("email"),
      offersGuest: methods.includes("guest"),
      offersMind: methods.includes("mind"),
      asksAtOpen: !url.searchParams.has(AFTER_SIGN_OUT),
    });
  }
  const members = await membersResponse(env, request, (token, resource) =>
    whoIs(env, token, resource),
  );
  if (members) return members;
  const emailSignIn = await emailSignInResponse(env, request);
  if (emailSignIn) return emailSignIn;
  const guestSignIn = await guestSignInResponse(env, request);
  if (guestSignIn) return guestSignIn;
  const mindSignIn = await mindSignInResponse(env, request);
  if (mindSignIn) return mindSignIn;
  const vouch = await vouchResponse(env, request);
  if (vouch) return vouch;
  const accessSignIn = await accessSignInResponse(env, request);
  if (accessSignIn) return accessSignIn;
  const passkeySignIn = await passkeySignInResponse(env, request);
  if (passkeySignIn) return passkeySignIn;
  if (pathname === SIGN_OUT_PATH && request.method === "POST") return signOutResponse(env, request);
  const firstPasskey = await firstPasskeyResponse(env, request);
  if (firstPasskey) return firstPasskey;
  if (pathname === KEY_TOKEN_PATH && request.method === "POST")
    return keyTokenResponse(env, request);
  const sessions = await sessionsResponse(env, request);
  if (sessions) return sessions;
  const minds = await mindsPageResponse(env, request);
  if (minds) return minds;
  const keys = await keysPagesResponse(env, request);
  if (keys) return keys;
  if (pathname === STATEMENTS_PATH && request.method === "POST")
    return statementsResponse(env, request);
  const drafts = await statementDraftsResponse(env, request);
  if (drafts) return drafts;
  return authorizationServer(env).fetch(request, env, ctx);
}
