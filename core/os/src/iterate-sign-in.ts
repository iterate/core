// iterate-sign-in.ts — LOG IN WITH ITERATE: `login.methods.iterate` names another iterate deployment
// (prd, os.iterate.com) whose word this one takes on who a browser is. Its deep link,
// `/.auth/sign-in/iterate?next=<path>`, which the sign-in page's "Log in with iterate" goes to and
// another app may link to straight, starts an ordinary OAuth code flow at that issuer whose one
// resource is its `/oauth2/userinfo`: the grant can read who the person is and nothing else
// (api.ts `userinfoResponse`; `/api` and `/mcp` refuse its token by audience, RFC 8707). The
// address the issuer vouches for is signed in here as themselves when `login.allow` admits it, as
// every method's is, and, with `adminsOnly`, when `admins` lists it too: a preview takes prd's word
// for its admins alone (envs.ts `previewDeployment`), so a PR's reviewer signs in with the prd
// session they already have.
//
// This deployment is the issuer's CIMD client, its metadata document served here
// (`iterateSignInClientMetadata`), so no deployment is registered anywhere by hand. The token is read
// once and revoked at once; the issuer's grant ends in ten minutes besides (consent.ts). The flow's
// state lives in one cookie signed like every platform claim set (iterate-config.ts
// `sessionSigningSecretOf`, kind `iterate-sign-in`): where the browser goes next, the OAuth `state`
// and the PKCE verifier, for ten minutes. Nothing is stored server-side.

import * as oauth from "oauth4webapi";
import { z } from "zod";
import { cookieValueOf, sameOriginPath } from "iterate/lib";
import { authorizationCodeRequest, authorizationServer } from "iterate/oauth";
import { ITERATE_SIGN_IN_CLIENT_PATH, ITERATE_SIGN_IN_PATH } from "iterate/app-server";
import { emailAllowed, EMAIL_NOT_ALLOWED_MESSAGE } from "./allowed-emails.ts";
import {
  iterateConfigOf,
  platformAddressesOf,
  type IterateConfig,
  sessionSigningSecretOf,
  USERINFO_PATH,
} from "./iterate-config.ts";
import { signClaims, verifyClaims } from "./caller.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import { startIssuerSession } from "./issuer-session.ts";
import { isAdmin } from "./oauth.ts";
import { watchSignInStep } from "./sign-in-watch.ts";

/** Where the sign-in starts (`?next=`, a path on this origin), where the issuer sends the browser
 *  back, and where this deployment's CIMD document is — each answered by worker.ts only where
 *  `login.methods.iterate` is set. */
export { ITERATE_SIGN_IN_CLIENT_PATH, ITERATE_SIGN_IN_PATH };
export const ITERATE_SIGN_IN_CALLBACK_PATH = `${ITERATE_SIGN_IN_PATH}/callback`;

/** Whether `issuer` is the origin this request reached the deployment on: a sign-in there would
 *  start again at itself. */
export const issuerIsThisOrigin = (issuer: string, platformOrigin: string) =>
  new URL(issuer).origin === new URL(platformOrigin).origin;

/** The method's settings (iterate-config.ts `login.methods.iterate`). */
type IterateSignIn = NonNullable<IterateConfig["login"]["methods"]["iterate"]>;

/** The cookie holding one browser's pending sign-in. `__Host-`: this origin's alone; `itx-`: a
 *  platform cookie, which no project app is handed or may set (browser-client.ts `appCookies`,
 *  worker.ts `withoutPlatformHeaders`) — under paths routing the app shares this origin. */
