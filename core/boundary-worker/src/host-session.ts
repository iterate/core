import { isSameOriginBrowserRequest, sameOriginPath } from "iterate/lib";
import { authorizationCodeRequest, authorizationServer } from "iterate/oauth";
import { platformOriginOf } from "iterate/mind-api";
import { standalonePage } from "iterate/standalone-page";
import { type AuthService, HOST_SESSION_PREFIX } from "iterate/workers";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { mindHostSignInAnswerOf } from "./mind-host-sign-in.ts";
import {
  cookie,
  FLOW_COOKIE,
  flowCookieOf,
  HOST_SESSION_COOKIE,
  sessionTokenOf,
  setsSessionCookie,
} from "./session-cookies.ts";
import { socketAnswer, stampedRequest } from "./stamp.ts";

const FLOW_SECONDS = 10 * 60;
const CALLBACK_PATH = `${HOST_SESSION_PREFIX}callback`;
const SIGN_OUT_PATH = `${HOST_SESSION_PREFIX}sign-out`;

// `clientId` is the one the sign-in found: the callback never asks for one, so a hand-made cookie
// there makes no client.
const Flow = z.object({
  state: z.string(),
  verifier: z.string(),
  next: z.string(),
  clientId: z.string(),
});

type HostDeps = {
  auth: AuthService;
  domain: string;
  recordFacts: (response: Response) => Response | Promise<Response>;
};

// Every hostname but the platform's is the mind's, whose code may be hostile: the session cookie
// never reaches it, and the boundary answers `/.iterate/` itself.
export async function mindHostResponse(
  request: Request,
  deps: HostDeps,
  forward: (forwarded: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith(HOST_SESSION_PREFIX)) return hostSessionPathResponse(request, deps);
  const stamp = await stampedRequest(request, {
    auth: deps.auth,
    route: null,
    domain: deps.domain,
  });
  const answer = withoutSessionCookies(await forward(stamp.forwarded));
  const decision = mindHostSignInAnswerOf({ answer, request, caller: stamp.caller });
  if (!decision) return answer;
  await answer.body?.cancel();
  if (decision === "sign-in") return signInResponse(request, deps);
  if (decision === "not-a-member") return notMemberPage(deps.domain, stamp.email || "");
  return decision;
}

// The one path that may make the host's client.
async function signInResponse(request: Request, { auth, domain }: HostDeps) {
  const url = new URL(request.url);
  const clientId = await auth.hostClient(url.host);
  const {
    url: location,
    state,
    verifier,
  } = await authorizationCodeRequest({
    issuer: platformOriginOf(domain),
    clientId,
    redirectUri: `${url.origin}${CALLBACK_PATH}`,
    resources: [url.origin],
    scopes: ["identity"],
  });
  const flow = {
    state,
    verifier,
    next: sameOriginPath(url.pathname + url.search, url.origin),
    clientId,
  };
  return new Response(null, {
    status: 302,
    headers: {
      location: location.href,
      "set-cookie": cookie(FLOW_COOKIE, encodeURIComponent(JSON.stringify(flow)), FLOW_SECONDS),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

async function hostSessionPathResponse(request: Request, deps: HostDeps) {
  const { pathname } = new URL(request.url);
  if (pathname === CALLBACK_PATH && request.method === "GET")
    return callbackResponse(request, deps);
  if (pathname === SIGN_OUT_PATH && request.method === "POST")
    return signOutResponse(request, deps);
  return new Response("Not found\n", { status: 404 });
}

async function callbackResponse(request: Request, deps: HostDeps) {
  const url = new URL(request.url);
  const flow = Flow.safeParse(flowCookieOf(request));
  const failed = (message: string) =>
    plainPage("You can't continue", message, 400, cookie(FLOW_COOKIE, "", 0));
  if (!flow.success)
    return failed("This sign-in expired or began in another browser. Reload the page.");
  const { as, options } = exchangeSetup(deps);
  const client = { client_id: flow.data.clientId };
  let callback: URLSearchParams;
  try {
    callback = oauth.validateAuthResponse(as, client, url.searchParams, flow.data.state);
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError)
      return failed("The sign-in was declined. Reload the page to try again.");
    return failed("This sign-in expired or began in another browser. Reload the page.");
  }
  const tokens = await oauth
    .authorizationCodeGrantRequest(
      as,
      client,
      oauth.None(),
      callback,
      `${url.origin}${CALLBACK_PATH}`,
      flow.data.verifier,
      { ...options, additionalParameters: { resource: url.origin } },
    )
    .then((response) => oauth.processAuthorizationCodeResponse(as, client, response))
    .catch((error: unknown) => {
      console.warn({
        event: "boundary.host-sign-in-failed",
        host: url.host,
        message: String(error),
      });
      return null;
    });
  if (!tokens) return failed("The sign-in could not complete. Reload the page to try again.");
  const headers = new Headers({
    location: flow.data.next,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append(
    "set-cookie",
    cookie(HOST_SESSION_COOKIE, tokens.access_token, tokens.expires_in || 3600),
  );
  headers.append("set-cookie", cookie(FLOW_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

async function signOutResponse(request: Request, deps: HostDeps) {
  if (!isSameOriginBrowserRequest(request) || !request.headers.get("origin"))
    return new Response("Cross-site request refused\n", { status: 403 });
  const token = sessionTokenOf(request);
  const origin = new URL(request.url).origin;
  // a token that is live for this host proves its client exists: looking it up makes none
  if (token && (await deps.auth.whoIs(token, origin))) {
    const { as, options } = exchangeSetup(deps);
    const client = { client_id: await deps.auth.hostClient(new URL(origin).host) };
    await oauth
      .revocationRequest(as, client, oauth.None(), token, options)
      .then((response) => response.body?.cancel())
      .catch((error: unknown) =>
        console.warn({ event: "boundary.host-sign-out-not-revoked", message: String(error) }),
      );
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": cookie(HOST_SESSION_COOKIE, "", 0),
      "cache-control": "no-store",
    },
  });
}

// The token endpoint is reached through the auth Worker's binding: a Worker's fetch to a route of
// its own zone fails.
function exchangeSetup({ auth, domain, recordFacts }: HostDeps) {
  const as = { ...authorizationServer(platformOriginOf(domain)) };
  // the library serves revocation at its token endpoint (RFC 7009)
  as.revocation_endpoint = as.token_endpoint;
  const options = {
    signal: AbortSignal.timeout(10_000),
    [oauth.customFetch]: async (input: string, init: RequestInit) =>
      recordFacts(await auth.fetch(new Request(input, init))),
  };
  return { as, options };
}

// The mind may not sign a browser in or out; a handshake's cookies could set or clear the session.
function withoutSessionCookies(answer: Response): Response {
  if (answer.webSocket) return socketAnswer(answer);
  const setCookies = answer.headers.getSetCookie();
  if (!setCookies.some(setsSessionCookie)) return answer;
  const headers = new Headers(answer.headers);
  headers.delete("set-cookie");
  for (const value of setCookies)
    if (!setsSessionCookie(value)) headers.append("set-cookie", value);
  return new Response(answer.body, {
    status: answer.status,
    statusText: answer.statusText,
    headers,
  });
}

function notMemberPage(domain: string, email: string) {
  return plainPage(
    "You can't continue",
    `You are signed in as ${email}, and that address is not a member of ${domain}. Ask the mind's owner to add it.`,
    403,
  );
}

function plainPage(title: string, message: string, status: number, setCookie?: string) {
  const escaped = message.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(
    standalonePage({ title, head: "", body: `<h1>${title}</h1><p>${escaped}</p>` }),
    { status, headers },
  );
}
