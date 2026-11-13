import { sameOriginPath } from "iterate/lib";
import { clearCloudflareSessionCookie, clearSessionCookie } from "./cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { errorPage } from "./pages.ts";
import { EMAIL_SIGN_IN_PATH } from "./email-sign-in.ts";

export const SIGN_IN_PATH = "/sign-in";

/** Where a person signs in: the mailed code's page when the mind mails codes, else the page with
 *  the passkey alone. Both have the passkey's button. */
export function signInHref(env: Env, next: string) {
  const { methods } = iterateConfigOf(env).login;
  return `${methods.email ? EMAIL_SIGN_IN_PATH : SIGN_IN_PATH}?${new URLSearchParams({ next })}`;
}

/** Ends this browser's session at the issuer. With `next` (a path of this origin), the sign-in
 *  follows and comes back there: that is how a person changes account, since a browser holds one
 *  session. An app's own session on a mind hostname is the boundary's, and is not ended here. */
export async function signOutResponse(env: Env, request: Request) {
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Sign out from this site's own page.", 403);
  const form = await request.formData().catch(() => null);
  const next = String(form?.get("next") || "");
  const headers = new Headers({
    location: next ? signInHref(env, sameOriginPath(next, issuerOf(env))) : "/",
    "cache-control": "no-store",
  });
  // a sign-in at Cloudflare is this browser's too
  headers.append("set-cookie", clearSessionCookie);
  headers.append("set-cookie", clearCloudflareSessionCookie);
  return new Response(null, { status: 303, headers });
}
