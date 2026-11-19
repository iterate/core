import {
  ITX_EXPIRES_HEADER,
  ITX_GRANT_HEADER,
  ITX_MIND_HEADER,
  ITX_PERSON_HEADER,
  ITX_PRINCIPAL_HEADER,
  nameInEmail,
  type Person,
  type SignInMethod,
  stampJsonOf,
} from "iterate/principal";
import {
  type ControlPlaneRoute,
  mindApiUrlOf,
  mindMcpNameOf,
  mindMcpUrlOf,
  protectedResourceMetadataUrlOf,
  type MindResourceMetadata,
} from "iterate/mind-api";
import { type MindConfig, controlPlaneOriginOf } from "iterate/mind-config";
import { headerNamesASecret } from "iterate/secret-placeholder";
import {
  ITERATE_STATEMENT_HEADER,
  STATEMENT_HEADER_MAX_CHARACTERS,
  statementHashOf,
} from "iterate/signed";
import type { AuthService, TokenIdentity } from "iterate/workers";
import { ITERATE_CAUSE_HEADER } from "iterate/lib";
import { type MindHostCaller, mindHostCallerOf } from "./mind-host-sign-in.ts";
import { appCookiesOf, sessionTokenOf } from "./session-cookies.ts";

/** Our mark's header name as iterated header names are: lowercase. */
const CAUSE_HEADER = ITERATE_CAUSE_HEADER.toLowerCase();

export type Stamped = {
  forwarded: Request;
  caller: MindHostCaller;
  email: string | null;
  answer?: Response;
  /** A checked mind's request: no app's 401 becomes a sign-in page for it (./host-session.ts). */
  byMind?: true;
};

/** `route`: the part of the control plane the request is for, or null on a hostname of the mind's
 *  own (./http.ts `isControlPlaneRequest`). */
