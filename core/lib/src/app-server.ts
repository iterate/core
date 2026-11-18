// app-server.ts — THE BROWSER-AUTH GATE every app Worker runs first: the OAuth client (one CIMD
// client id per app origin, PKCE, the `__Host-` cookie), the `/api` proxy, and the gate's own JSON.
// An app is hosted apart from any mind (tasks/mind-stack.md, "Headless Workers"). A person
// points it at a mind by the mind's address (mind-api.ts), and may be connected to several
// at once: one cookie per browser, and behind it one `BrowserSession` per mind, each with its own
// issuer, found by discovery (`discoverMind`), and its own tokens (app-session.ts).
//
// Connecting is deliberate: a browser is bound to a mind only by a same-origin POST to
// `/.auth/connect`, from the app's connect page where the person typed the address — never by a
// link alone, because a link would be a forced login: it could bind a browser to a mind of the
// linker's choosing, and the app would then show that mind's world as the person's. A link may
// only sign the browser in again to a mind it is already connected to (`/.auth/login`).
import { newWebSocketRpcSession } from "capnweb";
import type { ControlPlaneApi } from "./api.ts";
import type { BrowserSession } from "./app-session.ts";
import { type DiscoveredMind, discoverMind } from "./client/oauth.ts";
import {
  cookieValueOf,
  errorCode,
  isLocalOrigin,
  isSameOriginBrowserRequest,
  sameOriginPath,
  withTimeout,
} from "./lib.ts";
import { mindAddressAsTyped, mindAddressGiven, mindAddressOf, mindApiUrlOf } from "./mind-api.ts";

/** The app's page where a person types a mind's address (packages/ui `ConnectMind`). The
 *  gate sends a browser there for a mind it is not connected to. */
export const CONNECT_PAGE_PATH = "/connect";

/** The port separates local apps sharing localhost's cookie jar. */
export function sessionCookieName(url: URL) {
  return `__Host-itx-session${url.port ? `-${url.port}` : ""}`;
}

const COOKIE_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** The id the browser's cookie carries, or null. */
function cookieIdOf(request: Request): string | null {
  const id = cookieValueOf(request.headers.get("cookie"), sessionCookieName(new URL(request.url)));
  return id && COOKIE_ID.test(id) ? id : null;
}

/** THE ADDRESS THAT A QUERY PARAMETER NAMES: null when it names none, else the address and
 *  whether it is spelled exactly so. A parameter is written by a page or a link, never typed
 *  into the connect page's field, so it is the mind's address as it is (iterate/mind-api
 *  `mindAddressGiven`): `example.com` names the mind whose control plane is `example.com`, and
 *  never `iterate.example.com`. */
function addressParamOf(url: URL, name = "mind"): { address: string; exact: boolean } | null {
  const value = url.searchParams.get(name);
  const address = value && mindAddressGiven(value);
  return address ? { address, exact: address === value } : null;
}

/** `next` with a `/minds/<segment>` that spells `address` in other letter case spelled as
 *  `address`, so a mind has one URL in the app. */
