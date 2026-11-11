// google-sign-in.ts — SIGN IN WITH GOOGLE, through the iterate Cloud's Google client.
//
// GOOGLE IS THE IDENTITY PROVIDER. The Cloud (`cloud.origin` in the stack's config) owns the one
// Google client every deployment shares, so it lends two things and no more: its client id with
// the one redirect URI Google knows, and its client secret at the code exchange. What says who
// signed in is Google's id_token, and this Worker checks it itself: Google's signature, by the keys
// Google publishes; the audience, the Cloud's client id; this browser's own nonce; an address that
// Google itself vouches for. The Cloud's word is never the identity.
//
//   GET /sign-in/google            makes the state, the nonce and the PKCE pair, keeps them in
//                                  this browser's cookie, and sends the browser to the Cloud's
//                                  page before Google's (it says which deployment signs in)
//   GET /sign-in/google/callback   where the Cloud sends Google's code: the exchange goes through
//                                  the Cloud's broker, signed by the stack's key, and answers the
//                                  id_token alone
//
// Google's addresses are constants here. The Cloud names its own addresses and its client id, and
// each of its addresses must be on the origin the config names.
//
// WHAT THE CLOUD COULD DO: it holds the client secret and the redirect URI, so a dishonest Cloud
// could send a person who passes through it to Google with this Worker's nonce, and hand over a
// genuine id_token for them. No check here stops that. So a sign-in at Google proves an address as
// a mailed code does (./keys.ts `addressProven`), unless the config says `signsInAlone`.
import { sameOriginPath } from "iterate/lib";
import { base64url } from "iterate/signed";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { isBlocked } from "./blocked.ts";
import { clearFlowCookie, flowCookie, flowOf, sessionCookie } from "./cookies.ts";
import { sha256Hex } from "./device/protocol.ts";
import { type Env, issuerOf, iterateConfigOf, offersGoogle } from "./env.ts";
import { googleAddressOf } from "./google-id-token.ts";
import { addressProven } from "./keys.ts";
import { isMember } from "./members.ts";
import { errorPage } from "./pages.ts";
import { signedByStack } from "./stack-key.ts";
import { linkIdentity } from "./users.ts";

/** The address of the button on the sign-in pages (./pages.ts `googleSignIn`). */
const GOOGLE_SIGN_IN_PATH = "/sign-in/google";
/** The Cloud sends a sign-in's code to this path and no other (internal-packages/cloud-clients). */
const CALLBACK_PATH = `${GOOGLE_SIGN_IN_PATH}/callback`;

const GOOGLE_KEYS = new URL("https://www.googleapis.com/oauth2/v3/certs");
/** The Cloud's name for its Google client. */
const CLIENT = "google";
const encoder = new TextEncoder();

/** Google's published keys, read once per isolate and again when a token names a new one. */
let googleKeys: JWTVerifyGetKey | undefined;

export async function googleSignInResponse(env: Env, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== GOOGLE_SIGN_IN_PATH && url.pathname !== CALLBACK_PATH) return null;
  if (!offersGoogle(env) || request.method !== "GET")
    return new Response("Not found", { status: 404 });
  return url.pathname === GOOGLE_SIGN_IN_PATH ? start(env, url) : finish(env, request, url);
}

/** What the Cloud publishes of its Google client (`GET <cloud>/.well-known/iterate-cloud`): the
 *  three facts this Worker takes from it. */
const CloudClient = z.object({
  clientId: z.string().min(1),
  beginEndpoint: z.url(),
  redirectUri: z.url(),
  tokenEndpoint: z.url(),
});

async function cloudClientOf(origin: string) {
  // a redirect is no answer: the facts are the ones this very origin serves
  const answer = await fetch(`${origin}/.well-known/iterate-cloud`, { redirect: "manual" });
  const facts: unknown = answer.ok ? await answer.json().catch(() => null) : null;
  const client = CloudClient.safeParse(
    z.object({ clients: z.record(z.string(), z.unknown()) }).safeParse(facts).data?.clients[CLIENT],
  );
  if (!client.success) return null;
  const { beginEndpoint, redirectUri, tokenEndpoint } = client.data;
  // no other host gets the browser, the code or the stack's signature
  return [beginEndpoint, redirectUri, tokenEndpoint].every(
    (each) => new URL(each).origin === origin,
  )
    ? client.data
    : null;
}

const unavailable = () =>
  errorPage(
    "The sign-in with Google is not available now. Try again, or sign in another way.",
    502,
  );

