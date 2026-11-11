import { isSameOriginBrowserRequest } from "iterate/lib";

export type ProjectHostCaller = "member" | "non-member" | "anonymous";

type RequestShape = Pick<Request, "method" | "url" | "headers">;

// The session cookie counts on a write or a WebSocket upgrade only from the host's own origin (an
// absent Origin passes); a browser never sends a bearer on its own, so one always counts.
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

// Only `Bearer realm="iterate"` is the platform's challenge. A member's 401 passes: a sign-in would
// bring the same principal back.
export function projectHostSignInAnswerOf(input: {
  answer: Pick<Response, "status" | "headers">;
  request: RequestShape;
  caller: ProjectHostCaller;
}): "sign-in" | "not-a-member" | Response | null {
  const { answer, request, caller } = input;
  if (answer.status !== 401 || caller === "member") return null;
  const challenge = iterateSignInChallengeOf(answer.headers.get("www-authenticate"));
  if (!challenge) return null;
  const identity = challenge.scope === "identity";
  if (identity && caller === "non-member") return null;
  if (isDocumentNavigation(request)) return caller === "non-member" ? "not-a-member" : "sign-in";
  // 403, not 401: a 401 would send an OAuth client to authorize again, for the same token.
  if (caller === "non-member")
    return new Response("This session cannot access this project\n", { status: 403 });
  return null;
}

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const AUTH_PARAM = new RegExp(
  `^(${TOKEN})[ \\t]*=[ \\t]*(${TOKEN}|"(?:[^"\\\\]|\\\\.)*")[ \\t]*(?:,|$)`,
);
const AUTH_SCHEME = new RegExp(`^(${TOKEN})(?:[ \\t]+[A-Za-z0-9._~+/-]+=*[ \\t]*(?=,|$))?`);

// RFC 9110 §11.6.1's challenge list. Past where a value stops parsing it holds no challenge of ours.
function iterateSignInChallengeOf(header: string | null): { scope: string } | null {
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
    const found = ours();
    const challenge = AUTH_SCHEME.exec(rest);
    if (found || !challenge) return found;
    scheme = challenge[1]!.toLowerCase();
    realm = false;
    scope = "";
    rest = rest.slice(challenge[0].length);
  }
}

function isDocumentNavigation(request: RequestShape): boolean {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return false;
  const mode = request.headers.get("sec-fetch-mode");
  const destination = request.headers.get("sec-fetch-dest");
  if (!mode && !destination) return (request.headers.get("accept") ?? "").includes("text/html");
  return mode === "navigate" && destination === "document";
}
