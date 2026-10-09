// cloudflare-access-sign-in.ts — SIGN IN WITH CLOUDFLARE ACCESS (`login.methods.cloudflareAccess`): an
// Access application guards ONE path, `/.auth/identity/cloudflare-access`, never the rest of the
// Worker (Access in front of everything breaks WebSockets, MCP, OAuth, the CLI and webhooks). Access
// mails the person a one-time PIN, then sends the request on with a token it signs
// (`Cf-Access-Jwt-Assertion`). This route checks that token itself and signs the browser in to the
// issuer as a password sign-in does. The application is made by hand (SELF-HOSTING.md, "Sign-in"),
// and the config names its team and audience: a deploy refuses the method without both
// (alchemy/stack.ts).
import { createRemoteJWKSet, jwtVerify } from "jose";
import { sameOriginPath } from "iterate/lib";
import { emailAllowed, EMAIL_NOT_ALLOWED_MESSAGE } from "./allowed-emails.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import { iterateConfigOf, platformAddressesOf } from "./iterate-config.ts";
import { startIssuerSession } from "./issuer-session.ts";
import { watchSignInStep } from "./sign-in-watch.ts";

export const CLOUDFLARE_ACCESS_SIGN_IN_PATH = "/.auth/identity/cloudflare-access";

/** Each team's published signing keys, which jose reads and refreshes, one set per isolate. */
const keysByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The person a token from the application vouches for, or why it is refused. jose checks the
 *  signature, the issuer (the team), the audience (this application) and the times. */
export async function verifyAccessToken(
  token: string,
  { teamDomain, aud }: { teamDomain: string; aud: string },
): Promise<{ email: string } | { error: string }> {
  let keys = keysByTeam.get(teamDomain);
  if (!keys)
    keysByTeam.set(
      teamDomain,
      (keys = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))),
    );
  const verified = await jwtVerify(token, keys, { issuer: teamDomain, audience: aud }).catch(
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );
  if ("error" in verified) return verified;
  const { type, common_name, email } = verified.payload;
  // a service token (a machine: `common_name`, no email) or an org-wide token is no person
  if (type !== "app" || common_name) return { error: "not a person's sign-in" };
  if (typeof email !== "string" || !email.trim()) return { error: "no email" };
  return { email: email.trim().toLowerCase() };
}

/** `GET /.auth/identity/cloudflare-access?next=`: the person Access let through, signed in to the
 *  issuer and sent on to `next` (same origin); null where `login.methods.cloudflareAccess` is off.
 *  A missing or refused token lands back on the sign-in page with why: it fails closed. */
export async function cloudflareAccessSignInResponse(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== CLOUDFLARE_ACCESS_SIGN_IN_PATH || request.method !== "GET") return null;
  const { login } = iterateConfigOf(env);
  const application = login.methods.cloudflareAccess;
  if (!application) return null;
  const { platformOrigin } = platformAddressesOf(env, request);
  const next = sameOriginPath(url.searchParams.get("next") || "/login", platformOrigin);
  const refused = (error: string) =>
    new Response(null, {
      status: 303,
      headers: {
        location: `/login?${new URLSearchParams({ next, error })}`,
        "cache-control": "no-store",
      },
    });
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    console.warn({ event: "cloudflare-access-sign-in.no-token" });
    return refused("Cloudflare Access did not sign this request in. Try again.");
  }
  const verified = await verifyAccessToken(token, application);
  if ("error" in verified) {
    console.warn({ event: "cloudflare-access-sign-in.refused", reason: verified.error });
    return refused("Cloudflare Access's sign-in could not be checked. Try again.");
  }
  if (!emailAllowed(login, verified.email)) return refused(EMAIL_NOT_ALLOWED_MESSAGE);
  const user = await watchSignInStep(
    "ensure-user",
    new ControlPlane(env).ensureUser(verified.email),
  );
  const session = await startIssuerSession(env, request, user, next);
  if ("error" in session) return refused(session.error);
  console.info({ event: "cloudflare-access-sign-in.signed-in", email: verified.email });
  const headers = new Headers({
    location: session.location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", session.setCookie);
  return new Response(null, { status: 302, headers });
}
