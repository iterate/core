import {
  ITX_EXPIRES_HEADER,
  ITX_GRANT_HEADER,
  ITX_LENDER_HEADER,
  ITX_PERSON_HEADER,
  ITX_PRINCIPAL_HEADER,
  type Lender,
  type Person,
} from "iterate/principal";
import {
  type PlatformRoute,
  platformOriginOf,
  mindApiUrlOf,
  mindMcpNameOf,
  mindMcpUrlOf,
  protectedResourceMetadataUrlOf,
  type MindResourceMetadata,
} from "iterate/mind-api";
import type { AuthService, TokenIdentity } from "iterate/workers";
import { type MindHostCaller, mindHostCallerOf } from "./mind-host-sign-in.ts";
import { appCookiesOf, sessionTokenOf } from "./session-cookies.ts";

export type Stamped = {
  forwarded: Request;
  caller: MindHostCaller;
  email: string | null;
  answer?: Response;
};

export async function stampedRequest(
  request: Request,
  { auth, route, domain }: { auth: AuthService; route: PlatformRoute | null; domain: string },
): Promise<Stamped> {
  // Only the boundary stamps `x-itx-*`, and what it forwards to trusts the stamp: drop whatever a
  // caller sent. Iterated header names are lowercase.
  const headers = new Headers([...request.headers].filter(([name]) => !name.startsWith("x-itx-")));
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (route === "api" || route === "mcp") {
    const resource = route === "api" ? mindApiUrlOf(domain) : mindMcpUrlOf(domain);
    const metadataUrl = protectedResourceMetadataUrlOf(resource);
    if (url.href.split("?")[0] === metadataUrl) {
      const answer =
        request.method === "GET"
          ? protectedResourceDocument(resource, platformOriginOf(domain))
          : new Response("Method not allowed\n", { status: 405 });
      return { forwarded: request, caller: "anonymous", email: null, answer };
    }
    const identity = bearer ? await auth.whoIs(bearer, resource) : null;
    // The platform's hostname is not the mind's: the mind gets no cookie and no credential.
    headers.delete("cookie");
    headers.delete("authorization");
    // A key's token is no member's: it gets no principal, so nothing that asks for one takes it.
    if (identity?.provide) {
      const lender: Lender = {
        actor: identity.principal.actor,
        key: identity.grant,
        provide: identity.provide,
      };
      headers.set(ITX_LENDER_HEADER, JSON.stringify(lender));
      headers.set(ITX_EXPIRES_HEADER, String(identity.expiresAt));
    } else if (identity) stamp(headers, identity);
    // The boundary answers the RFC 9728 documents and this 401 itself, so a hostile mind cannot
    // send a client to another issuer. Under `/api/` the rest is the mind's (signed URLs, webhooks).
    const needsCaller = route === "mcp" || url.pathname === "/api";
    // Read before `forwarded` is made: a new Request takes this one's body.
    const probe = route === "mcp" && !identity && (await isDiscoverProbe(request));
    return {
      forwarded: new Request(request, { headers }),
      caller: identity && !identity.provide ? "member" : "anonymous",
      email: identity?.principal.email || null,
      ...(needsCaller &&
        !identity && {
          answer: bearerChallenge(
            metadataUrl,
            Boolean(bearer),
            route === "mcp" ? mcpHelp(request, domain) : null,
            probe ? 400 : 401,
          ),
        }),
    };
  }
  if (route === "secrets") {
    // A write counts a cookie only from the platform's own origin: a mind hostname is same-site,
    // so the issuer's cookie rides its form posts too.
    const write = request.method !== "GET" && request.method !== "HEAD";
    const ownOrigin = request.headers.get("origin") === platformOriginOf(domain);
    const session =
      !write || ownOrigin ? await auth.browserSession(request.headers.get("cookie")) : null;
    if (session) {
      const person: Person = { userId: session.userId, email: session.email };
      headers.set(ITX_PERSON_HEADER, JSON.stringify(person));
      if (session.member)
        headers.set(
          ITX_PRINCIPAL_HEADER,
          JSON.stringify({ actor: session.userId, email: session.email }),
        );
    }
    return {
      forwarded: new Request(request, { headers }),
      caller: session ? (session.member ? "member" : "non-member") : "anonymous",
      email: session?.email || null,
    };
  }
  if (route)
    return { forwarded: new Request(request, { headers }), caller: "anonymous", email: null };

  // An app's own script may send a bearer of its own beside the session cookie.
  const session = sessionTokenOf(request);
  const byBearer = bearer ? await auth.whoIs(bearer, url.origin) : null;
  const identity = byBearer || (session ? await auth.whoIs(session, url.origin) : null);
  const caller = mindHostCallerOf({
    authorization: identity && {
      via: byBearer ? "bearer" : "cookie",
      reachesMind: identity.member,
    },
    request,
  });
  const appCookies = appCookiesOf(request.headers.get("cookie"));
  if (appCookies) headers.set("cookie", appCookies);
  else headers.delete("cookie");
  // a bearer of ours never reaches the app; one that did not verify may be the app's own
  if (byBearer) headers.delete("authorization");
  if (identity && caller !== "anonymous") {
    const person: Person = {
      userId: identity.principal.actor,
      email: identity.principal.email || "",
    };
    headers.set(ITX_PERSON_HEADER, JSON.stringify(person));
    if (caller === "member") stamp(headers, identity);
  }
  return {
    forwarded: new Request(request, { headers }),
    caller,
    email: caller === "anonymous" ? null : identity?.principal.email || null,
  };
}

