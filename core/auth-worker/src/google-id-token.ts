// google-id-token.ts — WHAT GOOGLE SAYS OF WHO SIGNED IN (./google-sign-in.ts): the check of an
// id_token, with no binding of the Worker's, so that a test runs it against a key set of its own.
import { type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const GoogleClaims = z.object({
  nonce: z.string(),
  email: z.string().min(3),
  email_verified: z.literal(true),
  /** A Google Workspace account's domain: Google vouches for every address of it. */
  hd: z.string().optional(),
});

/** THE ADDRESS GOOGLE VOUCHES FOR in `idToken`, or why there is none. The token must be Google's
 *  own (its signature, its issuer), made for the Cloud's client and for this browser's nonce. The
 *  address must be one Google itself is the authority for: a gmail.com address, or an address of
 *  the Workspace domain the account belongs to (`hd`). For any other address `email_verified` only
 *  says that Google once mailed it. `reason` is for the log, `refused` for the person. */
export async function googleAddressOf(
  idToken: string,
  expected: { keys: JWTVerifyGetKey; clientId: string; nonce: string },
): Promise<{ email: string } | { refused: string; reason: string }> {
  const refused = (reason: string, words = "Google's answer could not be checked. Try again.") => ({
    refused: words,
    reason,
  });
  let claims: unknown;
  try {
    ({ payload: claims } = await jwtVerify(idToken, expected.keys, {
      issuer: GOOGLE_ISSUERS,
      audience: expected.clientId,
      algorithms: ["RS256"],
    }));
  } catch (error) {
    return refused(`the id_token is not Google's for this client: ${String(error)}`);
  }
  const google = GoogleClaims.safeParse(claims);
  if (!google.success) return refused("the id_token names no verified address");
  if (google.data.nonce !== expected.nonce) return refused("the id_token is for another sign-in");
  const email = google.data.email.trim().toLowerCase();
  const host = email.split("@")[1] || "";
  const vouched =
    host === "gmail.com" || host === "googlemail.com" || google.data.hd?.toLowerCase() === host;
  if (!vouched)
    return refused(
      "the address is neither gmail.com nor of the account's Workspace domain",
      `Google does not vouch for ${email}: it is not a Gmail address, and not an address of a Google Workspace domain. Sign in another way.`,
    );
  return { email };
}