export async function stampedRequest(
  request: Request,
  {
    auth,
    route,
    config,
  }: {
    auth: AuthService;
    route: ControlPlaneRoute | null;
    config: Pick<MindConfig, "controlPlaneHostname">;
  },
): Promise<Stamped> {
  // Only the boundary stamps `x-itx-*`, and what it forwards to trusts the stamp: drop whatever a
  // caller sent. Iterated header names are lowercase. A signed statement never reaches the code,
  // nor does a caller's mark (the mind's own request gets its own back: ./http.ts `ownStamped`).
  const headers = new Headers(
    [...request.headers].filter(
      ([name]) =>
        !name.startsWith("x-itx-") && name !== ITERATE_STATEMENT_HEADER && name !== CAUSE_HEADER,
    ),
  );
  const url = new URL(request.url);
  const bearer = bearerOf(request.headers);
  if (route === "api" || route === "mcp") {
    const resource =
      route === "api"
        ? mindApiUrlOf(config.controlPlaneHostname)
        : mindMcpUrlOf(config.controlPlaneHostname);
    const metadataUrl = protectedResourceMetadataUrlOf(resource);
    if (url.href.split("?")[0] === metadataUrl) {
      const answer =
        request.method === "GET"
          ? protectedResourceDocument(resource, controlPlaneOriginOf(config))
          : new Response("Method not allowed\n", { status: 405 });
      return {
        forwarded: new Request(request, { headers }),
        caller: "anonymous",
        email: null,
        answer,
      };
    }
    // The control-plane hostname is not the mind's: the mind gets no cookie and no credential.
    headers.delete("cookie");
    headers.delete("authorization");
    // A key's token is no member's: it gets no principal, so nothing that asks for one takes it.
    const identity = bearer ? await auth.whoIs(bearer, resource) : null;
    if (identity && !identity.provide) stamp(headers, identity);
    // The boundary answers the RFC 9728 documents and this 401 itself, so a hostile mind cannot
    // send a client to another issuer. The API's own address is a session that the boundary ends
    // (./http.ts), and under `/api/` the rest is the mind's (signed URLs, webhooks).
    const needsCaller = route === "mcp";
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
            route === "mcp" ? mcpHelp(request, config) : null,
            probe ? 400 : 401,
          ),
        }),
    };
  }
  if (route === "secrets") {
    // A write counts a cookie only from the control-plane hostname's own origin: a mind hostname is
    // same-site, so the issuer's cookie rides its form posts too.
    const write = request.method !== "GET" && request.method !== "HEAD";
    const ownOrigin = request.headers.get("origin") === controlPlaneOriginOf(config);
    const session =
      !write || ownOrigin ? await auth.browserSession(request.headers.get("cookie")) : null;
    if (session) {
      const person = personOf(
        session.userId,
        session.email,
        nameInEmail(session.email),
        session.method,
      );
      headers.set(ITX_PERSON_HEADER, stampJsonOf(person));
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

  const statement = request.headers.get(ITERATE_STATEMENT_HEADER);
  if (statement) return mindStamped(request, headers, statement, auth, config);

  // An app's own script may send a bearer of its own beside the session cookie.
  const session = sessionTokenOf(request);
  const byBearer = bearer ? await auth.whoIs(bearer, url.origin) : null;
  const tokenIdentity = byBearer || (session ? await auth.whoIs(session, url.origin) : null);
  // A PERSON'S TOKEN SAYS HOW THE PERSON SIGNED IN (iterate/workers `TokenIdentity.method`), and
  // the stamp carries it to the app (iterate/sdk `auth.person`). A token that says none is no
  // person's, and stamps nobody.
  const identity = tokenIdentity?.method
    ? { ...tokenIdentity, method: tokenIdentity.method }
    : null;
  const caller = mindHostCallerOf({
    authorization: identity && {
      via: byBearer ? "bearer" : "cookie",
      reachesMind: identity.member,
    },
    request,
  });
  setAppCookies(headers, request.headers.get("cookie"));
  // a bearer of ours never reaches the app; one that did not verify may be the app's own
  if (byBearer) headers.delete("authorization");
  if (identity && caller !== "anonymous") {
    const person = personOf(
      identity.principal.actor,
      identity.principal.email || "",
      // a guest's is the one they typed, which is all they have
      identity.name || nameInEmail(identity.principal.email || ""),
      identity.method,
      identity.mind,
    );
    headers.set(ITX_PERSON_HEADER, stampJsonOf(person));
    // when the sign-in ends, member or not: a person's socket (sdk/auth.ts `personItx`) ends then
    headers.set(ITX_EXPIRES_HEADER, String(identity.expiresAt));
    if (caller === "member") stamp(headers, identity);
  }
  const signedIn = identity && caller !== "anonymous" ? identity : null;
  return {
    forwarded: new Request(request, { headers }),
    caller,
    email: signedIn?.principal.email || null,
  };
}

/** THE STAMP OF A PERSON: a guest's and another mind's member's have no address, whatever else
 *  the token says, so no reader of the stamp takes them for a person with one (iterate/principal
 *  `Guest`, `MindPerson`). A member of another mind has the mind that vouched for them, or no
 *  stamp: a token that says "mind" and names none is a defect. */
function personOf(
  userId: string,
  email: string,
  name: string,
  method: SignInMethod,
  mind?: { id: string; hostname: string; userId: string },
): Person {
  if (method === "guest") return { userId, email: "", name, method };
  if (method === "mind") {
    if (!mind) throw new Error("a token of the way mind names no mind: a defect");
    return { userId, email: "", name, method, mind };
  }
  return { userId, email, name, method };
}

/** A MIND'S SIGNED REQUEST (core/auth-worker/src/mind-fetch.ts): stamped in `ITX_MIND_HEADER`
 *  alone, or a 401 of the boundary's own; a check that throws is a 503. The statement decides
 *  alone: no bearer and no session is read, and neither reaches the app. */
async function mindStamped(
  request: Request,
  headers: Headers,
  statement: string,
  auth: AuthService,
  config: Pick<MindConfig, "controlPlaneHostname">,
): Promise<Stamped> {
  // with the filtered headers, so no path hands on what the filter took off; built on a refusal
  // alone, since a copy takes the body
  const refusedWith = (answer: Response): Stamped => ({
    forwarded: new Request(request, { headers }),
    caller: "anonymous",
    email: null,
    answer,
  });
  if (statement.length > STATEMENT_HEADER_MAX_CHARACTERS)
    return refusedWith(mindRefusal("the statement is too long"));
  // hashed, so no print of the keys shows a statement; with this stack's hostname
  const key = await statementHashOf(
    `${config.controlPlaneHostname}\n${request.method}\n${request.url}\n${statement}`,
  );
  let checked: Awaited<ReturnType<AuthService["mindOfSignedRequest"]>> | undefined =
    stampsHere.get(key)?.stamp;
  if (checked && Date.now() >= checked.expiresAt * 1000) {
    stampsHere.delete(key);
    checked = undefined;
  }
  try {
    checked ||= await auth.mindOfSignedRequest({
      statement,
      method: request.method,
      url: request.url,
    });
  } catch {
    return refusedWith(
      new Response("The signed statement of this request could not be checked now.\n", {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "5" },
      }),
    );
  }
  if ("refused" in checked) return refusedWith(mindRefusal(checked.refused));
  // the clock again, after the await
  if (Date.now() >= checked.expiresAt * 1000)
    return refusedWith(mindRefusal("the statement has expired"));
  remember(key, checked);
  // a member's token cannot be told from the app's own without a lookup
  setAppCookies(headers, request.headers.get("cookie"));
  headers.delete("authorization");
  headers.set(ITX_MIND_HEADER, JSON.stringify(checked.principal));
  headers.set(ITX_EXPIRES_HEADER, String(checked.expiresAt));
  return {
    forwarded: new Request(request, { headers }),
    caller: "anonymous",
    email: null,
    byMind: true,
  };
}

