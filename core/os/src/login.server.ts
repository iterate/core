// The sign-in page's server side: what /login shows for this browser, and what its plain form posts
// do. The route (routes/login.tsx) renders the first and hands POST /login to the second.

import { errorCode, sameOriginPath, deploymentEnvironment } from "iterate/lib";
import { signInMethodsOf } from "./sign-in-methods.ts";
import { startIssuerSession } from "./issuer-session.ts";
import {
  clearLoginCookie,
  finishLoginCode,
  loginCodePending,
  signInWithPassword,
  startLoginCode,
} from "./password-and-code-sign-in.ts";
import { iterateConfigOf, platformAddressesOf } from "./iterate-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import type { UserRecord } from "./control-plane/catalog.ts";
import type { Env } from "./env.ts";
import { signInHref, switchAccountHref, type loginSearchOf } from "./login-search.ts";

/** The sign-in page's data for this request and its search: who is signed in, or which ways to
 *  sign in exist. */
export async function loginState(
  request: Request,
  env: Env,
  search: ReturnType<typeof loginSearchOf>,
) {
  const config = iterateConfigOf(env);
  const { platformOrigin } = platformAddressesOf(env, request);
  const next = sameOriginPath(search.next || "/login", platformOrigin);
  const session = await browserAuthorization(env, request);
  const state = {
    // which deployment this is (a PR's preview, local dev, production), which the page names
    environment: deploymentEnvironment(new URL(platformOrigin).hostname),
    next,
    signedInAs: session ? session.principal.email || session.principal.actor : null,
    // which way to sign in a link suggests (`provider_hint`): signed out, the page leads with it,
    // when this deployment offers it
    providerHint: search.provider_hint?.trim().toLowerCase() || null,
    // this page without the suggestion: every way to sign in
    everyWay: signInHref(next, null),
    switchAccount: switchAccountHref(next),
    codeSentTo: session ? null : await loginCodePending(env, request),
    error: search.error || null,
    // the email the refused post carried, so the page keeps what was typed
    email: search.email || "",
    passwordSelected: search.method === "password",
    // every way in, in the config's order (sign-in-methods.ts); the code form needs the mailbox
    // binding too
    methods: signInMethodsOf(config, { next, mail: Boolean(env.EMAIL) }),
    // where a signed-in person with nowhere else to go is sent (the landing page's pointer)
    dash: config.urls.dash || null,
  };
  // One way in, a link (the self-host's Cloudflare Access): the page sends a signed-out person
  // straight to it, but not back after a refusal (the page shows why) nor when a link asked for a
  // provider
  const [only] = state.methods;
  return {
    ...state,
    straightTo:
      state.methods.length === 1 &&
      only?.kind === "link" &&
      !state.signedInAs &&
      !state.error &&
      !state.providerHint
        ? only.href
        : null,
  };
}

/** The sign-in page's POSTs — plain forms, no script in the loop. `method` switches between the
 *  code and the password form, keeping the email typed; an `email` with a `password` signs in at
 *  once; an `email` alone starts the code sign-in; a `code` finishes it; `restart` drops a pending
 *  code for another email. What goes wrong comes back to the page as `?error=` (303), so the person
 *  reads it where they typed. */
export async function loginFormResponse(request: Request, env: Env): Promise<Response> {
  const form = await request.formData().catch(() => null);
  if (!form) return new Response("Expected a form", { status: 400 });
  const next = String(form.get("next") || "/login");
  const email = String(form.get("email") ?? "").trim();
  const method = form.get("method");
  /** Back to the page with what went wrong — and the email as typed, so it is still there. */
  const back = (error?: string, ...cookies: string[]) => {
    const query = new URLSearchParams({ next });
    if (error) query.set("error", error);
    if ((error || method) && email) query.set("email", email);
    if (method === "password" || (error && form.has("password"))) query.set("method", "password");
    const headers = new Headers({ location: `/login?${query}` });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  };
  /** The person is signed in: the issuer session's cookie, any pending code dropped, onward. Or the
   *  platform failed the sign-in's last step: back to the page to start again. */
  const signedIn = async (user: UserRecord) => {
    const session = await startIssuerSession(env, request, user, next);
    if ("error" in session) return back(session.error, clearLoginCookie);
    const headers = new Headers({ location: session.location });
    headers.append("set-cookie", session.setCookie);
    headers.append("set-cookie", clearLoginCookie);
    return new Response(null, { status: 302, headers });
  };
  try {
    if (method) return back();
    if (form.has("restart")) return back(undefined, clearLoginCookie);
    if (form.has("code")) {
      const finished = await finishLoginCode(env, request, String(form.get("code") ?? ""));
      if ("error" in finished)
        return finished.restart ? back(finished.error, clearLoginCookie) : back(finished.error);
      return signedIn(finished.user);
    }
    const client = request.headers.get("cf-connecting-ip");
    if (form.has("password")) {
      const attempt = await signInWithPassword(env, email, String(form.get("password")), client);
      if ("error" in attempt) return back(attempt.error);
      return signedIn(attempt.user);
    }
    const started = await startLoginCode(env, email, client);
    return back(undefined, started.setCookie);
  } catch (error) {
    const code = errorCode(error);
    if (code === "INVALID_INPUT")
      return back(error instanceof Error ? error.message : "Try again.");
    if (code !== "UNAUTHENTICATED") throw error;
    return new Response(error instanceof Error ? error.message : String(error), { status: 401 });
  }
}
