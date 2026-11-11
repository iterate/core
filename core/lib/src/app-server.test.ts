// The app Worker's gate (app-server.ts) against a mind that is not the app's friend: what the mind
// answers on `/api` sets nothing in the browser, and a cookie id the app never wrote is not kept.
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
      method: "POST",
      headers: { cookie: cookie(PLANTED), origin: APP },
      body: "[]",
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
  // and the mind got the session's bearer, never the browser's cookie
  expect(sent[0]?.headers.get("authorization")).toBe("Bearer a-bearer");
  expect(sent[0]?.headers.get("cookie")).toBeNull();
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

// ── the fixture: an app origin, a mind, and the app's sessions as plain objects ─────────────────

const APP = "https://agents.example.org";
const MIND = "ada.example";
const PLANTED = "00000000-0000-4000-8000-000000000000";

function cookie(id: string) {
  return `${sessionCookieName(new URL(APP))}=${id}`;
}

/** The app's `sessions` namespace, with plain objects for the browser's record and its sessions:
 *  `known` says which cookie ids have a record, and `began` collects the ids a sign-in began under. */
function sessionsOf({ known = [] as string[], signedIn = [] as string[] } = {}) {
  const began: string[] = [];
  const namespace = {
    getByName: (name: string) => {
      const [, cookieId = "", address] = /^https:\/\/[^:]+:([^:]+)(?::(.+))?$/.exec(name) || [];
      return {
        known: async () => known.includes(cookieId),
        minds: async () => ({ minds: [], lastUsed: null }),
        expect: async () => {},
        touch: async () => {},
        discard: async () => {},
        bearer: async () => (address && signedIn.includes(cookieId) ? "a-bearer" : null),
        begin: async () => {
          began.push(cookieId);
          return { url: `https://iterate.${MIND}/oauth2/auth?state=s`, state: "s" };
        },
      };
    },
  } as unknown as DurableObjectNamespace<BrowserSession>;
  return { namespace, began };
}

/** The connect page's POST for the mind, with the cookie the browser sent. The mind's discovery
 *  documents are answered here: its API names its issuer, and the issuer its endpoints. */
function connect(sessions: DurableObjectNamespace<BrowserSession>, sentCookie: string) {
  vi.stubGlobal("fetch", async (input: Request | string | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: `https://iterate.${MIND}/api`,
        authorization_servers: [`https://iterate.${MIND}`],
      });
    return Response.json({
      issuer: `https://iterate.${MIND}`,
      authorization_endpoint: `https://iterate.${MIND}/oauth2/auth`,
      token_endpoint: `https://iterate.${MIND}/oauth2/token`,
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
