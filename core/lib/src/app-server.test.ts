// The app Worker's gate (app-server.ts) against a mind that is not the app's friend: what the mind
// answers on `/api` sets nothing in the browser, and a cookie id the app never wrote is not kept.
import {
  newWebSocketRpcSession,
  RpcTarget,
  upgradeWebSocketResponse,
  WebSocketPair,
} from "capnweb";
import { expect, test, vi } from "vitest";
import { appAuth, sessionCookieName } from "./app-server.ts";
import type { BrowserSession } from "./app-session.ts";

test("the mind's answer on /api sets no cookie and clears no site data in the browser", async () => {
  const { namespace } = sessionsOf({ known: [PLANTED], signedIn: [PLANTED] });
  const sent: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    return new Response('{"ok":true}', {
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", `${cookie("11111111-1111-4111-8111-111111111111")}; Secure; Path=/`],
        ["set-cookie", "other=1; Path=/"],
        ["clear-site-data", '"cookies"'],
        ["x-kept", "yes"],
      ],
    });
  });
  const response = await appAuth(
    new Request(`${APP}/api?mind=${MIND}`, {
      headers: { cookie: cookie(PLANTED), origin: APP, upgrade: "websocket" },
    }),
    { sessions: namespace },
  );
  expect(response?.status).toBe(200);
  expect(await response?.text()).toBe('{"ok":true}');
  expect(response?.headers.getSetCookie()).toEqual([]);
  expect(response?.headers.get("clear-site-data")).toBeNull();
  // the rest of the answer is the mind's own
  expect(response?.headers.get("x-kept")).toBe("yes");
  expect(response?.headers.get("content-type")).toBe("application/json");
  // and the mind got the session's bearer, never the browser's cookie or its origin
  expect(sent[0]?.headers.get("authorization")).toBe("Bearer a-bearer");
  expect(sent[0]?.headers.get("cookie")).toBeNull();
  expect(sent[0]?.headers.get("origin")).toBeNull();
});

test("the page's probe is answered by the gate: a session says 204, none says 401, and the mind gets no request", async () => {
  const { namespace } = sessionsOf({ known: [PLANTED], signedIn: [PLANTED] });
  const sent: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    return new Response("unexpected");
  });
  const probe = (headers: Record<string, string>) =>
    appAuth(new Request(`${APP}/api?mind=${MIND}`, { method: "POST", headers, body: "" }), {
      sessions: namespace,
    });
  expect((await probe({ cookie: cookie(PLANTED), origin: APP }))?.status).toBe(204);
  // the cookie's authority is same-origin only
  expect(
    (await probe({ cookie: cookie(PLANTED), origin: "https://elsewhere.example" }))?.status,
  ).toBe(401);
  expect((await probe({ origin: APP }))?.status).toBe(401);
  expect(sent).toEqual([]);
});

test("a mind whose control plane is a zone's apex: the session's bearer goes to that hostname, and to no other", async () => {
  const { namespace } = sessionsOf({ known: [PLANTED], signedIn: [PLANTED] });
  const sent: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push(request);
    return new Response("[]");
  });
  const response = await appAuth(
    new Request(`${APP}/api?mind=example.com`, {
      headers: { cookie: cookie(PLANTED), origin: APP, upgrade: "websocket" },
    }),
    { sessions: namespace },
  );
  expect(response).toMatchObject({ status: 200 });
  // a parameter is the address as it is: the shorthand of a typed address is not applied to it
  expect(sent.map((request) => request.url)).toEqual(["https://example.com/api"]);
});

test("the connect page is filled in with an apex address in a spelling that its field reads as that address", async () => {
  const { namespace } = sessionsOf();
  const response = await appAuth(new Request(`${APP}/.auth/login?mind=example.com&next=/x`), {
    sessions: namespace,
  });
  expect(response?.headers.get("location")).toBe(
    `/connect?${new URLSearchParams({ mind: "https://example.com", next: "/x" })}`,
  );
});

