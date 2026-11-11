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
import type { BrowserSession } from "./app-session.ts";
import { type DiscoveredMind, discoverMind, resolveMind } from "./client/oauth.ts";
import { cookieValueOf, isLocalOrigin, isSameOriginBrowserRequest, sameOriginPath } from "./lib.ts";
import { mindAddressCandidatesOf, mindAddressOf, mindApiUrlOf } from "./mind-api.ts";

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

/** The address a query parameter names, as typed or linked: null when it names none, else the
 *  host and whether it is spelled exactly so. */
function addressParamOf(url: URL, name = "mind"): { address: string; exact: boolean } | null {
  const value = url.searchParams.get(name);
  if (!value) return null;
  const parsed = mindAddressOf(value);
  return "address" in parsed ? { address: parsed.address, exact: parsed.address === value } : null;
}

/** `next` with a `/minds/<segment>` that names `address` another way spelled as `address`, so
 *  a mind has one URL in the app. */
function nextFor(next: string, address: string) {
  const match = /^\/minds\/([^/?#]+)(.*)$/s.exec(next);
  if (!match) return next;
  let segment: string;
  try {
    segment = decodeURIComponent(match[1]!);
  } catch {
    return next;
  }
  const parsed = mindAddressOf(segment);
  return "address" in parsed && mindAddressCandidatesOf(parsed.address).includes(address)
    ? `/minds/${address}${match[2]}`
    : next;
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
    const cookieId = id || crypto.randomUUID();
    const setCookie = `${sessionCookieName(url)}=${cookieId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
    if (id && (await sessionOf(id, address).bearer())) return { location: next, setCookie };
    const mind = discovered || (await discover(address));
    if ("error" in mind) return mind;
    const { url: location, state } = await sessionOf(cookieId, address).begin(
      { origin: url.origin, mind, client },
      next,
    );
    await record(cookieId).expect(state, address);
    return { location, setCookie };
  };
  const connectPage = (address: string, next: string) =>
    `${CONNECT_PAGE_PATH}?${new URLSearchParams({ mind: address, next })}`;

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
    const mind = await resolveMind(typed.address, discover);
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
    // a mind this browser is connected to under any name the link may mean
    const connected = id ? (await record(id).minds()).minds.map((p) => p.address) : [];
    const address = mindAddressCandidatesOf(typed.address).find((candidate) =>
      connected.includes(candidate),
    );
    if (!address) return redirect(connectPage(typed.address, linked));
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
    // The page's capnweb connection to one mind, a WebSocket or an HTTP batch, with the bearer
    // of this browser's session there. THE COOKIE'S AUTHORITY IS SAME-ORIGIN ONLY (CSRF): a request
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
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    // The same-origin gate above already ran. Provider CORS reconstruction loses 101.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") headers.delete("origin");
    headers.set("authorization", `Bearer ${bearer}`);
    // where the credential goes is the mind's API, by the address its session is named for
    const [response] = await Promise.all([
      fetch(new Request(mindApiUrlOf(address), new Request(request, { headers }))),
      // the last used mind is where the app's home goes (`/.auth/minds.json`); best effort
      record(id)
        .touch(address)
        .catch(() => {}),
    ]);
    if (response.status === 401) await session.discard();
    return response;
  }

  return new Response("Not found", { status: 404 });
}
