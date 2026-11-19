import { cookieValueOf, isSameOriginBrowserRequest, sameOriginPath } from "iterate/lib";
import { authorizationCodeRequest, authorizationServer } from "iterate/oauth";
import { type MindConfig, controlPlaneOriginOf } from "iterate/mind-config";
import { MIND_IDENTITY_PATH, reservedPathOf } from "iterate/mind-identity-log";
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
  SIGNED_OUT_COOKIE,
} from "./session-cookies.ts";
import { socketAnswer, stampedRequest } from "./stamp.ts";

const FLOW_SECONDS = 10 * 60;
const CALLBACK_PATH = `${HOST_SESSION_PREFIX}callback`;
const SIGN_OUT_PATH = `${HOST_SESSION_PREFIX}sign-out`;
const SIGNED_OUT_PATH = `${HOST_SESSION_PREFIX}signed-out`;

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
  config: MindConfig;
  recordFacts: (response: Response) => Response | Promise<Response>;
};

// Every hostname but the control-plane hostname is the mind's, whose code may be hostile: the session cookie
// never reaches it, and the boundary answers `/.iterate/`, the identity log's path and the stack
// key's path itself.
export async function mindHostResponse(
  request: Request,
  deps: HostDeps,
  forward: (forwarded: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith(HOST_SESSION_PREFIX)) return hostSessionPathResponse(request, deps);
  // A MIND'S CODE PUBLISHES NO IDENTITY AND NO KEY. A mind's identity log and its stack's key are
  // read at a hostname, by another mind (iterate/mind-identity-log `publishedMindOf`) and by
  // iterate Cloud: code that answered one of these paths could publish a log or a key as a mind
  // at any hostname of its zones. So the mind never gets these two paths, in any spelling that
  // `reservedPathOf` takes for one of them.
  // THE IDENTITY LOG is the auth Worker's answer, on every hostname that the log's last record
  // lists, so that a reader finds the mind at each name a root key gave it; on any other
  // hostname the auth Worker answers 404. A record is posted at the control-plane hostname alone.
  const reserved = reservedPathOf(url.pathname);
  if (reserved) {
    const readsTheLog =
      reserved.exact &&
      reserved.path === MIND_IDENTITY_PATH &&
      (request.method === "GET" || request.method === "HEAD");
    if (!readsTheLog) return new Response("Not found\n", { status: 404 });
    return deps.auth.identityLog(url.hostname, url.searchParams.get("after"));
  }
  const stamp = await stampedRequest(request, {
    auth: deps.auth,
    route: null,
    config: deps.config,
  });
  if (stamp.answer) return stamp.answer;
  const answer = withoutSessionCookies(await forward(stamp.forwarded));
  // a mind's request gets the app's answer as it is: no sign-in page is a mind's
  if (stamp.byMind) return answer;
  const decision = mindHostSignInAnswerOf({ answer, request, caller: stamp.caller });
  if (!decision) return answer;
  await answer.body?.cancel();
  if (decision === "not-a-member")
    return notMemberPage(deps.config.controlPlaneHostname, stamp.email || "");
  if (decision instanceof Response) return decision;
  return signInResponse(request, deps);
}

// The one path that may make the host's client.
async function signInResponse(request: Request, { auth, config }: HostDeps) {
  const url = new URL(request.url);
  const clientId = await auth.hostClient(url.host);
  const {
    url: location,
    state,
    verifier,
  } = await authorizationCodeRequest({
    issuer: controlPlaneOriginOf(config),
    clientId,
    redirectUri: `${url.origin}${CALLBACK_PATH}`,
    resources: [url.origin],
    scopes: ["identity"],
  });
  // OpenID Connect's `prompt`: the issuer says who is signed in there, and offers another account
  if (cookieValueOf(request.headers.get("cookie"), SIGNED_OUT_COOKIE) === "1")
    location.searchParams.set("prompt", "select_account");
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
  if (pathname === SIGNED_OUT_PATH && request.method === "GET") return signedOutPage(request);
  return new Response("Not found\n", { status: 404 });
}

async function callbackResponse(request: Request, deps: HostDeps) {
  const url = new URL(request.url);
  const flow = Flow.safeParse(flowCookieOf(request));
  // Each failure ends this flow, and its link starts a new one: the page the sign-in began at asks
  // for a sign-in again (an authorization code of the stack from before the move is one of these).
  const again = flow.success ? flow.data.next : "/";
  const failed = (message: string) =>
    plainPage(
      "You can't continue",
      message,
      400,
      cookie(FLOW_COOKIE, "", 0),
      `<p><a href="${htmlEscaped(again)}">Sign in again</a></p>`,
    );
  if (!flow.success)
    return failed("This sign-in expired or began in another browser. Sign in again.");
  const { as, options } = exchangeSetup(deps);
  const client = { client_id: flow.data.clientId };
  let callback: URLSearchParams;
  try {
    callback = oauth.validateAuthResponse(as, client, url.searchParams, flow.data.state);
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError)
      return failed("The sign-in was declined. Sign in again.");
    return failed("This sign-in expired or began in another browser. Sign in again.");
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
  if (!tokens) return failed("The sign-in could not complete. Sign in again.");
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
  headers.append("set-cookie", cookie(SIGNED_OUT_COOKIE, "", 0));
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
  const headers = new Headers({ location: SIGNED_OUT_PATH, "cache-control": "no-store" });
  headers.append("set-cookie", cookie(HOST_SESSION_COOKIE, "", 0));
  // The issuer's own session lives on: without this, the next sign-in here would bring the same
  // person back with no question. A day is long enough for "sign out, then sign in as another".
  headers.append("set-cookie", cookie(SIGNED_OUT_COOKIE, "1", 24 * 3600));
  return new Response(null, { status: 303, headers });
}

// The sign-out's redirects stay on this host: a page's CSP `form-action 'self'` covers every
// redirect after its form's POST, and the browser blocks one to the issuer, which leaves the page
// that shows the person signed in. This page is a new navigation, and `/` begins the sign-in.
function signedOutPage(request: Request) {
  const host = new URL(request.url).host.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
  return new Response(
    standalonePage({
      title: "Signed out",
      head: '<meta http-equiv="refresh" content="0;url=/">',
      body: `<h1>Signed out</h1><p>You are signed out of ${host}.</p><p><a href="/">Sign in again</a></p>`,
    }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

// The token endpoint is reached through the auth Worker's binding: a Worker's fetch to a route of
// its own zone fails.
function exchangeSetup({ auth, config, recordFacts }: HostDeps) {
  const as = { ...authorizationServer(controlPlaneOriginOf(config)) };
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

// The person's way out is this host's own sign-out: the sign-in that follows asks the issuer who
// they are, and offers another account.
function notMemberPage(mind: string, email: string) {
  return plainPage(
    "You can't continue",
    `You are signed in as ${email}, and that address is not a member of ${mind}. Ask the mind's owner to add it.`,
    403,
    undefined,
    `<form method="post" action="${SIGN_OUT_PATH}"><button type="submit">Use another account</button></form>`,
  );
}

/** `after`: HTML of ours, after the message. */
const htmlEscaped = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function plainPage(title: string, message: string, status: number, setCookie?: string, after = "") {
  const escaped = htmlEscaped(message);
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(
    standalonePage({ title, head: "", body: `<h1>${title}</h1><p>${escaped}</p>${after}` }),
    { status, headers },
  );
}
