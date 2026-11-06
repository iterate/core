// project-host-sign-in.ts — who a project host's request arrives as, and what the edge makes of an
// app's "sign in to iterate" answer. Pure (no I/O); worker.ts calls both functions on every project
// host request, and project-host-sign-in.test.ts is their table.
//
// WHO ARRIVES — projectHostCallerOf. A "member" and a "non-member" are each a person, stamped
// `x-itx-person` (`{ userId, email }`); only a member is also stamped `x-itx-principal` (and its
// grant), so no app treats a person who is no member as one:
//   1. No verified credential: anonymous.
//   2. The session COOKIE counts on a write (any method but GET, HEAD, OPTIONS) or a WebSocket
//      upgrade only from the host's own origin (iterate/lib `isSameOriginBrowserRequest`: an absent
//      Origin passes). Otherwise the request goes on anonymous. A bearer is never sent by a browser
//      on its own, so it always counts. A person or principal an app is handed is therefore safe to
//      act on against another site; under paths every project's page is same-origin with every
//      other project's and the platform's, so this is no defence between them.
//   3. A verified credential whose reach does not include the project: a non-member. It goes on as
//      a person, never refused: what a person who is no member may see is the app's call.
//   4. Everything else: a member.
// Under paths a project's page shares the issuer's origin and cookie, and no client signs in per
// host: a person signed in at the issuer arrives as a person (or a member) on every project's page
// with no consent, so every project's app there learns who they are without asking.
//
// THE SIGN-IN CHALLENGE — projectHostSignInAnswerOf: an app asks for a signed-in caller by answering
// 401 with `WWW-Authenticate: Bearer realm="iterate"` (iterate/sdk `auth.require`: a member), or
// with `scope="identity"` beside the realm (`auth.requirePerson`: anyone signed in). Only that
// challenge is the platform's; a 401 with another scheme or realm is the app's own and passes
// untouched, as does every other status (a WebSocket's 101 included).
//   5. A member: the 401 passes (a sign-in would bring the same principal back: a loop). So does a
//      non-member's identity challenge: they are signed in already.
//   6. A top-level document navigation (GET or HEAD with `Sec-Fetch-Mode: navigate` and
//      `Sec-Fetch-Dest: document`; with neither header, an `Accept` naming text/html):
//        anonymous  → 302 to `<login>?next=<path>`, or for the identity challenge to
//                     `<login>?scope=identity&next=<path>`: a grant of who they are, and no project
//        non-member → 302 to `<login>?project=<slug>&next=<path>`, iterate/app-server's
//                     "Sign in again" page: sign in again, switch account, or go on without it
//      `<path>` is the path and query the browser addressed (a paths-routed base path included),
//      always a path on the host's own origin (iterate/lib `sameOriginPath`).
//   7. Anything else (a fetch, a write, an upgrade): anonymous → the 401 passes; non-member → 403 (a
//      401 would send an OAuth client to authorize again, to be handed the same token).

import { isSameOriginBrowserRequest, sameOriginPath } from "iterate/lib";

/** Who a project host's request arrives as (rules 1–4): a member and a non-member are each a
 *  person. */
export type ProjectHostCaller = "member" | "non-member" | "anonymous";

type RequestShape = Pick<Request, "method" | "url" | "headers">;

/** Rules 1–4: `authorization` is the credential that verified (null: none did), how it came, and
 *  whether its reach includes the project. */
export function projectHostCallerOf(input: {
  authorization: { via: "bearer" | "cookie"; reachesProject: boolean } | null;
  request: RequestShape;
}): ProjectHostCaller {
  const { authorization, request } = input;
  if (!authorization) return "anonymous";
  const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const isWrite = isWebSocketUpgrade || !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (authorization.via === "cookie" && isWrite && !isSameOriginBrowserRequest(request))
    return "anonymous";
  return authorization.reachesProject ? "member" : "non-member";
}

/** Rules 5–7: the edge's answer in place of the app's, or null when the app's answer stands.
 *  `loginUrl` is the absolute `/.auth/login` of the browser adapter serving this host. */