async function start(env: Env, url: URL): Promise<Response> {
  const issuer = issuerOf(env);
  const client = await cloudClientOf(env.CLOUD_ORIGIN!);
  if (!client) {
    console.warn({ event: "google-sign-in.no-cloud-client" });
    return unavailable();
  }
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const verifier = generateRandomCodeVerifier();
  // Google's own consent page, a constant: the Cloud is not asked where Google is
  const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  consent.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: "openid email",
    // the Cloud reads where the code goes from the state's first part, and sends the rest on
    state: `${base64url(encoder.encode(`${issuer}${CALLBACK_PATH}`))}.${state}`,
    nonce,
    code_challenge: await calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  const begin = new URL(client.beginEndpoint);
  begin.searchParams.set("to", consent.href);
  return new Response(null, {
    status: 303,
    headers: {
      location: begin.href,
      "set-cookie": await flowCookie(env, {
        next: sameOriginPath(url.searchParams.get("next") || "/", issuer),
        state,
        nonce,
        verifier,
      }),
      "cache-control": "no-store",
    },
  });
}

async function finish(env: Env, request: Request, url: URL): Promise<Response> {
  const flow = await flowOf(env, request);
  const cleared = new Headers({ "set-cookie": clearFlowCookie });
  const again = [
    {
      href: `${GOOGLE_SIGN_IN_PATH}?${new URLSearchParams({ next: flow?.next || "/" })}`,
      label: "Try again",
    },
  ];
  const code = url.searchParams.get("code");
  // the state binds Google's answer to the browser that began; a refusal at Google has no code
  if (!flow || url.searchParams.get("state") !== flow.state || !code)
    return errorPage("This sign-in was not finished, or it is too old.", 400, cleared, again);
  const client = await cloudClientOf(env.CLOUD_ORIGIN!);
  const idToken = client
    ? await exchanged(env, client.tokenEndpoint, {
        code,
        verifier: flow.verifier,
        proof: url.searchParams.get("cloud_proof") || "",
      })
    : null;
  if (!client || !idToken) return unavailable();
  googleKeys ||= createRemoteJWKSet(GOOGLE_KEYS);
  const google = await googleAddressOf(idToken, {
    keys: googleKeys,
    clientId: client.clientId,
    nonce: flow.nonce,
  });
  if ("refused" in google) {
    console.info({ event: "google-sign-in.refused", reason: google.reason });
    return errorPage(google.refused, 403, cleared, again);
  }
  // someone an owner blocked gets no session here, as they get no mailed code (./blocked.ts)
  if (!(await isMember(env, google.email)) && (await isBlocked(env, google.email))) {
    console.info({ event: "auth.sign-in-refused", method: "google", reason: "blocked" });
    return errorPage(
      `${google.email} cannot sign in to ${iterateConfigOf(env).domain}.`,
      403,
      cleared,
    );
  }
  // Google proved an address; `login.allow` still decides who is a member
  const user = await linkIdentity(env.DB, {
    provider: "email",
    subject: google.email,
    email: google.email,
  }).catch((error: unknown) => {
    console.warn({ event: "auth.sign-in-link-failed", message: String(error) });
    return null;
  });
  if (!user)
    return errorPage(
      `${google.email} belongs to another account here. Ask the mind's owner.`,
      403,
      cleared,
    );
  const alone = Boolean(iterateConfigOf(env).login.methods.google?.signsInAlone);
  const proven =
    alone && (await isMember(env, user.email))
      ? { location: flow.next }
      : await addressProven(env, user, flow.next);
  if ("refused" in proven) {
    console.info({ event: "auth.sign-in-refused", method: "google", userId: user.id });
    return errorPage(proven.refused, 403, cleared, [
      {
        href: `/sign-in?${new URLSearchParams({ next: flow.next })}`,
        label: "Sign in with the passkey",
      },
    ]);
  }
  console.info({ event: "auth.signed-in", method: "google", userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "google", at: Date.now() },
  });
  const headers = new Headers({ location: proven.location, "cache-control": "no-store" });
  headers.append("set-cookie", await sessionCookie(env, user, "google"));
  headers.append("set-cookie", clearFlowCookie);
  return facts.on(new Response(null, { status: 303, headers }));
}

/** THE CODE EXCHANGE, through the Cloud's broker: the Cloud adds its client secret and answers
 *  Google's id_token alone. The request goes with a statement the stack's key signed over this
 *  very request, so the Cloud knows which deployment asks. */
async function exchanged(
  env: Env,
  tokenEndpoint: string,
  input: { code: string; verifier: string; proof: string },
): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    cloud_proof: input.proof,
  }).toString();
  const endpoint = new URL(tokenEndpoint);
  const signed = await signedByStack(env, {
    path: "/",
    // the type the Cloud's broker expects on its token route
    type: "events.iterate.com/integration/token-requested",
    payload: {
      audience: endpoint.origin,
      client: CLIENT,
      path: endpoint.pathname,
      body: await sha256Hex(body),
    },
    expiresInSeconds: 300,
  });
  // never followed: the statement and the code go to the Cloud's own host alone
  const answer = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "iterate-statement": base64url(encoder.encode(JSON.stringify(signed))),
    },
    body,
  });
  const tokens = z
    .object({ id_token: z.string().min(1) })
    .safeParse(answer.ok ? await answer.json().catch(() => null) : null);
  if (!tokens.success) {
    console.warn({ event: "google-sign-in.exchange-failed", status: answer.status });
    return null;
  }
  return tokens.data.id_token;
}
