// THE CLI'S SIGN-IN to a mind's issuer, and the refresh before each connection: a native public
// client (https://www.rfc-editor.org/rfc/rfc8252) on oauth4webapi, of the issuer the mind's API
// names (iterate/oauth `discoverMind`). It registers its loopback redirect
// (https://www.rfc-editor.org/rfc/rfc7591), sends the person to the issuer with PKCE, and redeems the
// redirect back for tokens bound to one resource (https://www.rfc-editor.org/rfc/rfc8707): the
// mind's API, or its `/provide`.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as oauth from "oauth4webapi";
import { isLocalOrigin } from "../lib.ts";
import {
  authorizationCodeRequest,
  authorizationServerOf,
  type DiscoveredMind,
} from "../client/oauth.ts";
import { standalonePage } from "../standalone-page.ts";
import type { StoredSession } from "./config.ts";

/** The client this process registers as: the CLI's name, or the home lab's. */
const CLIENT_NAME = "iterate CLI";

/** The client registration every sign-in starts with: the issuer must take one (RFC 7591), since a
 *  terminal has no client metadata document of its own to point at. */
export async function registerClient(
  mind: DiscoveredMind,
  metadata: Partial<oauth.OmitSymbolProperties<oauth.Client>>,
): Promise<oauth.Client> {
  if (!mind.endpoints.registration)
    throw new Error(
      `${new URL(mind.issuer).host} takes no client registrations, so this terminal cannot sign in: set ITERATE_MIND_TOKEN instead.`,
    );
  const registration = await oauth.processDynamicClientRegistrationResponse(
    await oauth.dynamicClientRegistrationRequest(
      authorizationServerOf(mind),
      metadata,
      requestOptions(mind.issuer),
    ),
  );
  return { client_id: registration.client_id };
}

/** Sign in to `mind`'s issuer in a browser, for `resource`: `openBrowser` gets the
 *  authorization URL, and the redirect back to this process's loopback listener is validated
 *  (state, `iss`, no `error`) before its code is redeemed with the PKCE verifier. The scope is
 *  `iterate`, the one a mind's issuer grants. */
