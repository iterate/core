// THE DEVICE LOGIN: RFC 8628's device authorization grant, for a CLI or an agent on a computer
// whose browser nobody sees. @cloudflare/workers-oauth-provider has none, and its maintainers plan
// none (cloudflare/workers-oauth-provider#192); nor has it a grant-type extension point. So this
// layer answers before the library's `fetch()` (api.ts) and redeems through it:
//   1. `POST /oauth2/device_authorization`: a public client that registered `CALLBACK_PATH` asks
//      for `/api` with `iterate` and a PKCE challenge, and gets a device code and a user code.
//   2. `/oauth2/device` (page.server.ts): the person, signed in, enters the code and checks the
//      device. Continue confirms the request for them and opens the consent page, unchanged, with
//      `state` the device code's hash.
//   3. The consent redirects to `CALLBACK_PATH`, which keeps the code for the person who confirmed.
//   4. The device's poll (with its PKCE verifier) is `authorization_pending` until then, then the
//      library's own code exchange: tokens, lifetimes and `grantLifetime` (oauth.ts) are unchanged.
//
// A code is exchanged once and its tokens are never stored here, so a token answer lost on its way
// to the device cannot be sent again. The next poll then ends the sign-in with a clear error and
// ends the grant, so no tokens stay alive that nobody holds.
import { CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { calculatePKCECodeChallenge } from "oauth4webapi";
import { z } from "zod";
import type { GrantEnded } from "../account/contract.ts";
import { browserAuthorization } from "../browser-client.ts";
import { base64url, sha256Hex } from "../caller.ts";
import { clientDisplay } from "../client-display.ts";
import type { Env } from "../env.ts";
import type { PlatformAddresses } from "../iterate-config.ts";
import { authorizationServerFetch, oauthHelpers, revokeGrant, TOKEN_ENDPOINT } from "../oauth.ts";
import { appendPlatformFacts } from "../session.ts";
import {
  CALLBACK_PATH,
  DeviceAuthorizationForm,
  DevicePollForm,
  formOf,
  oauthError,
  RequestedFrom,
  userCodeOf,
  VERIFICATION_PATH,
} from "./protocol.ts";
import { deviceStore, type StoredRequest } from "./store.ts";

/** How long a device code waits for its answer: five minutes, RFC 8628 §5.4's advice against a
 *  code someone else sent. The CLI waits no longer. */
const DEVICE_CODE_SECONDS = 300;
/** At most this many device logins wait at once, platform-wide: the rows a stranger can make
 *  without signing in stay bounded, whatever the per-address limit lets through. */
const LIVE_REQUESTS_CAP = 1000;

/** The device login's answer to `request`, or null for every request the library answers (api.ts),
 *  the token endpoint's other grants included. */
export async function deviceLoginResponse(
  request: Request,
  env: Env,
  addresses: PlatformAddresses,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/oauth2/device_authorization" && request.method === "POST")
    return start(request, env, addresses);
  if (pathname === CALLBACK_PATH && request.method === "GET")
    return callback(request, env, addresses);
  if (pathname === TOKEN_ENDPOINT && request.method === "POST")
    return poll(request, env, addresses, ctx);
  return null;
}

/** RFC 8628 §3.1–3.2, for a public client alone (the exchange sends no secret). A code someone else
 *  sent must reach no key, no session and no admin: only `iterate` on `/api`. */
async function start(request: Request, env: Env, addresses: PlatformAddresses) {
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await env.DEVICE_LOGIN_START_LIMIT.limit({ key: address })).success) {
    console.warn({ event: "device-login.rate-limited", limit: "start" });
    return tooMany("Too many sign-ins from this address. Try again in a minute.");
  }
  const form = DeviceAuthorizationForm.safeParse(await formOf(request));
  if (!form.success)
    return refused(
      "invalid_request",
      "client_id, resource and a PKCE S256 code_challenge are required",
    );
  const { client_id: clientId, resource, code_challenge: codeChallenge } = form.data;
  if (form.data.scope.split(" ").some((scope) => scope && scope !== "iterate"))
    return refused("invalid_scope", "The device flow grants the iterate scope alone.");
  if (resource !== addresses.api)
    return refused("invalid_target", `The device flow grants ${addresses.api} alone.`);
  const callbackUrl = `${addresses.platformOrigin}${CALLBACK_PATH}`;
  const client = await oauthHelpers(env, addresses)
    .lookupClient(clientId)
    .catch((error: unknown) => {
      if (error instanceof CimdFetchError) return null;
      throw error;
    });
  if (!client) return refused("invalid_client", "Unknown client", 401);
  if (client.tokenEndpointAuthMethod !== "none" || !client.redirectUris.includes(callbackUrl))
    return refused(
      "unauthorized_client",
      `A device login needs a public client registered with the redirect URI ${callbackUrl}.`,
    );

  const store = deviceStore(env);
  if ((await store.liveRequests(LIVE_REQUESTS_CAP)) >= LIVE_REQUESTS_CAP) {
    console.warn({ event: "device-login.rate-limited", limit: "live-requests" });
    return tooMany("Too many sign-ins are waiting. Try again in a minute.", 503);
  }
  const now = Date.now();
  const requestedFrom = RequestedFrom.parse(request.cf ?? {});
  // a user code a live request holds already draws a new device code; three in a row mean the
  // store answers wrongly, not chance
  for (let attempt = 0; attempt < 3; attempt++) {
    // 256 random bits, of which the platform keeps only the SHA-256
    const deviceCode = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha256Hex(deviceCode);
    const userCode = userCodeOf(hash);
    const stored =
      userCode &&
      (await store.start(userCode, {
        status: "pending",
        hash,
        clientId,
        clientName: clientDisplay(client, clientId).clientName,
        codeChallenge,
        resource,
        requestedFrom,
        createdAt: now,
        expiresAt: now + DEVICE_CODE_SECONDS * 1000,
      }));
    if (!stored) continue;
    console.info({ event: "device-login.started", clientId, country: requestedFrom.country });
    const verificationUri = `${addresses.platformOrigin}${VERIFICATION_PATH}`;
    return Response.json(
      {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?${new URLSearchParams({ user_code: userCode })}`,
        expires_in: DEVICE_CODE_SECONDS,
        // RFC 8628 §3.2's default
        interval: 5,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  throw new Error("Three fresh user codes were all taken.");
}

/** `GET /oauth2/device/callback`: where the consent page sends the browser with the code, or with
 *  its refusal. It answers only for the issuer session of the person who confirmed the device, and
 *  keeps a code only for that person's own grant, so a link with a known `state` answers nobody
 *  else's request. The first answer stands. A code it does not keep is ended at once, if it is the
 *  signed-in person's own: a code's ids are its text, which anyone can write. */
async function callback(request: Request, env: Env, addresses: PlatformAddresses) {
  const url = new URL(request.url);
  const outcome = (to: "approved" | "declined" | "failed") =>
    new Response(null, {
      status: 303,
      headers: {
        location: `${VERIFICATION_PATH}?${new URLSearchParams({ outcome: to })}`,
        "cache-control": "no-store",
      },
    });
  const code = url.searchParams.get("code");
  const codeGrant = code ? grantOfCode(code) : null;
  const store = deviceStore(env);
  const state = url.searchParams.get("state") || "";
  const found =
    url.searchParams.get("iss") === addresses.platformOrigin && /^[0-9a-f]{64}$/.test(state)
      ? await store.byHash(state)
      : null;
  // the same callback again (a reload, the back button, a retried redirect): nothing to answer
  if (codeGrant && found?.request.grant?.grantId === codeGrant.grantId) return outcome("approved");
  // the issuer's own session alone, as consent-page.server.ts `issuerSignIn` admits it: that module
  // brings the React router, which API traffic never loads (issuer-pages.ts)
  const signedIn = await browserAuthorization(env, request);
  const person = signedIn?.grant?.kind === "issuer" ? signedIn.grant.userId : null;
  const ownGrant = codeGrant && codeGrant.userId === person ? codeGrant : null;
  const refusal = callbackRefusal(found, person, !code || Boolean(ownGrant));
  if (!found || refusal) {
    if (ownGrant) await endGrant(env, addresses, ownGrant);
    console.warn({ event: "device-login.callback-refused", reason: refusal });
    return outcome("failed");
  }
  const device = found.request;
  // past the refusals a code comes with its grant, the person's own: no code is the consent's
  // refusal (Cancel, or a request it could not approve)
  if (!code || !ownGrant) {
    const error = url.searchParams.get("error") || "access_denied";
    const description = url.searchParams.get("error_description") || "The person declined.";
    if (!(await store.swap(found, { ...device, status: "ended", error, description })))
      return outcome("failed");
    console.info({ event: "device-login.denied", clientId: device.clientId, error });
    return outcome(error === "access_denied" ? "declined" : "failed");
  }
  if (!(await store.swap(found, { ...device, status: "approved", code, grant: ownGrant }))) {
    // the winner of a race with the same code keeps this very grant: end it only if it is another
    const winner = await store.byHash(state);
    if (winner?.request.grant?.grantId === ownGrant.grantId) return outcome("approved");
    await endGrant(env, addresses, ownGrant);
    return outcome("failed");
  }
  console.info({ event: "device-login.approved", clientId: device.clientId, userId: person });
  return outcome("approved");
}

/** A poll of the token endpoint (RFC 8628 §3.4–3.5), or null for any other grant. Nothing is
 *  written per poll. Every failure after the consent ends the grant BEFORE it ends the request, so
 *  an end that fails leaves the request for the next poll to try again. */
async function poll(
  request: Request,
  env: Env,
  addresses: PlatformAddresses,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const fields = await formOf(request.clone());
  if (fields.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") return null;
  const form = DevicePollForm.safeParse(fields);
  if (!form.success)
    return refused("invalid_request", "device_code, client_id and code_verifier are required");
  const store = deviceStore(env);
  const hash = await sha256Hex(form.data.device_code);
  const found = await store.byHash(hash);
  if (
    !found ||
    found.request.clientId !== form.data.client_id ||
    (await calculatePKCECodeChallenge(form.data.code_verifier)) !== found.request.codeChallenge
  )
    return refused("invalid_grant", "Unknown device code");
  if (!(await env.DEVICE_LOGIN_POLL_LIMIT.limit({ key: hash })).success) {
    console.warn({ event: "device-login.rate-limited", limit: "poll" });
    return oauthError("slow_down", "Poll less often: add five seconds to the interval.");
  }
  const device = found.request;
  const end = async (event: string, error: string, description: string) => {
    if (device.grant) await endGrant(env, addresses, device.grant);
    const ended = { ...device, status: "ended" as const, code: undefined, error, description };
    await store.swap(found, ended);
    console.info({ event, clientId: device.clientId });
    return oauthError(error, description);
  };
  if (device.status === "ended")
    return oauthError(device.error || "access_denied", device.description || "Ended.");
  if (device.status === "redeemed")
    // an earlier poll's exchange died, or its answer never reached the device
    return end(
      "device-login.failed",
      "invalid_grant",
      "This sign-in was approved, but its tokens never reached the device, so it was ended. Run the sign-in again.",
    );
  if (device.expiresAt <= Date.now())
    return end(
      "device-login.expired",
      "expired_token",
      "The code expired before the sign-in finished.",
    );
  if (device.status !== "approved")
    return oauthError("authorization_pending", "The person has not answered yet.");
  return redeem(env, addresses, ctx, found, form.data.code_verifier);
}

/** The approved code, exchanged once at the library's own token endpoint with the device's PKCE
 *  verifier. The request is marked `redeemed` first (compare-and-set): of two polls at once, one
 *  exchanges and the other is refused, and no poll after it gets tokens.
 *
 *  The library refuses another client, another redirect, a verifier for another challenge and
 *  another resource before any token exists (@cloudflare/workers-oauth-provider 1.0
 *  `handleAuthorizationCodeGrant`). The scope is this layer's: a link edited before the consent can
 *  ask for more than `iterate`, and the consent grants what it asked. Tokens with any other scope
 *  never reach the device, and their grant is ended. */
async function redeem(
  env: Env,
  addresses: PlatformAddresses,
  ctx: ExecutionContext,
  found: StoredRequest,
  verifier: string,
) {
  const store = deviceStore(env);
  const device = found.request;
  const { code, grant } = device;
  if (!code || !grant) throw new Error("An approved device request keeps its code and grant.");
  const redeemed = await store.swap(found, { ...device, status: "redeemed", code: undefined });
  if (!redeemed) return refused("invalid_grant", "This sign-in is being completed already.");
  const exchange = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: device.clientId,
    redirect_uri: `${addresses.platformOrigin}${CALLBACK_PATH}`,
    code_verifier: verifier,
    resource: device.resource,
  });
  const answer = await authorizationServerFetch(
    env,
    addresses,
    new Request(`${addresses.platformOrigin}${TOKEN_ENDPOINT}`, { method: "POST", body: exchange }),
    ctx,
  );
  const scope = answer.ok ? TokenScope.parse(await answer.clone().json()).scope : null;
  if (scope === "iterate") {
    console.info({
      event: "device-login.redeemed",
      clientId: device.clientId,
      userId: grant.userId,
    });
    return answer;
  }
  const failed = answer.ok
    ? "The approval did not match what the device asked for, so it was refused."
    : "This sign-in failed. Run the sign-in again.";
  await endGrant(env, addresses, grant);
  await store.swap(redeemed, {
    ...redeemed.request,
    status: "ended",
    error: "invalid_grant",
    description: failed,
  });
  if (!answer.ok) {
    console.warn({ event: "device-login.failed", clientId: device.clientId });
    return answer;
  }
  console.warn({ event: "device-login.scope-mismatch", clientId: device.clientId, scope });
  return refused("invalid_grant", failed);
}

/** The scope of the library's token answer (RFC 6749 §5.1). */
const TokenScope = z.object({ scope: z.string() });

/** Why the callback does not answer `found`, or null. */
function callbackRefusal(found: StoredRequest | null, person: string | null, codeIsOwn: boolean) {
  if (!found) return "unknown";
  if (found.request.expiresAt <= Date.now()) return "expired";
  if (found.request.status !== "confirmed") return "not-confirmed";
  if (!person || found.request.confirmedBy !== person) return "other-session";
  if (!codeIsOwn) return "other-grant";
  return null;
}

/** The grant an authorization code names: the library's codes are `<userId>:<grantId>:<secret>`
 *  (consent.ts `grantIdOf` reads them the same way). */
function grantOfCode(code: string) {
  const [userId, grantId, secret] = code.split(":");
  return userId && grantId && secret ? { userId, grantId } : null;
}

/** End a grant a device login will not use, as the Sessions page ends one (grants.ts `end`): its
 *  end on the person's account first, which refuses its code's exchange and every token it made
 *  (oauth.ts `grantIsLive`, `grantLifetime`), then the provider's rows. */
async function endGrant(
  env: Env,
  addresses: PlatformAddresses,
  grant: { userId: string; grantId: string },
) {
  await appendPlatformFacts(
    env.ITERATE_CONTEXT,
    { account: grant.userId },
    {
      type: "events.iterate.com/account/grant-ended",
      idempotencyKey: `account/grant-ended/${grant.grantId}`,
      payload: { grantId: grant.grantId } satisfies GrantEnded,
    },
    { principal: null },
  );
  await revokeGrant(env, addresses, grant);
}

/** A refused request, logged as the authorization server's own refusals are (oauth.ts `onError`). */
function refused(error: string, description: string, status = 400) {
  console.warn({ event: "oauth.refusal", category: "device-login", code: error });
  return oauthError(error, description, status);
}

/** A rate limit's answer. RFC 8628 has no error for the device authorization endpoint's own
 *  limits, so it is RFC 6749's `temporarily_unavailable`, with a minute's Retry-After. */
function tooMany(description: string, status = 429) {
  const answer = oauthError("temporarily_unavailable", description, status);
  answer.headers.set("retry-after", "60");
  return answer;
}
