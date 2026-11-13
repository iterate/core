// sdk/auth.ts — WHO IS ASKING, for a mind's config worker: `this.auth` on `IterateConfigEntrypoint`
// (./index.ts). It reads the stamps ingress puts on a request for one of the mind's hostnames,
// and answers the challenge that makes ingress sign a person in. The guards are below.
import { z } from "zod";
import { isSameOriginBrowserRequest } from "../lib.ts";
import {
  ITX_PERSON_HEADER,
  ITX_PRINCIPAL_HEADER,
  type Person,
  SignInMethod,
} from "../principal.ts";
import { ITERATE_SERVE_HEADER } from "../mind-ingress.ts";

const Principal = z.object({ actor: z.string().min(1), email: z.string().optional() });
const PersonStamp = z.object({
  userId: z.string().min(1),
  email: z.string(),
  impersonatedBy: z.object({ actor: z.string().min(1), email: z.string() }).optional(),
  // a way this SDK does not know is one no app names: the person counts as signed in by an
  // unknown way
  method: SignInMethod.optional().catch(undefined),
});

/** What the person guards take: `methods`, the ways to sign in that the app takes. */
export type PersonOptions = { methods?: readonly SignInMethod[] };

/** GUARDS FOR A MIND'S CONFIG WORKER, before it serves a page. Every hostname of the mind's
 *  domain but `iterate.<domain>` is the mind's own, and on each one ingress holds the browser
 *  session (core/boundary-worker/src/host-session.ts): it stamps anyone signed in as a person,
 *  `x-itx-person`, and a member as a principal too, `x-itx-principal`. Signing in says who someone
 *  is; whether they are a member is the mind's members list. So an app may serve people who
 *  are not members: its end users. Who arrives is core/boundary-worker/src/mind-host-sign-in.ts, "WHO
 *  ARRIVES". The guards:
 *    - `auth.require` asks for a member, and `auth.requirePerson` for anyone signed in. Both answer
 *      null when the request may go on, else the answer to send.
 *    - `auth.person` reads the person, or null: `{ userId, email, method }`. `userId` is stable:
 *      key what the app keeps per person by it.
 *
 *  WAYS TO SIGN IN. `auth.person` and `auth.requirePerson` take `{ methods }`: the ways to sign in
 *  that the app takes, of those the stack's config offers (`"passkey"`, `"email"`, `"google"`,
 *  `"cloudflare"`), in the order its sign-in page shows them. A person who signed in another way
 *  is no person to that guard: `requirePerson` answers the challenge with RFC 9470's
 *  `acr_values`, and for a page load ingress signs them in again on this host, by a way the app
 *  names. Without `methods`, every way counts but Cloudflare's: a sign-in with Cloudflare counts
 *  only where an app names it, because the stack does not know that Cloudflare checked the
 *  address (core/auth-worker/src/cloudflare-sign-in.ts). A session from before sessions said how
 *  they began counts only where an app names no `methods`. The guard is the rule: what the issuer
 *  shows a person is routing, which a browser can change.
 *
 *  ```js
 *  const refused = this.auth.requirePerson(request, { methods: ["cloudflare"] });
 *  if (refused) return refused;
 *  const person = this.auth.person(request, { methods: ["cloudflare"] }); // method: "cloudflare"
 *  ```
 *
 *  Signed out, `auth.require` answers `401` with `WWW-Authenticate: Bearer realm="iterate"`, and
 *  `auth.requirePerson` the same with `scope="identity"`. For a page load, ingress turns that answer
 *  into the sign-in on this host and back to the page; a person signed in who is no member gets one
 *  refusal page in place of a member's page. A fetch, a write or a WebSocket upgrade gets the 401
 *  (or, for a non-member at a member's page, a 403) itself. Ingress answers `/.iterate/` on every
 *  mind hostname itself: `/.iterate/sign-out` takes a POST from the host's own page. Any app can
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
 *  a page on another of the mind's hosts could otherwise open a socket to this app with the
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
  requirePerson(request: Request, options: PersonOptions = {}): Response | null {
    const refused = crossSiteRefusal(request);
    if (refused) return refused;
    if (auth.person(request, options)) return null;
    // RFC 9470's step-up challenge: the person here signed in by a way this app does not take
    const params = ['realm="iterate"', 'scope="identity"'];
    if (request.headers.has(ITX_PERSON_HEADER))
      params.push('error="insufficient_user_authentication"');
    if (options.methods) params.push(`acr_values="${options.methods.join(" ")}"`);
    return signIn(`Bearer ${params.join(", ")}`);
  },
  person(request: Request, { methods }: PersonOptions = {}): Person | null {
    const stamp = request.headers.get(ITX_PERSON_HEADER);
    if (!stamp) return null;
    // Platform-owned stamp; malformed means a defect.
    const person = PersonStamp.parse(JSON.parse(stamp));
    const taken = methods
      ? Boolean(person.method && methods.includes(person.method))
      : person.method !== "cloudflare";
    return taken ? person : null;
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