export async function oauthLogin(input: {
  mind: DiscoveredMind;
  resource: string;
  clientName?: string;
  openBrowser: (url: URL) => void | Promise<void>;
}): Promise<StoredSession> {
  const { mind, resource } = input;
  const as = authorizationServerOf(mind);
  await using loopback = await listenForRedirect();
  const client = await registerClient(mind, {
    client_name: input.clientName || CLIENT_NAME,
    redirect_uris: [loopback.redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  const request = await authorizationCodeRequest({
    issuer: mind.issuer,
    authorizationEndpoint: mind.endpoints.authorization,
    clientId: client.client_id,
    redirectUri: loopback.redirectUri,
    resources: [resource],
  });
  await input.openBrowser(request.url);
  let callback: URLSearchParams;
  try {
    callback = oauth.validateAuthResponse(as, client, await loopback.redirect, request.state);
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError)
      throw new Error(
        `Sign-in was not authorized: ${error.error}${error.error_description ? ` (${error.error_description})` : ""}.`,
        { cause: error },
      );
    throw error;
  }
  const started = Date.now();
  const tokens = await tokenResponse("OAuth token exchange", async () =>
    oauth.processAuthorizationCodeResponse(
      as,
      client,
      await oauth.authorizationCodeGrantRequest(
        as,
        client,
        oauth.None(),
        callback,
        loopback.redirectUri,
        request.verifier,
        { ...requestOptions(mind.issuer), additionalParameters: { resource } },
      ),
    ),
  );
  return sessionFromTokens(tokens, mind, client.client_id, started);
}

/** A fresh access token for `session`, the sign-in for `resource`, from the issuer that issued it.
 *  The issuer may keep the refresh token; an omitted scope means the grant's scope is unchanged
 *  (RFC 6749 §5.1). */
export async function refreshOAuthSession(input: {
  resource: string;
  session: StoredSession;
}): Promise<StoredSession> {
  const { refreshToken, clientId, issuer, tokenEndpoint } = input.session;
  if (!refreshToken) throw new Error(`The sign-in for ${input.resource} has no refresh token.`);
  const as: oauth.AuthorizationServer = { issuer, token_endpoint: tokenEndpoint };
  const client = { client_id: clientId };
  const started = Date.now();
  const tokens = await tokenResponse("OAuth refresh", async () =>
    oauth.processRefreshTokenResponse(
      as,
      client,
      await oauth.refreshTokenGrantRequest(as, client, oauth.None(), refreshToken, {
        ...requestOptions(issuer),
        additionalParameters: { resource: input.resource },
      }),
    ),
  );
  return { ...input.session, ...sessionFromTokens(tokens, null, clientId, started, input.session) };
}

/** End `session` at its issuer (RFC 7009) when the issuer can revoke: its refresh token, which ends
 *  the grant, else its access token. Without a revocation endpoint the issuer keeps the grant until
 *  it lapses, and only the local copy goes. */
export async function revokeSession(session: StoredSession): Promise<void> {
  if (!session.revocationEndpoint) return;
  const as: oauth.AuthorizationServer = {
    issuer: session.issuer,
    revocation_endpoint: session.revocationEndpoint,
  };
  const [token, hint] = session.refreshToken
    ? [session.refreshToken, "refresh_token"]
    : [session.token, "access_token"];
  await oauth.processRevocationResponse(
    await oauth.revocationRequest(as, { client_id: session.clientId }, oauth.None(), token, {
      ...requestOptions(session.issuer),
      additionalParameters: { token_type_hint: hint },
    }),
  );
}

/** A bounded request. oauth4webapi sends only HTTPS unless told otherwise
 *  (https://github.com/panva/oauth4webapi/blob/main/docs/variables/allowInsecureRequests.md); a
 *  local issuer (`pnpm dev`) is plain http. */
export function requestOptions(issuer: string) {
  return {
    signal: AbortSignal.timeout(30_000),
    [oauth.allowInsecureRequests]: isLocalOrigin(issuer),
  };
}

/** The issuer's refusal of a code or refresh token, as the person should read it: its status,
 *  OAuth error code and description, so `invalid_grant` reads apart from any other 400 (iterate/iterate#3008). */
async function tokenResponse(step: string, request: () => Promise<oauth.TokenEndpointResponse>) {
  try {
    return await request();
  } catch (error) {
    if (error instanceof oauth.ResponseBodyError)
      throw new Error(
        `${step} failed (${error.status} ${error.error}${error.error_description ? `: ${error.error_description}` : ""}).`,
        { cause: error },
      );
    throw error;
  }
}

/** The session to store from a token response: `mind`'s issuer and endpoints, or, for a
 *  refresh, the ones `previous` holds. */
export function sessionFromTokens(
  tokens: oauth.TokenEndpointResponse,
  mind: DiscoveredMind | null,
  clientId: string,
  started: number,
  previous?: StoredSession,
): StoredSession {
  const issuer = mind?.issuer || previous?.issuer;
  const tokenEndpoint = mind?.endpoints.token || previous?.tokenEndpoint;
  if (!issuer || !tokenEndpoint) throw new Error("A session needs the issuer it came from.");
  return {
    issuer,
    tokenEndpoint,
    revocationEndpoint: mind ? mind.endpoints.revocation : previous?.revocationEndpoint,
    token: tokens.access_token,
    refreshToken: tokens.refresh_token || previous?.refreshToken,
    clientId,
    scope: tokens.scope || previous?.scope,
    expiresAt:
      tokens.expires_in === undefined
        ? undefined
        : new Date(started + tokens.expires_in * 1000).toISOString(),
  };
}

/** The page the browser lands on at the redirect, in the look of the issuer's sign-in and consent
 *  pages. Its stylesheet is inline (../standalone-page.ts): it comes from the terminal's localhost. */
function redirectPage(title: string, message: string) {
  return standalonePage({ title, head: "", body: `<h1>${title}</h1><p>${message}</p>` });
}

/** The loopback redirect (https://www.rfc-editor.org/rfc/rfc8252#section-7.3): `/callback` on an
 *  ephemeral localhost port, answered once. `redirect` is its query string, for oauth4webapi to
 *  validate; it rejects after five minutes without one. Disposal closes the listener. */
async function listenForRedirect() {
  const settle = Promise.withResolvers<URLSearchParams>();
  // Rejected only by the timeout, which a login that already failed never awaits.
  void settle.promise.catch(() => {});
  let answered = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.");
      return;
    }
    if (answered) {
      response
        .writeHead(409, { "content-type": "text/plain; charset=utf-8" })
        .end("This sign-in already finished.");
      return;
    }
    answered = true;
    const declined = url.searchParams.has("error");
    response
      .writeHead(declined ? 400 : 200, { "content-type": "text/html; charset=utf-8" })
      .end(
        declined
          ? redirectPage("iterate sign-in was not authorized", "You can return to the terminal.")
          : redirectPage(
              "iterate sign-in received",
              "You can close this tab and return to the terminal.",
            ),
      );
    settle.resolve(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  const timeout = setTimeout(
    () => settle.reject(new Error("Timed out waiting for the sign-in redirect.")),
    5 * 60_000,
  );
  // A TCP listener's address is an AddressInfo; only a pipe or socket path answers a string.
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://localhost:${port}/callback`,
    redirect: settle.promise,
    async [Symbol.asyncDispose]() {
      clearTimeout(timeout);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
