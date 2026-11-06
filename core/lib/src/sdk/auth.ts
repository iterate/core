import { z } from "zod";
import { isSameOriginBrowserRequest } from "../lib.ts";
import { ITX_PERSON_HEADER, ITX_PRINCIPAL_HEADER, type Person } from "../principal.ts";

const Principal = z.object({ actor: z.string().min(1), email: z.string().optional() });
const PersonStamp = z.object({
  userId: z.string().min(1),
  email: z.string(),
  impersonatedBy: z.object({ actor: z.string().min(1), email: z.string() }).optional(),
});

/** Guards for a project's config worker, before it proxies an app. Who arrives at a project's
 *  host, and which stamp the edge puts on their request (`x-itx-person` for anyone signed in,
 *  `x-itx-principal` for a member), is core/os/src/project-host-sign-in.ts, "WHO ARRIVES". The
 *  guards:
 *    - `auth.require` asks for a member, and `auth.requirePerson` for anyone signed in. Both answer
 *      null when the request may go on, else the answer to send.
 *    - `auth.person` reads the person, or null. Its `impersonatedBy` names the platform admin
 *      signed in as them: an app that hands out something personal refuses, or records, that.
 *
 *  Signed out, `auth.require` answers `401` with `WWW-Authenticate: Bearer realm="iterate"`: the
 *  platform's edge turns that answer into the sign-in for a page load (or into "sign in again with
 *  this project" for someone signed in without it), whatever path the app is served under, and hands
 *  a fetch, a write or a WebSocket upgrade the 401 itself. `auth.requirePerson` answers the same
 *  challenge with `scope="identity"`: the sign-in asks the person only who they are, and grants no
 *  project. Any app can ask for a signed-in visitor the same way:
 *
 *  ```js
 *  if (!request.headers.get("x-itx-principal"))
 *    return new Response("Sign in\n", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="iterate"' } });
 *  ```
 *
 *  A write or a WebSocket upgrade must also come from this origin (or carry no Origin, a non-browser
 *  client), else 403. The edge already sends such a cookie request on anonymous; this repeats the
 *  check where the app runs. The handshake is a GET, but it opens a two-way channel, and the app
 *  session cookie is `SameSite=Lax`: every `<routingSlug>--<project>.iterate.app` host is same-site with
 *  every other, so a page on another project's host could otherwise open a socket to this app with
 *  the visitor's cookie. */
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
