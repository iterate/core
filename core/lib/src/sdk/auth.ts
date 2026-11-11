// sdk/auth.ts — WHO IS ASKING, for a project's config worker: `this.auth` on `IterateConfigEntrypoint`
// (./index.ts). It reads the stamps ingress puts on a request for one of the project's hostnames,
// and answers the challenge that makes ingress sign a person in. The guards are below.
import { z } from "zod";
import { isSameOriginBrowserRequest } from "../lib.ts";
import { ITX_PERSON_HEADER, ITX_PRINCIPAL_HEADER, type Person } from "../principal.ts";
import { ITERATE_SERVE_HEADER } from "../project-ingress.ts";

const Principal = z.object({ actor: z.string().min(1), email: z.string().optional() });
const PersonStamp = z.object({
  userId: z.string().min(1),
  email: z.string(),
  impersonatedBy: z.object({ actor: z.string().min(1), email: z.string() }).optional(),
});

/** GUARDS FOR A PROJECT'S CONFIG WORKER, before it serves a page. Every hostname of the project's
 *  domain but `iterate.<domain>` is the project's own, and on each one ingress holds the browser
 *  session (core/boundary/src/host-session.ts): it stamps anyone signed in as a person,
 *  `x-itx-person`, and a member as a principal too, `x-itx-principal`. Signing in says who someone
 *  is; whether they are a member is the project's members list. So an app may serve people who
 *  are not members: its end users. Who arrives is core/boundary/src/project-host-sign-in.ts, "WHO
 *  ARRIVES". The guards:
 *    - `auth.require` asks for a member, and `auth.requirePerson` for anyone signed in. Both answer
 *      null when the request may go on, else the answer to send.
 *    - `auth.person` reads the person, or null: `{ userId, email }`. `userId` is stable: key what
 *      the app keeps per person by it.
 *
 *  Signed out, `auth.require` answers `401` with `WWW-Authenticate: Bearer realm="iterate"`, and
 *  `auth.requirePerson` the same with `scope="identity"`. For a page load, ingress turns that answer
 *  into the sign-in on this host and back to the page; a person signed in who is no member gets one
 *  refusal page in place of a member's page. A fetch, a write or a WebSocket upgrade gets the 401
 *  (or, for a non-member at a member's page, a 403) itself. Ingress answers `/.iterate/` on every
 *  project hostname itself: `/.iterate/sign-out` takes a POST from the host's own page. Any app can
 *  ask for a member the same way:
 *
 *  ```js
 *  if (!request.headers.get("x-itx-principal"))
 *    return new Response("Sign in\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iterate"' } });
 *  ```
 *
 *  A write or a WebSocket upgrade must also come from this origin (or carry no Origin, a non-browser
 *  client), else 403. Ingress already sends such a cookie request on anonymous; this repeats the
 *  check where the app runs. The handshake is a GET, but it opens a two-way channel, and the
 *  session cookie is `SameSite=Lax`: every hostname of the domain is same-site with every other, so
 *  a page on another of the project's hosts could otherwise open a socket to this app with the
 *  visitor's cookie. */
export const auth = {
  require(request: Request): Response | null {
    const refused = crossSiteRefusal(request);
    if (refused) return refused;
    const principal = request.headers.get(ITX_PRINCIPAL_HEADER);
    if (principal) {
      Principal.parse(JSON.parse(principal)); // Platform-owned stamp; malformed means a defect.
      return null;
    }
    return signIn('Bearer realm="iterate"');
  },
  requirePerson(request: Request): Response | null {
    const refused = crossSiteRefusal(request);
    if (refused) return refused;
    if (auth.person(request)) return null;
    return signIn('Bearer realm="iterate", scope="identity"');
  },
  person(request: Request): Person | null {
    const person = request.headers.get(ITX_PERSON_HEADER);
    // Platform-owned stamp; malformed means a defect.
    return person ? PersonStamp.parse(JSON.parse(person)) : null;
  },
  /** THE MEMBER'S OWN `itx`, FOR THE PAGE THEY ARE ON: answer this from the path the page opens
   *  its WebSocket on (`new WebSocket("/itx")`, a capnweb session). It answers the member guard's
   *  refusal, or asks the platform to serve the socket in this answer's place. The platform
   *  decides who the caller is, from the request it holds: a member the boundary signed in on this
   *  host, on a WebSocket upgrade from this origin. What the page then appends is marked
   *  `source.via.appPage`, this host, and the session ends when the sign-in does. */
  itx(request: Request): Response {
    return (
      auth.require(request) ||
      new Response("Open this path as a WebSocket: it is the page's itx.\n", {
        status: 426,
        headers: { upgrade: "websocket", [ITERATE_SERVE_HEADER]: "itx" },
      })
    );
  },
};

/** A write or a WebSocket upgrade from another origin: 403. */
function crossSiteRefusal(request: Request): Response | null {
  const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const isRead = ["GET", "HEAD", "OPTIONS"].includes(request.method) && !isWebSocketUpgrade;
  if (isRead || isSameOriginBrowserRequest(request)) return null;
  return new Response("Cross-site request refused", { status: 403 });
}

function signIn(challenge: string): Response {
  return new Response("Sign in\n", {
    status: 401,
    headers: { "WWW-Authenticate": challenge, "Cache-Control": "no-store" },
  });
}
