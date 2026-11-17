// cloudflare-sign-in.ts — SIGN IN WITH CLOUDFLARE, for the apps of the mind that take it. Off
// unless the config has the method (./config.ts `login.methods.cloudflare`) and the deploy bound
// the client's secret (./env.ts `cloudflareSignInOf`).
//
// WHAT IT IS FOR. An app on a mind hostname whose guard names `"cloudflare"` (iterate/sdk
// `auth.requirePerson`, which says how a guard judges the way). The page of the ways the app names
// (./pages.ts `methodsSignInPage`) has the button that starts here.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. Cloudflare says which of its users consented: an id and
// the address on that Cloudflare account. This Worker does not know that Cloudflare checked the
// address. So the sign-in never makes a member, and counts only where an app names it:
//   - the address links no one: the person is the Cloudflare user alone (./users.ts
//     `linkBySubject`), never the person a mailed code or Google proved that address for;
//   - it has a cookie of its own (./cookies.ts `cloudflareSessionOf`), which only the
//     authorization endpoint reads, for an app on a mind hostname that names Cloudflare
//     (./authorize.ts `sessionFor`); none of the mind's own pages reads it;
//   - a code or a token from it is for a mind hostname alone, never the mind's API, MCP server or
//     `/provide`, and says `member: false` whatever its address is (./oauth.ts `tokenIdentity`);
//   - an app's guard that names no ways takes every way but this one (iterate/sdk).
//
//   GET /sign-in/cloudflare            makes the state and the PKCE pair, keeps them in this
//                                      browser's cookie, and sends the browser to Cloudflare
//   GET /sign-in/cloudflare/callback   exchanges the code and asks Cloudflare who the token is
//                                      (`GET /user`). Then it REVOKES THE TOKEN before it answers,
//                                      or, with `keepAccess`, hands the tokens on to be a secret
//
// THE LEAST CLOUDFLARE GIVES. The consent asks one scope, `user-details.read`: the person's name
// and address, and nothing of an account. Cloudflare's addresses are constants here: nothing a
// request says moves them.
//
// WITHOUT `keepAccess` the consent asks no `offline_access`, so no refresh token comes; one that
// comes all the same is revoked. The access token is used for one request and is kept nowhere.
//
// WITH `keepAccess` (./config.ts) THE TOKENS BECOME A SECRET OF THE MIND, one for each person:
// `/secrets/cloudflare-sign-in-<user id>` (iterate/sign-in-access `cloudflareSignInSecretOf`),
// pinned to Cloudflare's API and to the token endpoint. The consent also asks `offline_access`,
// so the secret refreshes itself and outlives the first hour: the OAuth client must have the
// grant type `refresh_token`, or Cloudflare refuses the consent. The scope stays the one above,
// so the secret reaches no account. It reads the person's details, and it makes a new Cloudflare
// account in the person's name (`POST /accounts`, which Cloudflare gives to this scope). The
// mind's code names the secret by a placeholder and never reads a token. This Worker has no
// binding to the secrets Worker: the callback's answer carries the tokens to the boundary, which
// sets the secret (iterate/sign-in-access). A sign-in that ends in a refusal keeps nothing: its
// tokens are revoked. A later sign-in of the same person replaces the secret.
import { sameOriginPath } from "iterate/lib";
import {
  cloudflareSignInSecretOf,
  type SignInAccess,
  withSignInAccess,
} from "iterate/sign-in-access";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { z } from "zod";
import { AccountFacts } from "./account-facts.ts";
import { isBlocked } from "./blocked.ts";
import { clearFlowCookie, cloudflareSessionCookie, flowCookie, flowOf } from "./cookies.ts";
import {
  type CloudflareSignIn,
  cloudflareSignInOf,
  type Env,
  issuerOf,
  iterateConfigOf,
} from "./env.ts";
import { errorPage } from "./pages.ts";
import { signInHref } from "./sign-in.ts";
import { linkBySubject } from "./users.ts";

const CLOUDFLARE_SIGN_IN_PATH = "/sign-in/cloudflare";
/** The one redirect URI of this sign-in, registered on the Cloudflare OAuth client. */
const CALLBACK_PATH = `${CLOUDFLARE_SIGN_IN_PATH}/callback`;