function stamp(headers: Headers, identity: TokenIdentity) {
  headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(identity.principal));
  headers.set(ITX_GRANT_HEADER, identity.grant);
  headers.set(ITX_EXPIRES_HEADER, String(identity.expiresAt));
}

/** Tells a document the boundary served from one a hostile mind serves (the smoke check reads it). */
const SERVED_BY_HEADER = "x-iterate-served-by";

const protectedResourceDocument = (resource: string, issuer: string) =>
  Response.json({ resource, authorization_servers: [issuer] } satisfies MindResourceMetadata, {
    headers: { "cache-control": "no-store", [SERVED_BY_HEADER]: "boundary" },
  });

// `invalid_token` when a bearer came and is not live, so a client signs in again (RFC 6750 §3.1).
const bearerChallenge = (
  metadataUrl: string,
  invalid: boolean,
  help: { body: string; type: string } | null,
  status = 401,
) =>
  new Response(help?.body || "Sign in to use this mind\n", {
    status,
    headers: {
      "WWW-Authenticate": `Bearer ${invalid ? 'error="invalid_token", ' : ""}resource_metadata="${metadataUrl}"`,
      ...(help && { "content-type": help.type }),
    },
  });

// An MCP client of the 2026-07-28 era probes with `server/discover` first, and a 401 there ends
// with an SDK error that drops the body. A 400 makes it fall back to `initialize`, whose 401 starts
// OAuth for a client that signs in, and puts this body in the error of one that does not.
async function isDiscoverProbe(request: Request) {
  if (request.method !== "POST") return false;
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as { method?: unknown } | null;
  return body?.method === "server/discover";
}

// A standard client reads only the header. A person who opens the address gets a page, and an
// agent whose client does not sign in reads the body, so each says how to connect.
function mcpHelp(request: Request, domain: string) {
  const origin = platformOriginOf(domain);
  const mcp = mindMcpUrlOf(domain);
  const add = `claude mcp add --transport http ${mindMcpNameOf(domain)} ${mcp}`;
  if (request.method === "GET" && request.headers.get("accept")?.includes("text/html"))
    return {
      type: "text/html; charset=utf-8",
      body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP server</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}code{background:rgb(136 136 136 / 13%);padding:0 .25em;border-radius:4px;word-break:break-all}</style>
<h1>MCP server</h1>
<p>This is this mind's MCP server.</p>
<p>In Claude: Settings, Connectors, Add custom connector, this address: <code>${mcp}</code></p>
<p>In Claude Code: <code>${add}</code></p>
`,
    };
  return {
    type: "text/plain; charset=utf-8",
    body: `This is this mind's MCP server. Sign in to use it.

A standard MCP client signs in by itself from the WWW-Authenticate header: OAuth 2.1 with PKCE (S256) and dynamic client registration, scope "iterate", resource ${mcp}.
In Claude: Settings, Connectors, Add custom connector, ${mcp}. In Claude Code: ${add}

An iterate agent, whose itx.connectToMcp does not sign in, connects in five steps:
1. const redirect = await itx.secrets.oauthCallbackUrl()
2. Register a client: POST ${origin}/oauth2/register with the JSON body { "client_name": "<your name>", "redirect_uris": [redirect], "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"] }. Keep its client_id.
3. await itx.secrets.beginOAuth("/secrets/<name>", { authorizationEndpoint: "${origin}/oauth2/auth", tokenEndpoint: "${origin}/oauth2/token", clientId, scope: "iterate", urls: ["${origin}"], extra: { resource: "${mcp}" } })
4. Send the link it answers to your person. They sign in on ${origin} with their passkey and allow it.
5. itx.connectToMcp("${mcp}", { headers: { authorization: 'Bearer getSecret("/secrets/<name>", { field: "accessToken" })' } })
`,
  };
}

/** No `allow-same-origin`: nothing a mind document loads is this origin's. */
const MIND_ANSWER_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

// The platform's hostname is the issuer's and the secret form's origin, and the mind may be
// hostile: no cookie, a sandbox, and never a page (a page could copy the secret form), so an attachment.
export function httpsRedirect(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.protocol !== "http:") return undefined;
  url.protocol = "https:";
  return Response.redirect(url.href, 308);
}

export function confinedAnswer(answer: Response): Response {
  if (answer.webSocket) return socketAnswer(answer);
  const headers = new Headers(answer.headers);
  const disposition = headers.get("content-disposition");
  headers.set(
    "content-disposition",
    disposition ? disposition.replace(/^[^;]*/, "attachment") : "attachment",
  );
  headers.delete("set-cookie");
  // one would sign every member out, the other would widen a service worker's reach
  headers.delete("clear-site-data");
  headers.delete("service-worker-allowed");
  headers.set("content-security-policy", MIND_ANSWER_CSP);
  headers.set("x-content-type-options", "nosniff");
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

// A handshake's answer may set cookies (RFC 6455): only the socket and its subprotocol reach the browser.
export function socketAnswer(answer: Response): Response {
  const protocol = answer.headers.get("sec-websocket-protocol");
  return new Response(null, {
    status: 101,
    webSocket: answer.webSocket,
    headers: protocol ? { "sec-websocket-protocol": protocol } : {},
  });
}
