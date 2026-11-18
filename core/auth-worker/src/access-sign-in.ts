// access-sign-in.ts — CLOUDFLARE ACCESS PROVES AN OWNER'S ADDRESS. The stack puts one Access
// application on this one path of the control plane (core/alchemy/src/stack.ts), whose policy
// names the mind's owners alone. Cloudflare asks a visitor there for an address, mails a
// six-digit code from its own domain and, after the code, sends the request on with a token that
// it signed: the header `cf-access-jwt-assertion`
// (https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
//
//   GET /sign-in/access   the token names an owner: the one session that may add the first
//                         passkey (./enrolment.ts), then that page
//
// THE SIGNATURE IS THE GUARANTEE, NOT THE EDGE: the Worker checks the token itself, against the
// keys that the account's team publishes, so a request that reached it some other way proves
// nothing. The header counts on this path alone. It is the one proof of an address that the mind
// takes for an owner, and ./enrolment.ts decides what it opens: nothing for an owner who has, or
// had, a passkey. Access is for owners only: an added member gets in by an owner's link, and an
// app's own people by the mind's own mailed code (./email-sign-in.ts), so none of them takes a
// seat of the account's team.
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";
import { enrolmentCookie, FIRST_PASSKEY_PATH } from "./enrolment.ts";
import { configOf, type Env, homeOf } from "./env.ts";
import { honouredNext } from "./key-rules.ts";
import { errorPage } from "./pages.ts";
import { signInHref } from "./sign-in.ts";

/** What the Worker reads of a token's claims, beyond those that jose checks. `type` is `app` for
 *  a token of an application; a person's sign-in names an `email`, a service token's none. */
const AccessClaims = z.object({ type: z.literal("app"), email: z.email().toLowerCase() });

export async function accessSignInResponse(env: Env, request: Request) {
  const url = new URL(request.url);
  if (url.pathname !== "/sign-in/access" || request.method !== "GET") return null;
  const config = configOf(env);
  const mind = config.controlPlaneHostname;
  const next = honouredNext(url.searchParams.get("next"), config) || homeOf(env);
  const refusal = (outcome: string, words: string) => {
    console.info({ event: "auth.cloudflare-access-proof", outcome });
    return errorPage(words, 403, undefined, [{ href: signInHref(next), label: "Sign in" }]);
  };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token)
    return refusal(
      "no token",
      "Cloudflare Access sent no proof of an email address with this request, so it signs nobody in. Sign in with your passkey.",
    );
  const team = `https://${config.cloudflareAccessTeamDomain}`;
  // jose checks the signature, and `exp` and `nbf`. What it refuses is a token's fault, or the
  // team's keys that could not be read: its words go to the log.
  const claims = await jwtVerify(token, teamKeysOf(team), {
    algorithms: ["RS256"],
    issuer: team,
    audience: config.cloudflareAccessAudienceTag,
    requiredClaims: ["exp"],
  }).then(
    ({ payload }) => AccessClaims.safeParse(payload),
    (error: unknown) => (error instanceof errors.JOSEError ? error : Promise.reject(error)),
  );
  if (claims instanceof errors.JWTExpired)
    return refusal("expired", "Cloudflare's proof of your email address is over. Sign in again.");
  if (claims instanceof errors.JOSEError || !claims.success)
    return refusal(
      claims instanceof errors.JOSEError ? claims.message : "no token of a person's sign-in",
      `This is no proof of an email address that Cloudflare Access made for ${mind}. Sign in again.`,
    );
  const opened = await enrolmentCookie(env, request, claims.data.email, "cloudflare-access");
  // an address that is no owner's, or an owner who has or had a passkey: the page says which
  if ("refused" in opened) return refusal("no owner with no passkey yet", opened.refused);
  console.info({ event: "auth.cloudflare-access-proof", outcome: "proven" });
  return opened.facts.on(
    new Response(null, {
      status: 303,
      headers: {
        location: `${FIRST_PASSKEY_PATH}?${new URLSearchParams({ next })}`,
        "set-cookie": opened.setCookie,
        "cache-control": "no-store",
      },
    }),
  );
}

// One reader of the team's keys for an isolate. jose keeps the keys for ten minutes, and reads
// them again sooner when a token names a key that is not among them, at most once in 30 seconds.
const teamKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function teamKeysOf(team: string) {
  const known = teamKeys.get(team) || createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
  teamKeys.set(team, known);
  return known;
}
