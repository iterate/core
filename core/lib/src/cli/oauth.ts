// `iterate login` and the refresh before each command: a native public client of the platform's
// issuer (https://www.rfc-editor.org/rfc/rfc8252) on oauth4webapi, with the issuer description
// (`iterate/oauth`) an app's browser session (`iterate/app-session`) uses. The CLI registers its
// loopback redirect (https://www.rfc-editor.org/rfc/rfc7591), sends the person to the issuer with
// PKCE, and redeems the redirect back for tokens bound to the platform API
// (https://www.rfc-editor.org/rfc/rfc8707).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as oauth from "oauth4webapi";
import { isLocalOrigin } from "../lib.ts";
import { authorizationCodeRequest, authorizationServer } from "../client/oauth.ts";
import type { OAuthScope } from "../oauth-scopes.ts";
import type { StoredSession } from "./config.ts";

/** The platform API's audience (the RFC 8707 resource) at `osBaseUrl`, local port included. */
export const oauthResourceForOsBaseUrl = (osBaseUrl: string) => new URL("/api", osBaseUrl).href;

/** Sign in at `issuer` in a browser: `openBrowser` gets the authorization URL, and the redirect
 *  back to this process's loopback listener is validated (state, `iss`, no `error`) before its code
 *  is redeemed with the PKCE verifier. `iterate login` asks for `iterate` alone, so the session it
 *  stores on disk mints no key; `iterate tokens` signs in again for its one call with `account`
 *  (cli.ts `withAccountSession`). */
export async function oauthLogin(input: {
  issuer: string;
  openBrowser: (url: URL) => void | Promise<void>;
  /** `iterate` is always asked for (iterate/oauth-scopes) */
  scopes?: OAuthScope[];
}) {
  const as = authorizationServer(input.issuer);
  const resource = oauthResourceForOsBaseUrl(input.issuer);
  await using loopback = await listenForRedirect();
  const registration = await oauth.processDynamicClientRegistrationResponse(
    await oauth.dynamicClientRegistrationRequest(
      as,
      {
        client_name: "iterate CLI",
        redirect_uris: [loopback.redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      requestOptions(input.issuer),
    ),
  );
  const client = { client_id: registration.client_id };
  const request = await authorizationCodeRequest({
    issuer: input.issuer,
    clientId: client.client_id,
    redirectUri: loopback.redirectUri,
    resources: [resource],
    scopes: input.scopes,
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
        { ...requestOptions(input.issuer), additionalParameters: { resource } },
      ),
    ),
  );
  return sessionFromTokens(tokens, client.client_id, started);
}

/** A fresh access token for `session` from `issuer`. The issuer may keep the refresh token; an
 *  omitted scope means the grant's scope is unchanged (RFC 6749 §5.1). */
export async function refreshOAuthSession(input: { issuer: string; session: StoredSession }) {
  const { refreshToken, clientId } = input.session;
  if (!refreshToken || !clientId)
    throw new Error(`Session expired for ${input.issuer}. Run \`iterate login\` again.`);
  const as = authorizationServer(input.issuer);
  const client = { client_id: clientId };
  const started = Date.now();
  const tokens = await tokenResponse("OAuth refresh", async () =>
    oauth.processRefreshTokenResponse(
      as,
      client,
      await oauth.refreshTokenGrantRequest(as, client, oauth.None(), refreshToken, {
        ...requestOptions(input.issuer),
        additionalParameters: { resource: oauthResourceForOsBaseUrl(input.issuer) },
      }),
    ),
  );
  return sessionFromTokens(tokens, clientId, started, input.session);
}

/** A bounded request. oauth4webapi sends only HTTPS unless told otherwise
 *  (https://github.com/panva/oauth4webapi/blob/main/docs/variables/allowInsecureRequests.md); a
 *  local issuer (`pnpm dev`) is plain http. */
function requestOptions(issuer: string) {
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
        `${step} failed (${error.status} ${error.error}${error.error_description ? `: ${error.error_description}` : ""}). Run \`iterate login\` again.`,
        { cause: error },
      );
    throw error;
  }
}

function sessionFromTokens(
  tokens: oauth.TokenEndpointResponse,
  clientId: string,
  started: number,
  previous?: StoredSession,
) {
  return {
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
 *  pages (core/os `styles.css`, `StandalonePage`): monospace, black on white, one left-aligned
 *  column. Inlined, because this page comes from the terminal's localhost. */
function redirectPage(title: string, message: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { margin: 0; background: #ffffff; color: #111111; font: 1rem/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
main { box-sizing: border-box; display: flex; flex-direction: column; gap: 1.5rem; max-width: 52.5rem; margin: 0 auto; padding: 3.5rem 1.25rem 6.5rem; }
h1 { margin: 0; font-size: 1.75rem; line-height: 1.3; }
p { margin: 0; }
</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`;
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
          ? redirectPage("Iterate sign-in was not authorized", "You can return to the terminal.")
          : redirectPage(
              "Iterate sign-in received",
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