const FLOW_COOKIE = "__Host-itx-iterate-sign-in";
const FLOW_MS = 10 * 60_000;
const clearFlowCookie = `${FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/** The flow cookie's claims; `kind` tells them apart from every other claim set the session-signing
 *  secret signs. */
const Flow = z.object({
  kind: z.literal("iterate-sign-in"),
  /** where the browser goes once signed in: a path on this origin */
  next: z.string(),
  state: z.string(),
  verifier: z.string(),
  exp: z.number(),
});

/** This deployment as the issuer's OAuth client: a public client (PKCE, no secret) whose one
 *  redirect is the callback. The issuer fetches it by its URL, the client id (CIMD). */
export function iterateSignInClientMetadata(platformOrigin: string) {
  return {
    client_id: `${platformOrigin}${ITERATE_SIGN_IN_CLIENT_PATH}`,
    client_name: new URL(platformOrigin).host,
    client_uri: platformOrigin,
    logo_uri: `${platformOrigin}/iterate-logo.svg`,
    redirect_uris: [`${platformOrigin}${ITERATE_SIGN_IN_CALLBACK_PATH}`],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

/** `GET /.auth/sign-in/iterate?next=`: send the browser to sign in at the method's issuer, asking
 *  only who they are, with the cookie that remembers `next` meanwhile. */
export async function iterateSignInResponse(request: Request, env: Env, { issuer }: IterateSignIn) {
  const config = iterateConfigOf(env);
  const { platformOrigin } = platformAddressesOf(env, request);
  // a deployment with a blank `urls.os` learns its origin per request: one that is the issuer
  // would send the browser back to itself, round and round
  if (issuerIsThisOrigin(issuer, platformOrigin))
    return new Response(
      `log in with iterate names this deployment (${platformOrigin}) as its issuer; set login.methods.iterate.issuer to another deployment's origin\n`,
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  const next = sameOriginPath(
    new URL(request.url).searchParams.get("next") || "/login",
    platformOrigin,
  );
  const { url, state, verifier } = await authorizationCodeRequest({
    issuer,
    clientId: `${platformOrigin}${ITERATE_SIGN_IN_CLIENT_PATH}`,
    redirectUri: `${platformOrigin}${ITERATE_SIGN_IN_CALLBACK_PATH}`,
    resources: [`${issuer}${USERINFO_PATH}`],
  });
  const flow = await signClaims(
    {
      kind: "iterate-sign-in",
      next,
      state,
      verifier,
      exp: Date.now() + FLOW_MS,
    } satisfies z.infer<typeof Flow>,
    await sessionSigningSecretOf(config),
  );
  return new Response(null, {
    status: 302,
    headers: {
      location: url.href,
      "set-cookie": `${FLOW_COOKIE}=${flow}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${FLOW_MS / 1000}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** `GET /.auth/sign-in/iterate/callback`: the issuer's answer. An address `login.allow` admits
 *  (and, with `adminsOnly`, `admins` lists) is signed in here as themselves, the issuer session
 *  started exactly as a password sign-in starts it, and sent on to the flow's `next`; anyone else
 *  lands back on the sign-in page with why, and every outcome is logged with the address the issuer
 *  vouched for. */
export async function iterateSignInCallbackResponse(
  request: Request,
  env: Env,
  { issuer, adminsOnly }: IterateSignIn,
) {
  const config = iterateConfigOf(env);
  const refused = (error: string, next = "/login") => {
    const headers = new Headers({
      location: `/login?${new URLSearchParams({ next, error })}`,
      "cache-control": "no-store",
    });
    headers.append("set-cookie", clearFlowCookie);
    return new Response(null, { status: 303, headers });
  };
  const checked = await whoSignedIn({
    issuer,
    platformOrigin: platformAddressesOf(env, request).platformOrigin,
    signingSecret: await sessionSigningSecretOf(config),
    request,
  }).catch((error: unknown) => {
    console.warn({ event: "iterate-sign-in.check-failed", message: String(error) });
    return { error: `Could not confirm who you are at ${issuer}. Try again.` };
  });
  if ("error" in checked) return refused(checked.error);
  if (adminsOnly && !isAdmin(env, checked.email)) {
    console.warn({ event: "iterate-sign-in.refused-not-admin", email: checked.email });
    return refused(`${checked.email} is not an admin here. Sign in another way.`, checked.next);
  }
  if (!emailAllowed(config.login, checked.email)) {
    console.warn({ event: "iterate-sign-in.refused-not-allowed", email: checked.email });
    return refused(EMAIL_NOT_ALLOWED_MESSAGE, checked.next);
  }
  const user = await watchSignInStep(
    "ensure-user",
    new ControlPlane(env).ensureUser(checked.email),
  );
  const session = await startIssuerSession(env, request, user, checked.next, {
    signedInVia: issuer,
  });
  if ("error" in session) return refused(session.error, checked.next);
  console.info({ event: "iterate-sign-in.signed-in", email: checked.email });
  const headers = new Headers({
    location: session.location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", session.setCookie);
  headers.append("set-cookie", clearFlowCookie);
  return new Response(null, { status: 302, headers });
}

/** THE ISSUER'S ANSWER at the callback: the state checked against this browser's cookie, the code
 *  exchanged, the email read from `/oauth2/userinfo`, the token revoked. The `next` the sign-in was
 *  started for comes back with the email; a refusal is a sentence for the person. */
async function whoSignedIn(input: {
  issuer: string;
  platformOrigin: string;
  signingSecret: string;
  request: Request;
}): Promise<{ email: string; next: string } | { error: string }> {
  const cookie = cookieValueOf(input.request.headers.get("cookie"), FLOW_COOKIE);
  const flow = Flow.safeParse(await verifyClaims(cookie || "", input.signingSecret));
  if (!flow.success || flow.data.exp <= Date.now())
    return { error: "This sign-in expired or began in another browser. Start it again." };
  // the library serves revocation at its token endpoint (RFC 7009)
  const as = { ...authorizationServer(input.issuer) };
  as.revocation_endpoint = as.token_endpoint;
  const client = { client_id: `${input.platformOrigin}${ITERATE_SIGN_IN_CLIENT_PATH}` };
  let callback: URLSearchParams;
  try {
    callback = oauth.validateAuthResponse(
      as,
      client,
      new URL(input.request.url).searchParams,
      flow.data.state,
    );
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError)
      return { error: `Sign-in at ${input.issuer} was cancelled.` };
    return { error: "This sign-in expired or began in another browser. Start it again." };
  }
  const resource = `${input.issuer}${USERINFO_PATH}`;
  const options = {
    additionalParameters: { resource },
    signal: AbortSignal.timeout(10_000),
  } satisfies oauth.TokenEndpointRequestOptions;
  const tokens = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.None(),
      callback,
      `${input.platformOrigin}${ITERATE_SIGN_IN_CALLBACK_PATH}`,
      flow.data.verifier,
      options,
    ),
  );
  try {
    const response = await fetch(resource, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${resource} answered ${response.status}`);
    const { email } = z.object({ email: z.string() }).parse(await response.json());
    return { email, next: flow.data.next };
  } finally {
    // read once: the token has no further use here
    await oauth
      .revocationRequest(as, client, oauth.None(), tokens.access_token, {
        signal: AbortSignal.timeout(10_000),
      })
      .then((response) => response.body?.cancel())
      .catch((error: unknown) =>
        console.warn({
          event: "iterate-sign-in.userinfo-token-not-revoked",
          message: String(error),
        }),
      );
  }
}
