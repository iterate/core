import { cookieTrimmed, cookieValueOf } from "iterate/lib";

export const HOST_SESSION_COOKIE = "__Host-iterate-session";
export const FLOW_COOKIE = "__Host-iterate-sign-in";
/** Set by a sign-out on this host, until the next sign-in here: that sign-in asks the issuer for
 *  its account chooser, so that a person who signed out can come back as someone else. */
export const SIGNED_OUT_COOKIE = "__Host-iterate-signed-out";

/** The boundary's own cookie names. Each is a `__Host-` name, as every cookie the platform sets
 *  is (the test pins these): ./stamp.ts `cookiesNamingNoSecret` rests on that. */
export const PLATFORM_COOKIE_NAMES = [HOST_SESSION_COOKIE, FLOW_COOKIE, SIGNED_OUT_COOKIE] as const;

const isSessionCookie = (name: string) =>
  (PLATFORM_COOKIE_NAMES as readonly string[]).includes(name);

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
    .map(cookieTrimmed)
    .filter((part) => part && !isSessionCookie(cookieTrimmed(part.slice(0, part.indexOf("=")))));
  return kept.length ? kept.join("; ") : null;
}

export const setsSessionCookie = (setCookie: string) =>
  isSessionCookie(cookieTrimmed(setCookie.slice(0, setCookie.indexOf("="))));

// `SameSite=Lax`: the issuer's redirect back is a top-level navigation from another host, and must
// carry the flow's cookie.
export const cookie = (name: string, value: string, maxAgeSeconds: number) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
