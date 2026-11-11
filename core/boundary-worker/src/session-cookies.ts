import { cookieValueOf } from "iterate/lib";

export const HOST_SESSION_COOKIE = "__Host-iterate-session";
export const FLOW_COOKIE = "__Host-iterate-sign-in";
/** Set by a sign-out on this host, until the next sign-in here: that sign-in asks the issuer for
 *  its account chooser, so that a person who signed out can come back as someone else. */
export const SIGNED_OUT_COOKIE = "__Host-iterate-signed-out";

const isSessionCookie = (name: string) =>
  name === HOST_SESSION_COOKIE || name === FLOW_COOKIE || name === SIGNED_OUT_COOKIE;

export const sessionTokenOf = (request: Request) =>
  cookieValueOf(request.headers.get("cookie"), HOST_SESSION_COOKIE);

export function flowCookieOf(request: Request): unknown {
  const raw = cookieValueOf(request.headers.get("cookie"), FLOW_COOKIE);
  try {
    return raw ? JSON.parse(decodeURIComponent(raw)) : null;
  } catch {
    return null;
  }
}

export function appCookiesOf(cookieHeader: string | null): string | null {
  const kept = (cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !isSessionCookie(part.slice(0, part.indexOf("=")).trim()));
  return kept.length ? kept.join("; ") : null;
}

export const setsSessionCookie = (setCookie: string) =>
  isSessionCookie(setCookie.slice(0, setCookie.indexOf("=")).trim());

// `SameSite=Lax`: the issuer's redirect back is a top-level navigation from another host, and must
// carry the flow's cookie.
export const cookie = (name: string, value: string, maxAgeSeconds: number) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
