import { clearSessionCookie } from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { errorPage } from "./pages.ts";
import { EMAIL_SIGN_IN_PATH } from "./email-sign-in.ts";

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_OUT_PATH = "/sign-out";

/** Where a person signs in: the mailed code's page when the mind mails codes, else the page with
 *  the passkey alone. Both have the passkey's button. */
export function signInHref(env: Env, next: string) {
  const { methods } = iterateConfigOf(env).login;
  return `${methods.email ? EMAIL_SIGN_IN_PATH : SIGN_IN_PATH}?${new URLSearchParams({ next })}`;
}

export function signOutResponse(env: Env, request: Request) {
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Sign out from this site's own page.", 403);
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": clearSessionCookie, "cache-control": "no-store" },
  });
}
