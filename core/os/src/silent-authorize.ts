// silent-authorize.ts — AN AUTHORIZATION WITH `prompt=none` (OpenID Connect Core 1.0, 3.1.2.1): the
// client asks to be answered with no page at all. The issuer answers it at the edge, before the
// consent page's route: a browser with no issuer session goes back to the client at once with
// `error=login_required`, one whose request the issuer answers without a page (consent.ts
// `describe`'s redirect: an identity already confirmed, a first-party app asking who the person
// is, a deployment's issuer's own app) goes on as it would, and one that would need the person goes
// back with `interaction_required`. Each carries the request's `state` and `iss`. An app's gate
// asks this way before its connect page (iterate/app-server `/.auth/connect`). A request that does
// not validate is left to the page, which says why.
import { issuerSignIn } from "./consent-page.server.ts";
import { ConsentRpcTarget } from "./consent.ts";
import type { Env } from "./env.ts";
import { platformAddressesOf } from "./iterate-config.ts";
import { parseAuthorization } from "./oauth.ts";

export async function silentAuthorizeResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/oauth2/auth" || request.method !== "GET") return null;
  if (url.searchParams.get("prompt") !== "none") return null;
  const authorization = await parseAuthorization(env, request).catch(() => null);
  if (!authorization) return null;
  const back = (error: "login_required" | "interaction_required") => {
    const location = new URL(authorization.redirectUri);
    location.searchParams.set("error", error);
    if (authorization.state) location.searchParams.set("state", authorization.state);
    if (authorization.issuer) location.searchParams.set("iss", authorization.issuer);
    return location.href;
  };
  const signedIn = await issuerSignIn(request, env).catch(() => null);
  const view = signedIn
    ? await new ConsentRpcTarget(env, ctx, signedIn.grant, platformAddressesOf(env, request), {
        admittedThisRequest: true,
      }).describe(url.search)
    : null;
  const location =
    view?.kind === "redirect"
      ? view.location
      : back(signedIn ? "interaction_required" : "login_required");
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
