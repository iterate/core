// test-link-sign-in.ts — the route of a PR deployment's one-click link (test-link.ts says what the
// link is and what bounds it). It answers a navigation from any site, where local-sign-in.ts answers
// only one the person started: a person opens this link from a page, a PR body.
import { iterateConfigOf, platformAddressesOf } from "./iterate-config.ts";
import type { Env } from "./env.ts";
import { linkSignInResponse, plainRefusal } from "./issuer-session.ts";
import { redeemTestLink, TEST_LINK_PATH } from "./test-link.ts";

/** `GET /.auth/test-link?t=&next=` where `login.testLink` names a person, else null: worker.ts
 *  answers as for any path nobody serves. */
export async function testLinkResponse(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TEST_LINK_PATH || request.method !== "GET") return null;
  const config = iterateConfigOf(env);
  const person = config.login.testLink?.email;
  if (!person) return null;
  const decision = await redeemTestLink({
    token: url.searchParams.get("t"),
    next: url.searchParams.get("next"),
    platformOrigin: platformAddressesOf(env, request).platformOrigin,
    key: config.secretsEncryption.key.exposeSecret(),
  });
  if ("refused" in decision) {
    console.warn({ event: "test-link.refused", reason: decision.refused });
    return plainRefusal(decision.refused);
  }
  console.info({ event: "test-link.signed-in", email: person });
  return linkSignInResponse(env, request, person, decision.next);
}
