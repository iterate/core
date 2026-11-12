// http.ts — THE SECRETS WORKER'S ANSWER TO A REQUEST: the pages and endpoints of the vault that a
// person's browser reaches through the boundary (a secret's OAuth start and callback, the page that
// collects a secret's value, the approvals pages).
import { SECRET_OAUTH_CALLBACK_PATH, SECRET_PATH } from "iterate/secret-placeholder";
import { INDEX } from "./approvals-index.ts";
import { isApprovalsPath, secretApprovals } from "./approvals-page.ts";
import type { Env } from "./env.ts";
import { actsGate, secretObject } from "./objects.ts";
import { SECRET_COLLECT_PATH, secretCollect } from "./secret-collect.ts";
import { secretOAuthCallback } from "./secret-oauth-callback.ts";
import { SECRET_OAUTH_START_PATH, secretOAuthStart } from "./secret-oauth-start.ts";

export async function secretsResponse(request: Request, env: Env) {
  const { pathname } = new URL(request.url);
  if (pathname === SECRET_OAUTH_START_PATH)
    return secretOAuthStart(request, async (path, nonce) =>
      SECRET_PATH.test(path) ? secretObject(env, path).oauthStartTarget(path, { nonce }) : null,
    );
  if (pathname === SECRET_OAUTH_CALLBACK_PATH)
    return secretOAuthCallback(
      request,
      (path, input) => secretObject(env, path).completeOAuth(path, input),
      async (path, nonce) =>
        (await secretObject(env, path).oauthStartTarget(path, { nonce }))?.anyoneWithLink === true,
    );
  if (pathname === SECRET_COLLECT_PATH)
    return secretCollect(request, (path) => secretObject(env, path));
  if (isApprovalsPath(pathname))
    return secretApprovals(request, {
      mind: env.DOMAIN,
      index: env.APPROVALS.getByName(INDEX),
      secretOf: (path) => secretObject(env, path),
      gate: actsGate(env),
    });
  if (pathname === "/secrets" || pathname === "/secrets/")
    return new Response(`secrets: the vault of ${env.DOMAIN}`);
  return new Response("Not found", { status: 404 });
}