test("a sign-in under a cookie id the app has no record of begins under a new id", async () => {
  const { namespace, began } = sessionsOf();
  const response = await connect(namespace, cookie(PLANTED));
  expect(response?.status).toBe(200);
  const id = idIn(response);
  expect(id).toBeTruthy();
  expect(id).not.toBe(PLANTED);
  expect(began).toEqual([id]);
});

test("a sign-in under a cookie id the app knows keeps that id", async () => {
  const { namespace, began } = sessionsOf({ known: [PLANTED] });
  const response = await connect(namespace, cookie(PLANTED));
  expect(response?.status).toBe(200);
  expect(idIn(response)).toBe(PLANTED);
  expect(began).toEqual([PLANTED]);
});

test("a stored bearer that the mind refuses leads to one new sign-in, not to a loop: the gate asks the mind, forgets the session and starts again", async () => {
  const sessions = sessionsOf({ known: [PLANTED], signedIn: [PLANTED], connected: [MIND] });
  const mind = mindAnswering({ refuses: ["a-bearer"] });
  // the page was refused in its session of the mind's API, and left for the gate's sign-in
  const first = await login(sessions.namespace, cookie(PLANTED));
  // not back to the page on the stored bearer's word, but on to the mind's issuer
  expect(first?.headers.get("location")).toBe(`https://${MIND}/oauth2/auth?state=s`);
  expect(sessions).toMatchObject({ discarded: [PLANTED], began: [PLANTED] });
  expect(mind).toMatchObject({ asked: ["a-bearer"] });

  // the sign-in that followed stored a bearer that the mind takes: the page gets it, and stays
  sessions.signIn(PLANTED, "a-new-bearer");
  const second = await login(sessions.namespace, cookie(PLANTED));
  expect(second?.headers.get("location")).toBe("/x");
  expect(sessions).toMatchObject({ discarded: [PLANTED], began: [PLANTED] });
  expect(mind).toMatchObject({ asked: ["a-bearer", "a-new-bearer"] });
});

test.for([
  ["takes the bearer", {}],
  ["cannot be reached", { unreachable: true }],
  ["answers no socket", { noSocket: true }],
  ["fails in another way", { fails: "UNAVAILABLE" }],
] as const)(
  "a mind that %s keeps the browser's session: a page of another origin that sends a browser to the sign-in signs nobody out",
  async ([, answers]) => {
    const sessions = sessionsOf({ known: [PLANTED], signedIn: [PLANTED], connected: [MIND] });
    mindAnswering(answers);
    // a top-level navigation from anywhere: the request says nothing that the gate acts on
    const response = await login(sessions.namespace, cookie(PLANTED), {
      referer: "https://elsewhere.example/",
      "sec-fetch-site": "cross-site",
    });
    expect(response?.headers.get("location")).toBe("/x");
    expect(sessions).toMatchObject({ discarded: [], began: [] });
  },
);

// ── the fixture: an app origin, a mind, and the app's sessions as plain objects ─────────────────

const APP = "https://agents.example.org";
const MIND = "iterate.example.com";
const PLANTED = "00000000-0000-4000-8000-000000000000";

function cookie(id: string) {
  return `${sessionCookieName(new URL(APP))}=${id}`;
}

/** The app's `sessions` namespace, with plain objects for the browser's record and its sessions:
 *  `known` says which cookie ids have a record, and `began` collects the ids a sign-in began under. */
