// local-sign-in.ts — LOCAL DEV'S ONE CLICK: `pnpm getin` (scripts/getin.ts) opens
// `/.auth/local-sign-in?email=<a test person>&next=<a URL on the laptop>`, which signs the browser
// in to the issuer as that person, as the password would, and sends it on. The local Dash's
// consent page then asks once, as after any sign-in.
//
// A laptop's platform alone: `urls.os` a loopback origin, with `login.testEmailDomain` set, which
// iterate-config.ts refuses anywhere but a preview, a laptop or a test. A preview and prd (https) and a
// self-host (a blank `urls.os`, so no test email domain) have no such route; a PR's preview has its
// own, test-link.ts. The laptop's password is `dev`, in this repository, so the route signs in no
// one a form post could not. What it adds is a sign-in by GET, so it answers only a navigation the
// person started: the address bar, `open` or `xdg-open`, a Playwright `goto` (`Sec-Fetch-Site:
// none`), or a client that is no browser. A web page's navigation is refused: it would switch the
// laptop's session to another test person.
import { isLocalOrigin } from "iterate/lib";
import { emailAllowed } from "./allowed-emails.ts";
import { iterateConfigOf, platformAddressesOf } from "./iterate-config.ts";
import type { Env } from "./env.ts";
import { linkSignInResponse, plainRefusal } from "./issuer-session.ts";

/** `GET /.auth/local-sign-in?email=&next=` (the URL scripts/getin.ts opens) on a laptop's
 *  platform, else null: worker.ts answers as for any path nobody serves. `next` is any URL on the
 *  laptop, the local Dash's included; anything else lands on the issuer's `/login`, which says who
 *  is signed in. */
export async function localSignInResponse(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/.auth/local-sign-in" || request.method !== "GET") return null;
  const { login } = iterateConfigOf(env);
  const { platformOrigin } = platformAddressesOf(env, request);
  // The request's own origin too, not only worker.ts's 421 before this route: moved above that
  // check, the route would still answer on a loopback origin alone.
  if (!login.testEmailDomain || !isLocalOrigin(platformOrigin) || !isLocalOrigin(url.origin))
    return null;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "none")
    return plainRefusal("Open this link yourself: a web page cannot sign you in here.");
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const [local, domain] = email.split("@");
  if (!local || domain !== login.testEmailDomain || !emailAllowed(login, email))
    return plainRefusal(
      `Only a test person, an address under ${login.testEmailDomain}, signs in here.`,
    );

  const asked = url.searchParams.get("next") || "/login";
  // the whole URL, not its origin: an opaque one's (`javascript:`) is "null", and a `blob:` URL's
  // is the page that made it
  const next = URL.canParse(asked, platformOrigin) ? new URL(asked, platformOrigin).href : null;
  return linkSignInResponse(
    env,
    request,
    email,
    next && isLocalOrigin(next) ? next : `${platformOrigin}/login`,
  );
}
