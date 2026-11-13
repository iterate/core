// cloudflare-sign-in.ts — SIGN IN WITH CLOUDFLARE, for the hostnames of the mind that take no
// other sign-in. Off unless the config has the method (./config.ts `login.methods.cloudflare`)
// and the deploy bound the client's secret (./env.ts `cloudflareSignInOf`).
//
// WHAT IT IS FOR. A hostname the config names there is signed in with Cloudflare alone: a code or a token for it is given to a person who signed in here, and to
// nobody else (./authorize.ts, ./oauth.ts `tokenIdentity`). Every other hostname, the API and the
// MCP server keep the sign-ins they had, and this one counts for none of them.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. Cloudflare says which of its users consented: an id and
// the address on that Cloudflare account. This Worker does not know that Cloudflare checked the
// address. So the sign-in never makes a member: it has a cookie of its own
// (./cookies.ts `cloudflareSessionOf`) that only the authorization endpoint reads, and only for
// those hostnames, and a token from it says `member: false` whatever its address is.
//
//   GET /sign-in/cloudflare            makes the state and the PKCE pair, keeps them in this
//                                      browser's cookie, and sends the browser to Cloudflare
//   GET /sign-in/cloudflare/callback   exchanges the code, asks Cloudflare who the token is
//                                      (`GET /user`), and REVOKES THE TOKEN before it answers
//
// THE LEAST CLOUDFLARE GIVES. The consent asks one scope, `user-details.read`, and no
// `offline_access`, so no refresh token comes; one that comes all the same is revoked. The access
// token reads the person's name and address, is used for one request, and is kept nowhere.
// Cloudflare's addresses are constants here: nothing a request says moves them.
import { sameOriginPath } from "iterate/lib";
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
import { linkIdentity } from "./users.ts";

const CLOUDFLARE_SIGN_IN_PATH = "/sign-in/cloudflare";
/** The one redirect URI of this sign-in, registered on the Cloudflare OAuth client. */
const CALLBACK_PATH = `${CLOUDFLARE_SIGN_IN_PATH}/callback`;

/** The person's name and address, and nothing of an account. */
export const CLOUDFLARE_SIGN_IN_SCOPE = "user-details.read";
/** What marks this browser's flow cookie as Cloudflare's: the cookie is the one Google's sign-in
 *  uses, where this field is the id_token's nonce, a random UUID. */
const FLOW_MARK = "cloudflare";

/** Where a person signs in for a hostname that takes Cloudflare alone, then goes on to `next`. */
export const cloudflareSignInHref = (next: string) =>
  `${CLOUDFLARE_SIGN_IN_PATH}?${new URLSearchParams({ next })}`;

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
    scope: CLOUDFLARE_SIGN_IN_SCOPE,
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
  const again = [{ href: cloudflareSignInHref(flow?.next || "/"), label: "Try again" }];
  const code = url.searchParams.get("code");
  // The state binds Cloudflare's answer to the browser that began, and the mark to a flow that
  // began here, not at Google. A refusal at Cloudflare has no code.
  if (!flow || flow.nonce !== FLOW_MARK || url.searchParams.get("state") !== flow.state || !code)
    return errorPage("This sign-in was not finished, or it is too old.", 400, cleared, again);
  const person = await cloudflarePersonOf(client, {
    code,
    verifier: flow.verifier,
    redirectUri: `${issuerOf(env)}${CALLBACK_PATH}`,
  });
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
    return errorPage(
      `${person.email} cannot sign in to ${iterateConfigOf(env).domain}.`,
      403,
      cleared,
    );
  }
  // The person is the Cloudflare user, by Cloudflare's own id: a changed address is the same person.
  const user = await linkIdentity(env.DB, {
    provider: "cloudflare",
    subject: person.id,
    email: person.email,
  }).catch((error: unknown) => {
    console.warn({ event: "auth.sign-in-link-failed", message: String(error) });
    return null;
  });
  if (!user)
    return errorPage(
      `${person.email} belongs to another Cloudflare account here. Ask the mind's owner.`,
      403,
      cleared,
    );
  console.info({ event: "auth.signed-in", method: "cloudflare", userId: user.id });
  const facts = new AccountFacts();
  facts.add(user.id, {
    type: "events.iterate.com/account/signed-in",
    payload: { method: "cloudflare", at: Date.now() },
  });
  const headers = new Headers({ location: flow.next, "cache-control": "no-store" });
  headers.append("set-cookie", await cloudflareSessionCookie(env, user));
  headers.append("set-cookie", clearFlowCookie);
  return facts.on(new Response(null, { status: 303, headers }));
}

const Tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
});
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

/** WHO CONSENTED AT CLOUDFLARE, or null: the code's exchange, one read of `/user`, and the revoke
 *  of every token that came, whatever the read answered. No token leaves this function. */
async function cloudflarePersonOf(
  client: CloudflareSignIn,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<{ id: string; email: string } | null> {
  const form = (fields: Record<string, string>): RequestInit => ({
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
  const answer = await fetch(
    "https://dash.cloudflare.com/oauth2/token",
    form({
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
  try {
    const read = await fetch("https://api.cloudflare.com/client/v4/user", {
      redirect: "manual",
      headers: { authorization: `Bearer ${tokens.data.access_token}` },
    });
    const user = CloudflareUser.safeParse(read.ok ? await read.json().catch(() => null) : null);
    if (!user.success) {
      console.warn({ event: "cloudflare-sign-in.user-read-failed", status: read.status });
      return null;
    }
    return user.data.result;
  } finally {
    // The sign-in is over: nothing here uses a Cloudflare token again. A failed revoke is said,
    // and the token ends by itself within the hour.
    for (const token of [tokens.data.access_token, tokens.data.refresh_token]) {
      if (!token) continue;
      const revoked = await fetch(
        "https://dash.cloudflare.com/oauth2/revoke",
        form({ token }),
      ).catch(() => null);
      await revoked?.body?.cancel();
      if (!revoked?.ok)
        console.warn({ event: "cloudflare-sign-in.revoke-failed", status: revoked?.status || 0 });
    }
  }
}
