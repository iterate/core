// test-link.ts — THE ONE-CLICK SIGN-IN OF A PR'S DEPLOYMENT: a link that signs the browser in to the
// issuer as the deployment's one test person (`login.testLink`) and sends it on, with no password
// and no Allow page (consent.ts `#testLinkApproval`). Pure, so scripts/os/preview.ts mints with the
// very code the worker checks with; test-link-sign-in.ts is the route.
//
// Whoever holds the link is that person, and nothing records who they are. What bounds it:
//   • The link exists only on a preview, and names nobody: iterate-config.ts refuses `login.testLink`
//     anywhere else, and refuses a person who is an admin or outside `login.testEmailDomain`. prd and
//     a self-host have no such route, and no token signs in anyone but the config's person.
//   • The token is the deployment's, an HMAC of its platform origin. Previews share one key, so the
//     origin is what makes a token good on its own deployment alone. It has no expiry of its own:
//     it lives as long as the deployment does.
//   • `next` is outside the token, so a person can aim a link at any page of the deployment's apps.
//     `redeemTestLink` keeps it on the platform's host and its siblings: never an open redirect.

import { secretsEqual, sha256Hex, signClaims } from "./caller.ts";
import { isSiblingOfPlatform } from "./iterate-config.ts";

/** Where the worker redeems a link, beside `/version` on the platform origin. */
export const TEST_LINK_PATH = "/.auth/test-link";

/** The token of the deployment at `platformOrigin` (`?t=` on `TEST_LINK_PATH`). `key` is its
 *  `secretsEncryption.key`, under a label of its own, as iterate-config.ts `sessionSigningSecretOf`
 *  derives that secret under another. */
export async function testLinkToken(platformOrigin: string, key: string) {
  return signClaims({ aud: platformOrigin }, await sha256Hex(`iterate-test-link:${key}`));
}

/** What `GET /.auth/test-link?t=&next=` decides before any effect: where the browser goes, or why
 *  the link is refused. With no `next` it goes to the issuer's `/login`, which says who is signed
 *  in. */
export async function redeemTestLink(input: {
  token: string | null;
  next: string | null;
  platformOrigin: string;
  key: string;
}): Promise<{ next: string } | { refused: string }> {
  const { platformOrigin } = input;
  const token = await testLinkToken(platformOrigin, input.key);
  if (!(await secretsEqual(input.token || "", token)))
    return { refused: "This sign-in link is not for this deployment." };
  const asked = input.next || "/login";
  const next = URL.canParse(asked, platformOrigin) ? new URL(asked, platformOrigin) : null;
  if (!next || !isSiblingOfPlatform(next, platformOrigin))
    return { refused: "This sign-in link leads somewhere this deployment does not send people." };
  return { next: next.href };
}