function sessionsOf({
  known = [] as string[],
  signedIn = [] as string[],
  /** The minds that the browser's record names. */
  connected = [] as string[],
} = {}) {
  const began: string[] = [];
  /** The cookie ids whose session the gate forgot. */
  const discarded: string[] = [];
  const bearers = new Map(signedIn.map((cookieId) => [cookieId, "a-bearer"]));
  const namespace = {
    getByName: (name: string) => {
      const [, cookieId = "", address] = /^https:\/\/[^:]+:([^:]+)(?::(.+))?$/.exec(name) || [];
      return {
        known: async () => known.includes(cookieId),
        minds: async () => ({
          minds: connected.map((mind) => ({ address: mind })),
          lastUsed: null,
        }),
        expect: async () => {},
        touch: async () => {},
        bearer: async () => (address && bearers.get(cookieId)) || null,
        discard: async () => {
          discarded.push(cookieId);
          bearers.delete(cookieId);
        },
        begin: async () => {
          began.push(cookieId);
          return { url: `https://${MIND}/oauth2/auth?state=s`, state: "s" };
        },
      };
    },
  } as unknown as DurableObjectNamespace<BrowserSession>;
  return {
    namespace,
    began,
    discarded,
    /** A sign-in completed: the session of `cookieId` holds `bearer`. */
    signIn: (cookieId: string, bearer: string) => void bearers.set(cookieId, bearer),
  };
}

/** `GET /.auth/login` for the mind, back to `/x`: where a page sends the browser to sign in again. */
function login(
  sessions: DurableObjectNamespace<BrowserSession>,
  sentCookie: string,
  headers: Record<string, string> = {},
) {
  return appAuth(
    new Request(`${APP}/.auth/login?${new URLSearchParams({ mind: MIND, next: "/x" })}`, {
      headers: { cookie: sentCookie, ...headers },
    }),
    { sessions },
  );
}

/** THE MIND, AS THE GATE'S `fetch` REACHES IT: its API (a capnweb session over a WebSocket, whose
 *  `authenticate` refuses the bearers of `refuses`, or fails with the code of `fails`) and its
 *  discovery documents. `asked`: each bearer that a session authenticated with. */
function mindAnswering(
  answers: { refuses?: string[]; unreachable?: true; noSocket?: true; fails?: string } = {},
) {
  const asked: unknown[] = [];
  class Root extends RpcTarget {
    authenticate(bearer: unknown) {
      asked.push(bearer);
      const code = answers.refuses?.includes(String(bearer)) ? "UNAUTHENTICATED" : answers.fails;
      if (code) throw Object.assign(new Error("refused"), { code });
      return { mind: null };
    }
  }
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api") {
      if (answers.unreachable) throw new TypeError("fetch failed");
      if (answers.noSocket) return new Response("no socket here", { status: 426 });
      expect(new Headers(init?.headers).get("upgrade")).toBe("websocket");
      const pair = new WebSocketPair();
      pair[1].accept();
      // capnweb's own half of its pair, which in workerd is the runtime's `WebSocket`
      newWebSocketRpcSession(pair[1] as unknown as WebSocket, new Root());
      return upgradeWebSocketResponse(pair[0]);
    }
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: `https://${MIND}/api`,
        authorization_servers: [`https://${MIND}`],
      });
    return Response.json({
      issuer: `https://${MIND}`,
      authorization_endpoint: `https://${MIND}/oauth2/auth`,
      token_endpoint: `https://${MIND}/oauth2/token`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
  });
  return { asked };
}

/** The connect page's POST for the mind, with the cookie the browser sent. The mind's discovery
 *  documents are answered here: its API names its issuer, and the issuer its endpoints. */
function connect(sessions: DurableObjectNamespace<BrowserSession>, sentCookie: string) {
  vi.stubGlobal("fetch", async (input: Request | string | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: `https://${MIND}/api`,
        authorization_servers: [`https://${MIND}`],
      });
    return Response.json({
      issuer: `https://${MIND}`,
      authorization_endpoint: `https://${MIND}/oauth2/auth`,
      token_endpoint: `https://${MIND}/oauth2/token`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
    });
  });
  return appAuth(
    new Request(`${APP}/.auth/connect`, {
      method: "POST",
      headers: { origin: APP, "sec-fetch-site": "same-origin", cookie: sentCookie },
      body: new URLSearchParams({ mind: MIND }),
    }),
    { sessions },
  );
}

/** The session cookie's id in an answer's `Set-Cookie`. */
function idIn(response: Response | null) {
  return new RegExp(`${sessionCookieName(new URL(APP))}=([0-9a-f-]{36})`).exec(
    response?.headers.get("set-cookie") || "",
  )?.[1];
}