/** The person's name and address, and nothing of an account. */
export const CLOUDFLARE_SIGN_IN_SCOPE = "user-details.read";
/** With `keepAccess`: a refresh token too, so that the secret outlives the first hour. */
const KEPT_ACCESS_SCOPE = `${CLOUDFLARE_SIGN_IN_SCOPE} offline_access`;
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
/** Where the kept tokens may go: Cloudflare's API, and the endpoint that refreshes them. */
const KEPT_ACCESS_URLS = ["https://api.cloudflare.com", "https://dash.cloudflare.com"];
/** What marks this browser's flow cookie as Cloudflare's: the cookie is the one Google's sign-in
 *  uses, where this field is the id_token's nonce, a random UUID. */
const FLOW_MARK = "cloudflare";

const keepsAccess = (env: Env) =>
  iterateConfigOf(env).login.methods.cloudflare?.keepAccess === true;

export async function cloudflareSignInResponse(
  env: Env,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== CLOUDFLARE_SIGN_IN_PATH && url.pathname !== CALLBACK_PATH) return null;
  const client = cloudflareSignInOf(env);
  if (!client || request.method !== "GET") return new Response("Not found", { status: 404 });
  return url.pathname === CLOUDFLARE_SIGN_IN_PATH
    ? start(env, client, url)
    : finish(env, client, request, url);
}

async function start(env: Env, client: CloudflareSignIn, url: URL): Promise<Response> {
  const issuer = issuerOf(env);
  const state = crypto.randomUUID();
  const verifier = generateRandomCodeVerifier();
  const consent = new URL("https://dash.cloudflare.com/oauth2/auth");
  consent.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: `${issuer}${CALLBACK_PATH}`,
    scope: keepsAccess(env) ? KEPT_ACCESS_SCOPE : CLOUDFLARE_SIGN_IN_SCOPE,
    state,
    code_challenge: await calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, {
    status: 303,
    headers: {
      location: consent.href,
      "set-cookie": await flowCookie(env, {
        next: sameOriginPath(url.searchParams.get("next") || "/", issuer),
        state,
        nonce: FLOW_MARK,
        verifier,
      }),
      "cache-control": "no-store",
    },
  });
}

async function finish(
  env: Env,
  client: CloudflareSignIn,
  request: Request,
  url: URL,
): Promise<Response> {
  const flow = await flowOf(env, request);
  const cleared = new Headers({ "set-cookie": clearFlowCookie });
  const again = [{ href: signInHref(flow?.next || "/"), label: "Try again" }];
  const code = url.searchParams.get("code");
  // The state binds Cloudflare's answer to the browser that began, and the mark to a flow that
  // began here, not at Google. A refusal at Cloudflare has no code.
  if (!flow || flow.nonce !== FLOW_MARK || url.searchParams.get("state") !== flow.state || !code)
    return errorPage("This sign-in was not finished, or it is too old.", 400, cleared, again);
  const person = await cloudflarePersonOf(
    client,
    { code, verifier: flow.verifier, redirectUri: `${issuerOf(env)}${CALLBACK_PATH}` },
    keepsAccess(env),
  );
  if (!person)
    return errorPage(
      "The sign-in with Cloudflare is not available now. Try again.",
      502,
      cleared,
      again,
    );
  // someone an owner blocked gets no session here either (./blocked.ts)
  if (await isBlocked(env, person.email)) {
    console.info({ event: "auth.sign-in-refused", method: "cloudflare", reason: "blocked" });
    if (person.kept) await revoke(client, person.kept);
    return errorPage(
      `${person.email} cannot sign in to ${iterateConfigOf(env).domain}.`,
      403,
      cleared,
    );
  }
  // The person is the Cloudflare user, by Cloudflare's own id: a changed address is the same person.
  const user = await linkBySubject(env.DB, { provider: "cloudflare", subject: person.id }).catch(
    (error: unknown) => {
      console.warn({ event: "auth.sign-in-link-failed", message: String(error) });
      return null;
    },
  );
  if (!user) {
    if (person.kept) await revoke(client, person.kept);
    return errorPage(
      "The sign-in with Cloudflare could not be finished. Try again.",
      500,
      cleared,
      again,
    );
  }
  console.info({
    event: "auth.signed-in",
    method: "cloudflare",
    userId: user.id,
    keptAccess: Boolean(person.kept),
  });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "cloudflare", at: Date.now() },
  });
  const headers = new Headers({ location: flow.next, "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    await cloudflareSessionCookie(env, { id: user.id, email: person.email }),
  );
  headers.append("set-cookie", clearFlowCookie);
  const answer = facts.on(new Response(null, { status: 303, headers }));
  if (!person.kept) return answer;
  return withSignInAccess(answer, keptAccessOf(client, user.id, person.kept));
}

const Tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
});
type Tokens = z.infer<typeof Tokens>;
const CloudflareUser = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.string().min(1),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[^@\s]+@[^@\s]+$/),
  }),
});

/** A form request to one of Cloudflare's OAuth endpoints, as this client. */
const formOf = (client: CloudflareSignIn, fields: Record<string, string>): RequestInit => ({
  method: "POST",
  // never followed: the client's secret goes to Cloudflare's own host alone
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    ...fields,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  }).toString(),
});

/** WHO CONSENTED AT CLOUDFLARE, or null: the code's exchange and one read of `/user`. With `keep`
 *  and a read that worked, the tokens come back beside the person, as `kept`. In every other case
 *  each token that came is revoked here, whatever the read answered, and none leaves this
 *  function. */
async function cloudflarePersonOf(
  client: CloudflareSignIn,
  input: { code: string; verifier: string; redirectUri: string },
  keep: boolean,
): Promise<{ id: string; email: string; kept?: Tokens } | null> {
  const answer = await fetch(
    TOKEN_ENDPOINT,
    formOf(client, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    }),
  );
  const tokens = Tokens.safeParse(await answer.json().catch(() => null));
  if (!answer.ok || !tokens.success) {
    console.warn({ event: "cloudflare-sign-in.exchange-failed", status: answer.status });
    return null;
  }
  let person: { id: string; email: string } | null = null;
  try {
    const read = await fetch("https://api.cloudflare.com/client/v4/user", {
      redirect: "manual",
      headers: { authorization: `Bearer ${tokens.data.access_token}` },
    });
    const user = CloudflareUser.safeParse(read.ok ? await read.json().catch(() => null) : null);
    if (user.success) person = user.data.result;
    else console.warn({ event: "cloudflare-sign-in.user-read-failed", status: read.status });
  } finally {
    // Without `keep` the sign-in is over: nothing here uses a Cloudflare token again.
    if (!keep || !person) await revoke(client, tokens.data);
  }
  if (!person) return null;
  return keep ? { ...person, kept: tokens.data } : person;
}

/** Asks Cloudflare to revoke each token. A failed revoke is said, and the access token ends by
 *  itself within the hour. */
async function revoke(client: CloudflareSignIn, tokens: Tokens): Promise<void> {
  for (const token of [tokens.access_token, tokens.refresh_token]) {
    if (!token) continue;
    const revoked = await fetch(
      "https://dash.cloudflare.com/oauth2/revoke",
      formOf(client, { token }),
    ).catch(() => null);
    await revoked?.body?.cancel();
    if (!revoked?.ok)
      console.warn({ event: "cloudflare-sign-in.revoke-failed", status: revoked?.status || 0 });
  }
}

/** The secret the boundary sets for the person `userId` (iterate/sign-in-access). With a refresh
 *  token, the secret's object refreshes the access itself, as this client: it then holds the
 *  client's id and secret beside the tokens, sealed like them. */
function keptAccessOf(client: CloudflareSignIn, userId: string, tokens: Tokens): SignInAccess {
  const path = cloudflareSignInSecretOf(userId);
  if (!tokens.refresh_token)
    return { path, material: { accessToken: tokens.access_token }, urls: KEPT_ACCESS_URLS };
  return {
    path,
    material: {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      // When the access token ends: the secret's object refreshes it then, before a request goes
      // (core/secrets-worker/src/secrets.ts `ACCESS_TOKEN_EXPIRES_AT`). Cloudflare answers an
      // ended token with 403, which starts no refresh.
      ...(tokens.expires_in && {
        accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      }),
    },
    urls: KEPT_ACCESS_URLS,
    refresh: {
      kind: "oauth-refresh-token",
      tokenEndpoint: TOKEN_ENDPOINT,
      clientAuth: "client_secret_post",
    },
  };
}