/** The cookie header AS IT GOES TO THE APP: the reserved cookies out, then read again as egress
 *  reads it, since what is left may be a Basic credential (`withoutOutsidePlaceholders`). */
function setAppCookies(headers: Headers, cookieHeader: string | null) {
  const kept = appCookiesOf(cookieHeader);
  if (kept && !headerNamesASecret(kept)) headers.set("cookie", kept);
  else headers.delete("cookie");
}

const mindRefusal = (reason: string) =>
  Response.json({ error: reason }, { status: 401, headers: { "cache-control": "no-store" } });

type MindStamp = Exclude<
  Awaited<ReturnType<AuthService["mindOfSignedRequest"]>>,
  { refused: string }
>;

/** What this isolate stamped, so a warm request calls no auth Worker; no refusal is kept. */
const stampsHere = new Map<string, { stamp: MindStamp }>();
function remember(key: string, stamp: MindStamp) {
  if (stampsHere.has(key)) return;
  stampsHere.set(key, { stamp });
  if (stampsHere.size > 1_000) stampsHere.delete(stampsHere.keys().next().value ?? "");
}

/** THE BEARER TOKEN OF A REQUEST'S `Authorization` HEADER, or undefined when the header is absent
 *  or of another scheme. The scheme's name is matched in any case (RFC 9110 section 11.1): a
 *  client that writes `bearer` sent the same credential. */
export const bearerOf = (headers: Headers) =>
  headers.get("authorization")?.match(/^Bearer +(.+)$/i)?.[1];

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
function mcpHelp(request: Request, config: Pick<MindConfig, "controlPlaneHostname">) {
  const origin = controlPlaneOriginOf(config);
  const mcp = mindMcpUrlOf(config.controlPlaneHostname);
  const add = `claude mcp add --transport http ${mindMcpNameOf(config.controlPlaneHostname)} ${mcp}`;
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

// The control-plane hostname is the issuer's and the secret form's origin, and the mind may be
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
