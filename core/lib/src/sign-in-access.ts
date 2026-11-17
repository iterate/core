// sign-in-access.ts — THE ACCESS A SIGN-IN KEEPS, on its way from the auth Worker to the secrets
// Worker. A sign-in at a provider ends with the provider's tokens. A stack whose config says so
// keeps them as a secret of the mind, so that the mind's own code can act for the person at the
// provider (core/auth-worker/src/cloudflare-sign-in.ts says when, and what the tokens may do).
//
// The auth Worker has no binding to the secrets Worker. Its answer names the secret in
// `SIGN_IN_ACCESS_HEADER`. The boundary binds both: it takes the header off the answer and sets
// the secret before the browser gets the answer (core/boundary-worker/src/http.ts). The boundary
// reads the header on the auth Worker's answers alone, and no browser sees it.
import { z } from "zod";
import { reportIssue } from "./lib.ts";
import { SECRET_PATH } from "./secret-placeholder.ts";

export const SIGN_IN_ACCESS_HEADER = "x-iterate-sign-in-access";

/** Where the mind keeps the Cloudflare access of the person `userId` (`user_…`): a request names
 *  it as `getSecret("/secrets/cloudflare-sign-in-<userId>", { field: "accessToken" })`. */
export const cloudflareSignInSecretOf = (userId: string) => `/secrets/cloudflare-sign-in-${userId}`;

/** A secret to set: its path, and the input of the secret's `set` (./api.ts `secrets.set`). */
export const SignInAccess = z.strictObject({
  path: z.string().regex(SECRET_PATH),
  material: z.record(z.string(), z.string()),
  urls: z.array(z.url()).min(1),
  /** How the secret's object gets a new access token (./api.ts `SecretRefresh`). Absent: the
   *  provider gave no refresh token, and the access ends with its token. */
  refresh: z
    .strictObject({
      kind: z.literal("oauth-refresh-token"),
      tokenEndpoint: z.url(),
      clientAuth: z.enum(["client_secret_basic", "client_secret_post", "none"]),
    })
    .optional(),
});
export type SignInAccess = z.infer<typeof SignInAccess>;

/** `response` with the access in its header: the auth Worker's answer to a sign-in that keeps it. */
export function withSignInAccess(response: Response, access: SignInAccess): Response {
  const headers = new Headers(response.headers);
  headers.set(SIGN_IN_ACCESS_HEADER, base64urlOf(JSON.stringify(access)));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The access an answer carries, and the answer without it. An answer with no such header comes
 *  back as it is. A header that does not read is reported and dropped: nothing is stored. */
export function takeSignInAccess(response: Response): {
  answer: Response;
  access: SignInAccess | null;
} {
  const header = response.headers.get(SIGN_IN_ACCESS_HEADER);
  if (!header) return { answer: response, access: null };
  const headers = new Headers(response.headers);
  headers.delete(SIGN_IN_ACCESS_HEADER);
  const answer = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  try {
    return { answer, access: SignInAccess.parse(JSON.parse(textOf(header))) };
  } catch (error) {
    reportIssue("sign-in-access.unreadable", error);
    return { answer, access: null };
  }
}

function base64urlOf(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function textOf(base64url: string): string {
  const binary = atob(base64url.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
