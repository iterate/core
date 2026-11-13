import { isSameOriginBrowserRequest } from "iterate/lib";

export type MindHostCaller = "member" | "non-member" | "anonymous";

type RequestShape = Pick<Request, "method" | "url" | "headers">;

// The session cookie counts on a write or a WebSocket upgrade only from the host's own origin (an
// absent Origin passes); a browser never sends a bearer on its own, so one always counts.
export function mindHostCallerOf(input: {
  authorization: { via: "bearer" | "cookie"; reachesMind: boolean } | null;
  request: RequestShape;
}): MindHostCaller {
  const { authorization, request } = input;
  if (!authorization) return "anonymous";
  const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const isWrite = isWebSocketUpgrade || !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (authorization.via === "cookie" && isWrite && !isSameOriginBrowserRequest(request))
    return "anonymous";
  return authorization.reachesMind ? "member" : "non-member";
}

/** A sign-in on this host: by one of the ways the app takes, in its order (RFC 9470's
 *  `acr_values`), or by the mind's own sign-in when it names none. */
export type HostSignIn = { methods: string[] };

// Only `Bearer realm="iterate"` is the platform's challenge. A 401 for a session the app takes
// passes, a member's too: a sign-in would bring the same session back.
export function mindHostSignInAnswerOf(input: {
  answer: Pick<Response, "status" | "headers">;
  request: RequestShape;
  caller: MindHostCaller;
  /** How the caller signed in, when they did (./stamp.ts). */
  method?: string;
}): HostSignIn | "not-a-member" | Response | null {
  const { answer, request, caller } = input;
  if (answer.status !== 401) return null;
  const challenge = iterateSignInChallengeOf(answer.headers.get("www-authenticate"));
  if (!challenge) return null;
  const signIn = { methods: challenge.acrValues };
  // A STEP-UP (RFC 9470): the app takes none of the ways this session began by, so the person
  // signs in again, member or not, by a way it names. With no way named, the sign-in is the
  // mind's own, which changes only a session that began at Cloudflare.
  const methodRefused = challenge.acrValues.length
    ? !challenge.acrValues.includes(input.method || "")
    : challenge.error === "insufficient_user_authentication" && input.method === "cloudflare";
  if (caller !== "anonymous" && methodRefused) return isDocumentNavigation(request) ? signIn : null;
  if (caller === "member") return null;
  const identity = challenge.scope === "identity";
  if (identity && caller === "non-member") return null;
  if (isDocumentNavigation(request)) return caller === "non-member" ? "not-a-member" : signIn;
  // 403, not 401: a 401 would send an OAuth client to authorize again, for the same token.
  if (caller === "non-member")
    return new Response("This session cannot access this mind\n", { status: 403 });
  return null;
}

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const AUTH_PARAM = new RegExp(
  `^(${TOKEN})[ \\t]*=[ \\t]*(${TOKEN}|"(?:[^"\\\\]|\\\\.)*")[ \\t]*(?:,|$)`,
);
const AUTH_SCHEME = new RegExp(`^(${TOKEN})(?:[ \\t]+[A-Za-z0-9._~+/-]+=*[ \\t]*(?=,|$))?`);

type Challenge = { scope: string; error: string; acrValues: string[] };

// RFC 9110 §11.6.1's challenge list. Past where a value stops parsing it holds no challenge of ours.
function iterateSignInChallengeOf(header: string | null): Challenge | null {
  let rest = header || "";
  let scheme: string | null = null;
  let realm = false;
  let params = { scope: "", error: "", acrValues: "" };
  const ours = (): Challenge | null =>
    scheme === "bearer" && realm
      ? { ...params, acrValues: params.acrValues.split(" ").filter(Boolean) }
      : null;
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
      if (name === "scope") params.scope = value;
      if (name === "error") params.error = value;
      if (name === "acr_values") params.acrValues = value;
      rest = rest.slice(param[0].length);
      continue;
    }
    const found = ours();
    const challenge = AUTH_SCHEME.exec(rest);
    if (found || !challenge) return found;
    scheme = challenge[1]!.toLowerCase();
    realm = false;
    params = { scope: "", error: "", acrValues: "" };
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
