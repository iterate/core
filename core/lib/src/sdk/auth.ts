// sdk/auth.ts — WHO IS ASKING, for a mind's config worker: `this.auth` on `IterateConfigEntrypoint`
// (./index.ts). It reads the stamps ingress puts on a request for one of the mind's hostnames,
// and answers the challenge that makes ingress sign a person in. The guards are below.
import { isSameOriginBrowserRequest } from "../lib.ts";
import { isMindControlPlaneHostname } from "../signed.ts";
import {
  type AddressedPerson,
  type Guest,
  type MindPerson,
  type Person,
  type Principal,
  principalStampOf,
  stampedPersonOf,
} from "../principal.ts";
import {
  ITERATE_CONTROL_PLANE_HOSTNAME_HEADER,
  ITERATE_SERVE_ADMITS_HEADER,
  ITERATE_SERVE_CONTEXT_HEADER,
  ITERATE_SERVE_HEADER,
} from "../mind-ingress.ts";

/** GUARDS FOR A MIND'S CONFIG WORKER, before it serves a page. Every hostname of the mind's
 *  domain but `iterate.<domain>` is the mind's own, and on each one ingress holds the browser
 *  session (core/boundary-worker/src/host-session.ts): it stamps anyone signed in as a person,
 *  `x-itx-person`, and a member as a principal too, `x-itx-principal`. Signing in says who someone
 *  is; whether they are a member is the mind's members list. So an app may serve people who
 *  are not members: its end users. Who arrives is core/boundary-worker/src/mind-host-sign-in.ts, "WHO
 *  ARRIVES". The guards:
 *    - `auth.require` asks for a member, and `auth.requirePerson` for anyone signed in who proved
 *      an address. Both answer null when the request may go on, else the answer to send.
 *    - `auth.person` reads the person, or null: `{ userId, email, name, method }`. `userId` is
 *      stable: key what the app keeps per person by it. `name` is what to call them on a page,
 *      the part of their address before the "@": escape it where you show it, and decide nothing
 *      by it. `method` is how they signed in: "passkey" or "email". The app names which it takes
 *      (`AppDescription.signIn`, ../app-description.ts) and the mind's issuer holds every sign-in
 *      to that list, so the guards take no list of methods.
 *    - `auth.principal` reads who is stamped as a principal, or null: a member's
 *      `{ actor, email }`, or ANOTHER MIND's `{ actor, kind: "mind", hostname }`, on a request that
 *      the mind signed. A mind is no member: `auth.require` refuses it, as it refuses nobody. An
 *      app that serves other minds reads `kind === "mind"`, then decides by `actor`, the mind's id;
 *      `hostname` is a label to show, which can move to another mind.
 *
 *  GUESTS. An app that names `"guest"` in its `signIn` lets in anyone who types a name
 *  (core/auth-worker/src/guest-sign-in.ts). EVERY GUARD REFUSES A GUEST unless its call says
 *  `{ guests: true }`: so a route takes guests only where its code says so, and a guest is never
 *  taken for a person who proved an address. With it, `auth.person` may answer a guest, `{
 *  userId, email: "", name, method: "guest" }` (iterate/principal `Guest`), whose `name` is the
 *  one they typed, and nothing about whom is checked. A guest is never a member and never a
 *  principal. So that name alone must open nothing: check what the visitor holds (a share link's
 *  secret, say) before you serve, and check it again on every page load. A guest's session on
 *  your host lasts 15 minutes and is renewed with no question while the browser comes back, and
 *  only while your app's description still names "guest"; your check is what ends a guest's
 *  reach when a link ends. A member's passkey counts at every app: a member who is signed in
 *  comes in as the member, never as a guest. Name the other ways beside "guest" in `signIn`
 *  (`["guest", "passkey"]`) for a sign-in page that offers them.
 *
 *  MEMBERS OF OTHER MINDS. An app that names `"mind"` in its `signIn` lets in a member of any
 *  other mind, whose own mind signs that they are one (core/auth-worker/src/mind-sign-in.ts). Every
 *  guard refuses such a person unless its call says `{ minds: true }`. With it, `auth.person`
 *  may answer `{ userId, email: "", name, method: "mind", mind: { id, hostname, userId } }`
 *  (iterate/principal `MindPerson`): `mind.id` is their mind's id, which decides; `hostname` is a
 *  label; `mind.userId` is who they are at their mind. No address comes, and they are no member
 *  here. ANOTHER SITE CAN SIGN A VISITOR IN AS A MEMBER OF ITS OWN MIND (a login CSRF), so a page
 *  that shows what belongs to a mind says first whose it is ("Signed in as a member of
 *  <hostname>"). The session lasts 24 hours, and then the person asks their mind again. To send a
 *  person to their mind at once, from a link that names it, answer `auth.mindSignIn`.
 *
 *  ```js
 *  const refused = this.auth.requirePerson(request); // a person who proved an address
 *  if (refused) return refused;
 *  const person = this.auth.person(request);
 *
 *  const refused = this.auth.requirePerson(request, { guests: true }); // a guest too
 *  if (refused) return refused;
 *  const visitor = this.auth.person(request, { guests: true }); // visitor.method === "guest"?
 *
 *  const visitor = this.auth.person(request, { minds: true }); // a member of another mind too
 *  if (!visitor) {
 *    const mind = new URL(request.url).searchParams.get("mind");
 *    return mind ? this.auth.mindSignIn(request, mind) : this.auth.requirePerson(request, { minds: true });
 *  }
 *  ```
 *
 *  Signed out, `auth.require` answers `401` with `WWW-Authenticate: Bearer realm="iterate"`, and
 *  `auth.requirePerson` the same with `scope="identity"`. For a page load, ingress turns that answer
 *  into the sign-in on this host and back to the page; a person signed in who is no member gets one
 *  refusal page in place of a member's page. A fetch, a write or a WebSocket upgrade gets the 401
 *  (or, for a non-member at a member's page, a 403) itself. Ingress answers `/.iterate/` on every
 *  mind hostname itself: `/.iterate/sign-out` takes a POST from the host's own page. Any app asks
 *  for a member so:
 *
 *  ```js
 *  const refused = this.auth.require(request);
 *  if (refused) return refused;
 *  ```
 *
 *  Read who asks through `this.auth`, never from a header by hand: the platform names a member and
 *  another mind in headers of their own, and `auth.principal` reads both.
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
    // a member alone: another mind's stamp gets the answer that nobody gets. The stamp is the
    // platform's, so a malformed one is a defect, and throws.
    if (principalStampOf(request.headers).principal) return null;
    return signIn('Bearer realm="iterate"');
  },
  /** WHO IS STAMPED AS A PRINCIPAL: a member, or another mind (`kind: "mind"`, `actor` its id,
   *  `hostname` a label), or null. AN ANSWER IS NOT A MEMBER: decide by `kind` (a mind has
   *  `"mind"`, a member none), then by `actor`; guard a member's page with `auth.require`. */
  principal(request: Request): Principal | null {
    const { principal, mind } = principalStampOf(request.headers);
    return principal || mind || null;
  },
  requirePerson(request: Request, options: PersonOptions = {}): Response | null {
    const refused = crossSiteRefusal(request);
    if (refused) return refused;
    const person = stampedPersonOf(request);
    if (person && taken(person, options)) return null;
    // a guest or another mind's member here: a sign-in would bring the same person back
    if (person) return wayRefusal(person.method);
    return signIn('Bearer realm="iterate", scope="identity"');
  },
  person: personOf,
  /** TO THE PERSON'S OWN MIND AT `hostname`, to sign in as its member: a 302 to this mind's
   *  issuer, which asks that mind and comes back to this URL without its `mind` parameter. There
   *  the route answers `requirePerson`'s refusal as for anyone signed out, and ingress signs the
   *  person in with no question. Only for an app that names `"mind"` in its `signIn`; a hostname
   *  that is no mind's control-plane hostname gets a 400. */
  mindSignIn(request: Request, hostname: string): Response {
    const mind = hostname.trim().toLowerCase();
    if (!isMindControlPlaneHostname(mind))
      return new Response("That is no mind's address.\n", {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    const next = new URL(request.url);
    next.searchParams.delete("mind");
    const to = new URL(`https://${auth.controlPlaneHostname(request)}/sign-in/mind`);
    to.search = new URLSearchParams({ mind, next: next.href }).toString();
    return new Response(null, {
      status: 302,
      headers: { location: to.href, "Cache-Control": "no-store" },
    });
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
  /** ONE `run` OF AN MCP SERVER OF THE MIND'S OWN, AS THE MEMBER WHO ASKS. A config's own MCP
   *  server owns every word a client's model reads (its instructions, its tools' descriptions),
   *  and hands a member's `tools/call` of `run` to the platform with this answer: the member
   *  guard's refusal, or the JSON-RPC message for the platform to answer in this answer's place,
   *  as it answers `run` at the mind's own `/mcp`. The platform decides who the caller is, from
   *  the request it holds: the member the boundary stamped on a POST. So the script runs with
   *  that member's reach and name, never with this worker's (`this.getItx()`). The run's own
   *  record names the member and this host (`source.principal`, `source.via.appPage`), and what
   *  the script appends names them as who it was for (`source.onBehalfOf.principal`,
   *  `source.onBehalfOf.via.appPage`). The platform takes a `tools/call` of
   *  `run` alone; the answer is an MCP answer (JSON, or an event stream that keeps a long run's
   *  connection open).
   *
   *  ```js
   *  if (call.method === "tools/call" && call.params?.name === "run")
   *    return this.auth.mcpRun(request, { jsonrpc: "2.0", id: call.id, method: "tools/call",
   *      params: { name: "run", arguments: { script: call.params.arguments.script },
   *        _meta: call.params._meta } });
   *  ``` */
  mcpRun(request: Request, message: McpRunMessage): Response {
    return (
      auth.require(request) ||
      Response.json(message, { headers: { [ITERATE_SERVE_HEADER]: "mcp-run" } })
    );
  },
  /** A SIGNED-IN PERSON'S LIVE VIEW OF ONE CONTEXT, for the page they are on: answer this from
   *  the path the page opens its WebSocket on (a capnweb session). It answers the person guard's
   *  refusal (`requirePerson`, with the same `{ guests: true }` for a page that takes guests), or
   *  asks the platform to serve the socket
   *  in this answer's place, rooted at `path`. Your code decides whether this person may have that
   *  context, before it answers: the platform serves whatever context the answer names. The
   *  platform decides who the caller is, from the request it holds: the person the boundary
   *  signed in on this host (a member is a person too), on a WebSocket upgrade from this origin.
   *
   *  ```js
   *  const person = this.auth.person(request);
   *  if (person && !(await mayChat(person, path))) return new Response("Not yours\n", { status: 403 });
   *  return this.auth.personItx(request, path);
   *  ```
   *
   *  The socket is no `itx`: it reads that context's log and live state, names the person on the
   *  words they send its agent and on the stop of an answer, and signs a URL for a file under its
   *  path. Nothing else (core/configs/default/people.md, "A live view of one context"). The
   *  session ends when the sign-in does.
   *
   *  `admits` names a facet of that context whose person method `admits()` says whether the
   *  person still reaches it. For a person who is no member, the platform asks it before each
   *  write and at most once every 5 seconds of the socket's traffic, and a `false` or a throw
   *  ends the socket: a guest whose link ended is out of the context, not only of a call. A
   *  member is never asked. */
  personItx(
    request: Request,
    path: string,
    options: PersonOptions & { admits?: string } = {},
  ): Response {
    return (
      auth.requirePerson(request, options) ||
      new Response("Open this path as a WebSocket: it is the page's view of one context.\n", {
        status: 426,
        headers: {
          upgrade: "websocket",
          [ITERATE_SERVE_HEADER]: "person-itx",
          [ITERATE_SERVE_CONTEXT_HEADER]: path,
          ...(options.admits && { [ITERATE_SERVE_ADMITS_HEADER]: options.admits }),
        },
      })
    );
  },
  /** THE MIND'S CONTROL-PLANE HOSTNAME, as the mind Worker says it on every request that it hands to
   *  the mind's code, in any context (iterate/mind-ingress): where the mind's sign-in, its keys,
   *  its members and its approvals pages are, and the mind's address. An app takes it from here
   *  and never from the hostname it is served on, which may be in any zone of the mind. Throws
   *  for a request that the platform did not hand over, such as one the code built itself:
   *  nothing else says it. */
  controlPlaneHostname(request: Request): string {
    const controlPlaneHostname = request.headers.get(ITERATE_CONTROL_PLANE_HOSTNAME_HEADER);
    if (!controlPlaneHostname)
      throw new Error(
        `This request has no ${ITERATE_CONTROL_PLANE_HOSTNAME_HEADER}: the platform did not hand it to this code.`,
      );
    return controlPlaneHostname;
  },
  /** WHAT A MEMBER'S PAGE OF @iterate-com/ui ASKS OF ITS APP'S HOST, or null for any other path:
   *  `/itx`, its socket (`auth.itx`), and the three answers its shell's sidebar asks under
   *  `/.auth/`, written for an app with a sign-in gate of its own. Here the platform signs people
   *  in, so they say: the issuer is the mind's own, at its control-plane hostname (`session.json`), this
   *  app serves one mind (`minds.json`), and "Sign out" is the platform's (`logout`). Call it
   *  behind the member guard. */
  memberPage(request: Request): Response | null {
    const url = new URL(request.url);
    if (url.pathname === "/itx") return auth.itx(request);
    if (url.pathname === "/.auth/session.json") {
      const issuer = `https://${auth.controlPlaneHostname(request)}`;
      return Response.json({ issuer, defaultIssuer: issuer });
    }
    if (url.pathname === "/.auth/minds.json") {
      const mind = auth.controlPlaneHostname(request);
      return Response.json({ minds: [{ address: mind, lastUsedAt: Date.now() }], lastUsed: mind });
    }
    // the platform's own sign-out takes the POST
    if (url.pathname === "/.auth/logout")
      return new Response(null, { status: 307, headers: { location: "/.iterate/sign-out" } });
    return null;
  },
};

/** The one message `auth.mcpRun` hands over: a JSON-RPC `tools/call` of the tool `run`. */
export type McpRunMessage = {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  /** `_meta`: the call's own, as the client sent it. MCP from 2026-07-28 on carries each
   *  request's envelope there (the protocol version, the client's capabilities), and the
   *  platform's handler refuses such a call without it. */
  params: { name: "run"; arguments: { script: string }; _meta?: Record<string, unknown> };
};

/** `{ guests: true }`: this route takes a guest too (see GUESTS above). `{ minds: true }`: and a
 *  member of another mind (see MEMBERS OF OTHER MINDS). */
type PersonOptions = { guests?: boolean; minds?: boolean };

/** The person that a call with `O` may answer. */
type PersonFor<O extends PersonOptions> =
  | AddressedPerson
  | (O extends { guests: true } ? Guest : never)
  | (O extends { minds: true } ? MindPerson : never);

const taken = (person: Person, options: PersonOptions) =>
  person.method === "guest"
    ? Boolean(options.guests)
    : person.method === "mind"
      ? Boolean(options.minds)
      : true;

/** WHO IS SIGNED IN, or null: a person who proved an address, and with `{ guests: true }` a
 *  guest too, with `{ minds: true }` a member of another mind too. Signed out, and a person whom
 *  the options do not name: null. */
function personOf<O extends PersonOptions = {}>(
  request: Request,
  options?: O,
): PersonFor<O> | null {
  const person = stampedPersonOf(request);
  // the cast: `taken` lets a guest through only with `guests` and another mind's member only
  // with `minds`, which is what `PersonFor<O>` says; TypeScript cannot narrow a union by a generic
  return person && taken(person, options || {}) ? (person as PersonFor<O>) : null;
}

/** A guest, or another mind's member, at a route that takes none: 403, and no sign-in, which
 *  would bring the same person back. */
const wayRefusal = (method: Person["method"]) =>
  new Response(
    method === "mind"
      ? "This page takes no sign-in by another mind. Sign out, and sign in here.\n"
      : "This page takes no guests. Sign out, and sign in with your address.\n",
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );

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
