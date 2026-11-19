import { AccountFacts } from "./account-facts.ts";
import {
  clearGuestCookie,
  clearMindCookie,
  clearSessionCookie,
  endThisSession,
} from "./cookies.ts";
import { configOf, type Env, issuerOf } from "./env.ts";
import { honouredNext } from "./key-rules.ts";
import { errorPage } from "./pages.ts";

export const SIGN_IN_PATH = "/sign-in";

/** On the sign-in link of a person who just signed out: the passkey's page waits for a press. */
export const AFTER_SIGN_OUT = "signed-out";

/** Where a person signs in (./http.ts): the page of the sign-in that `next` goes on to, which
 *  opens on the passkey or, for an app whose people sign in by mail first, on the mailed code. */
export const signInHref = (next: string) => `${SIGN_IN_PATH}?${new URLSearchParams({ next })}`;

/** Ends this browser's session at the issuer, of either kind (./enrolment.ts): its row, and its
 *  cookie. The sign-in follows, and waits for a press (`AFTER_SIGN_OUT`): a person who just signed
 *  out is not asked for a passkey. It comes back to `next` (an address of the mind's own; the
 *  start page with none): that is how a person changes account, since a browser holds one session. An app's own session on a mind hostname is
 *  the boundary's, and is not ended here. */
export async function signOutResponse(env: Env, request: Request) {
  if (request.headers.get("origin") !== issuerOf(env))
    return errorPage("Sign out from this site's own page.", 403);
  const form = await request.formData().catch(() => null);
  const next = honouredNext(String(form?.get("next") || ""), configOf(env)) || "/";
  const facts = new AccountFacts();
  await endThisSession(env, request, facts);
  const headers = new Headers({
    location: `${signInHref(next)}&${AFTER_SIGN_OUT}=1`,
    "set-cookie": clearSessionCookie,
    "cache-control": "no-store",
  });
  // the guest this browser was ends too (./guest-sign-in.ts)
  headers.append("set-cookie", clearGuestCookie);
  headers.append("set-cookie", clearMindCookie);
  return facts.on(new Response(null, { status: 303, headers }));
}