export function projectHostSignInAnswerOf(input: {
  answer: Pick<Response, "status" | "headers">;
  request: RequestShape;
  caller: ProjectHostCaller;
  projectSlug: string;
  loginUrl: string;
}): Response | null {
  const { answer, request, caller } = input;
  if (answer.status !== 401 || caller === "member") return null;
  const challenge = iterateSignInChallengeOf(answer.headers.get("www-authenticate"));
  if (!challenge) return null;
  const identity = challenge.scope === "identity";
  if (identity && caller === "non-member") return null;
  if (isDocumentNavigation(request)) {
    const url = new URL(request.url);
    const next = sameOriginPath(url.pathname + url.search, url.origin);
    const query = new URLSearchParams(
      identity
        ? { scope: "identity", next }
        : caller === "non-member"
          ? { project: input.projectSlug, next }
          : { next },
    );
    return new Response(null, {
      status: 302,
      headers: { Location: `${input.loginUrl}?${query}`, "Cache-Control": "no-store" },
    });
  }
  if (caller === "non-member")
    return new Response("This session cannot access this project\n", { status: 403 });
  return null;
}

/** An auth-scheme or auth-param name (RFC 9110 `token`). */
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
/** One auth-param, `name=token` or `name="quoted string"`, up to the next comma. */
const AUTH_PARAM = new RegExp(
  `^(${TOKEN})[ \\t]*=[ \\t]*(${TOKEN}|"(?:[^"\\\\]|\\\\.)*")[ \\t]*(?:,|$)`,
);
/** A challenge's scheme, with the token68 that may follow it (`Negotiate abc==`). */
const AUTH_SCHEME = new RegExp(`^(${TOKEN})(?:[ \\t]+[A-Za-z0-9._~+/-]+=*[ \\t]*(?=,|$))?`);

/** The platform's sign-in challenge in a `WWW-Authenticate` value (every challenge, as
 *  `Headers.get` joins them) — scheme `Bearer` (any case) with `realm="iterate"` — and its `scope`
 *  param ("" when it names none), or null when the value holds none. RFC 9110 §11.6.1's challenge
 *  list, parsed; the part of a value past where it stops parsing holds no challenge of ours. */
export function iterateSignInChallengeOf(header: string | null): { scope: string } | null {
  let rest = header || "";
  let scheme: string | null = null;
  let realm = false;
  let scope = "";
  const ours = () => (scheme === "bearer" && realm ? { scope } : null);
  for (;;) {
    rest = rest.replace(/^[\s,]+/, "");
    if (!rest) return ours();
    const param = scheme ? AUTH_PARAM.exec(rest) : null;
    if (param) {
      const name = param[1]!.toLowerCase();
      const value = param[2]!.startsWith('"')
        ? param[2]!.slice(1, -1).replace(/\\(.)/g, "$1")
        : param[2]!;
      if (name === "realm" && value === "iterate") realm = true;
      if (name === "scope") scope = value;
      rest = rest.slice(param[0].length);
      continue;
    }
    // a new challenge begins, or the value stops parsing: the one that ends is judged
    const found = ours();
    const challenge = AUTH_SCHEME.exec(rest);
    if (found || !challenge) return found;
    scheme = challenge[1]!.toLowerCase();
    realm = false;
    scope = "";
    rest = rest.slice(challenge[0].length);
  }
}

/** A browser loading a page into its window: GET or HEAD, `Sec-Fetch-Mode: navigate` with
 *  `Sec-Fetch-Dest: document` (a frame, an image or a fetch is not one); a client that sends
 *  neither header is a navigation when it asks for HTML. A secret's OAuth callback sends one to
 *  sign in too (secret-oauth-callback.ts). */
export function isDocumentNavigation(request: RequestShape): boolean {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return false;
  const mode = request.headers.get("sec-fetch-mode");
  const destination = request.headers.get("sec-fetch-dest");
  if (!mode && !destination) return (request.headers.get("accept") ?? "").includes("text/html");
  return mode === "navigate" && destination === "document";
}