function nextFor(next: string, address: string) {
  const match = /^\/minds\/([^/?#]+)(.*)$/s.exec(next);
  if (!match) return next;
  let segment: string;
  try {
    segment = decodeURIComponent(match[1]!);
  } catch {
    return next;
  }
  return mindAddressGiven(segment) === address ? `/minds/${address}${match[2]}` : next;
}

/** WHETHER THE MIND AT `address` REFUSES `bearer` NOW: one session of its API (./api.ts
 *  `ControlPlaneApi`), where the mind checks a credential, opened for the one question and
 *  closed. True for the mind's own refusal alone, UNAUTHENTICATED. A mind that cannot be reached,
 *  answers no socket, answers late or fails in another way has refused nothing: an outage never
 *  signs a browser out. */
async function mindRefuses(address: string, bearer: string): Promise<boolean> {
  const answer = await fetch(mindApiUrlOf(address), { headers: { upgrade: "websocket" } }).catch(
    () => null,
  );
  const socket = answer?.webSocket;
  if (!socket) return false;
  socket.accept();
  using api = newWebSocketRpcSession<ControlPlaneApi>(socket);
  try {
    using _session = await withTimeout(
      Promise.resolve(api.authenticate(bearer)),
      5_000,
      `Asking ${address} about a session`,
    );
    return false;
  } catch (error) {
    return errorCode(error) === "UNAUTHENTICATED";
  } finally {
    socket.close(1000, "asked");
  }
}

const noStore = { "Cache-Control": "no-store" };
const redirect = (location: string, status = 303, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { Location: location, ...noStore, ...headers } });

type AppAuth = {
  /** Public app branding; relative logo paths resolve against this app's origin. */
  client?: { name: string; logoUri: string };
  sessions: DurableObjectNamespace<BrowserSession>;
};

/** The OAuth client and `/api` proxy of an app Worker. Null passes the request on to the app. */
export async function appAuth(request: Request, config: AppAuth): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/.auth/") && url.pathname !== "/api") return null;
  const { sessions } = config;
  const client = config.client && {
    name: config.client.name,
    logoUri: new URL(config.client.logoUri, url.origin).href,
  };
  const id = cookieIdOf(request);
  /** The browser's record of its minds. */
  const record = (cookieId: string) => sessions.getByName(`${url.origin}:${cookieId}`);
  /** The browser's session for one mind. */
  const sessionOf = (cookieId: string, address: string) =>
    sessions.getByName(`${url.origin}:${cookieId}:${address}`);

  /** Start a sign-in to `address`: discovery, then the code flow at the issuer it found. A browser
   *  already signed in there goes on to `next`. The cookie is written again with each start, so
   *  its thirty days run from the last sign-in. */
  const discover = (address: string) => discoverMind(address, { local: isLocalOrigin(url.origin) });
  const signIn = async (
    address: string,
    next: string,
    discovered?: DiscoveredMind,
  ): Promise<{ location: string; setCookie: string } | { error: string }> => {
    // THE COOKIE'S ID IS KEPT ONLY WHEN THIS APP KNOWS IT: an id with no record was not written by
    // a sign-in here, so somebody planted it, and tokens stored under it would be theirs to use.
    const cookieId = id && (await record(id).known()) ? id : crypto.randomUUID();
    const setCookie = `${sessionCookieName(url)}=${cookieId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
    // "SIGNED IN ALREADY" IS THE MIND'S TO SAY, NOT THE STORED BEARER'S. A page comes here with a
    // live session when the mind refused the session's bearer in its API (iterate/app `adopt`):
    // a grant that ended elsewhere. Sent back on the stored bearer's word, the page would be
    // refused again and come here again, for as long as the token lives. So the gate asks the
    // mind, and forgets a session whose bearer the mind itself refuses (`mindRefuses`). Nothing
    // in the request can make it forget one: a page of another origin that sends a browser here
    // makes the gate ask, and a session that the mind takes stays.
    const session = id === cookieId ? sessionOf(id, address) : null;
    const bearer = session && (await session.bearer());
    if (session && bearer) {
      if (!(await mindRefuses(address, bearer))) return { location: next, setCookie };
      await session.discard();
    }
    const mind = discovered || (await discover(address));
    if ("error" in mind) return mind;
    const { url: location, state } = await sessionOf(cookieId, address).begin(
      { origin: url.origin, mind, client },
      next,
    );
    await record(cookieId).expect(state, address);
    return { location, setCookie };
  };
  // the page puts `mind` in its field, where a person's shorthand is read: so it is spelled as
  // that reading takes it
  const connectPage = (address: string, next: string) =>
    `${CONNECT_PAGE_PATH}?${new URLSearchParams({ mind: mindAddressAsTyped(address), next })}`;

  if (url.pathname === "/.auth/client.json")
    return Response.json(
      {
        client_id: `${url.origin}/.auth/client.json`,
        client_name: client?.name || url.host,
        client_uri: url.origin,
        logo_uri: client?.logoUri,
        redirect_uris: [`${url.origin}/.auth/callback`],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );

  if (url.pathname === "/.auth/minds.json") {
    // the minds this browser is connected to, by address: for the app's own pages alone
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const site = request.headers.get("sec-fetch-site");
    if ((site && site !== "same-origin") || !isSameOriginBrowserRequest(request))
      return new Response("Cross-site request refused", { status: 403 });
    const answer = id ? await record(id).minds() : { minds: [], lastUsed: null };
    return Response.json(answer, { headers: noStore });
  }

  if (url.pathname === "/.auth/connect") {
    // The connect page's form, sent by the page's own script: the answer is JSON, the authorization
    // URL to leave for or a reason the page shows beside the field.
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!isSameOriginBrowserRequest(request) || !request.headers.get("origin"))
      return new Response("Cross-site request refused", { status: 403 });
    const form = await request.formData();
    const typed = mindAddressOf(String(form.get("mind") ?? ""));
    if ("error" in typed) return Response.json(typed, { status: 400, headers: noStore });
    const mind = await discover(typed.address);
    if ("error" in mind) return Response.json(mind, { status: 400, headers: noStore });
    const { address } = mind;
    const next = nextFor(
      sameOriginPath(String(form.get("next") || `/minds/${address}`), url.origin),
      address,
    );
    const started = await signIn(address, next, mind);
    if ("error" in started) return Response.json(started, { status: 400, headers: noStore });
    return Response.json(
      { location: started.location },
      { headers: { ...noStore, "Set-Cookie": started.setCookie } },
    );
  }

  if (url.pathname === "/.auth/login") {
    // Sign in again to a mind this browser is connected to: a link may do that. A mind it is
    // not connected to goes to the connect page, which asks.
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const linked = sameOriginPath(url.searchParams.get("next") || "/", url.origin);
    const typed = addressParamOf(url);
    if (!typed) return redirect(CONNECT_PAGE_PATH);
    const { address } = typed;
    const connected = id ? (await record(id).minds()).minds.map((p) => p.address) : [];
    if (!connected.includes(address)) return redirect(connectPage(address, linked));
    const next = nextFor(linked, address);
    const started = await signIn(address, next);
    // discovery failed: the connect page posts the same address and shows why
    if ("error" in started) return redirect(connectPage(address, next));
    return redirect(started.location, 302, {
      "Set-Cookie": started.setCookie,
      "Referrer-Policy": "no-referrer",
    });
  }

  if (url.pathname === "/.auth/callback") {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const state = url.searchParams.get("state");
    const address = id && state ? await record(id).addressOf(state) : null;
    const result = id && address ? await sessionOf(id, address).complete(url.search) : null;
    if (!id || !address || !result || "error" in result)
      return new Response(
        result && "error" in result
          ? result.error
          : "This sign-in expired or does not match this browser. Connect the mind again.",
        { status: 400, headers: { ...noStore, "Referrer-Policy": "no-referrer" } },
      );
    await record(id).connected(address);
    return redirect(result.next, 303, { "Referrer-Policy": "no-referrer" });
  }

  if (url.pathname === "/.auth/logout") {
    // Sign out of one mind: its session ends at the issuer when the issuer can revoke, and the
    // browser is no longer connected to it. Other minds stay signed in.
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!isSameOriginBrowserRequest(request))
      return new Response("Cross-site request refused", { status: 403 });
    const address = addressParamOf(url)?.address;
    if (!address) return new Response("Name the mind to sign out of", { status: 400 });
    if (id) {
      try {
        await sessionOf(id, address).end();
      } catch {
        console.error("oauth.app_logout_failed", { origin: url.origin, mind: address });
        return new Response(
          "Sign-out could not complete. Your session is still present; go back and try again.",
          { status: 503 },
        );
      }
      await record(id).forget(address);
    }
    return redirect(sameOriginPath(url.searchParams.get("next") || "/", url.origin));
  }

  if (url.pathname === "/api") {
    // The page's capnweb connection to one mind, a WebSocket, with the bearer of this browser's
    // session there on its request: the mind's API reads it at the page's `authenticate()`
    // (iterate/api `ControlPlaneApi`). THE COOKIE'S AUTHORITY IS SAME-ORIGIN ONLY (CSRF): a request
    // from another origin, or with no Origin at all, gets the 401 a browser with no session gets.
    const named = addressParamOf(url);
    if (!named) return new Response("Name the mind: /api?mind=<address>", { status: 400 });
    const { address } = named;
    // another spelling gets no session: the page signs in again, and the gate sends it to the
    // mind's one URL (`nextFor`)
    const session =
      named.exact && id && request.headers.get("origin") === url.origin
        ? sessionOf(id, address)
        : null;
    const bearer = session ? await session.bearer() : null;
    if (!id || !session || !bearer)
      return new Response(`Sign in to ${address}`, { status: 401, headers: noStore });
    // THE PAGE'S PROBE (iterate/app `createIterateClient`): any request that is no upgrade. The
    // gate answers it: this browser has a session for the mind. The mind's API has no other
    // transport than the socket, and checks the bearer there.
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 204, headers: noStore });
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    // The same-origin gate above already ran. Provider CORS reconstruction loses 101.
    headers.delete("origin");
    headers.set("authorization", `Bearer ${bearer}`);
    // where the credential goes is the mind's API, by the address its session is named for
    const [response] = await Promise.all([
      fetch(new Request(mindApiUrlOf(address), new Request(request, { headers }))),
      // the last used mind is where the app's home goes (`/.auth/minds.json`); best effort
      record(id)
        .touch(address)
        .catch(() => {}),
    ]);
    // THE MIND'S ANSWER SETS NOTHING IN THIS BROWSER. A mind is not this app: its `Set-Cookie`
    // would be a cookie of the app's origin, so a hostile mind could plant the session cookie's id
    // and hold the id under which the person next signs in to a mind of their own. Its
    // `Clear-Site-Data` would sign the browser out of every mind.
    const kept = new Headers(response.headers);
    kept.delete("set-cookie");
    kept.delete("clear-site-data");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: kept,
      webSocket: response.webSocket,
    });
  }

  return new Response("Not found", { status: 404 });
}
