import { WorkerEntrypoint } from "cloudflare:workers";
import {
  assertSecretPath,
  SECRET_OAUTH_CALLBACK_PATH,
  SECRET_PATH,
  SECRET_USE_HEADER,
} from "iterate/secret-placeholder";
import type { SecretsService, SecretVerb, SecretVerbs } from "iterate/workers";
import { ApprovalsIndex, INDEX } from "./approvals-index.ts";
import { isApprovalsPath, secretApprovals } from "./approvals-page.ts";
import type { Env } from "./env.ts";
import { SECRET_COLLECT_PATH, secretCollect } from "./secret-collect.ts";
import { secretOAuthCallback } from "./secret-oauth-callback.ts";
import { SECRET_OAUTH_START_PATH, secretOAuthStart } from "./secret-oauth-start.ts";
import { SecretDurableObject } from "./secret/durable-object.ts";
import { PinnedOutbound } from "./secret/exchange-jail.ts";

// A Durable Object binding names a class the main module exports, and `ctx.exports` mints the
// jail's egress only for an export.
export { ApprovalsIndex, PinnedOutbound, SecretDurableObject };

export class Secrets extends WorkerEntrypoint<Env> implements SecretsService {
  async fetch(request: Parameters<SecretsService["fetch"]>[0]) {
    const { pathname } = new URL(request.url);
    if (pathname === SECRET_OAUTH_START_PATH)
      return secretOAuthStart(request, async (path, nonce) =>
        SECRET_PATH.test(path) ? this.#secret(path).oauthStartTarget(path, { nonce }) : null,
      );
    if (pathname === SECRET_OAUTH_CALLBACK_PATH)
      return secretOAuthCallback(
        request,
        (path, input) => this.#secret(path).completeOAuth(path, input),
        async (path, nonce) =>
          (await this.#secret(path).oauthStartTarget(path, { nonce }))?.anyoneWithLink === true,
      );
    if (pathname === SECRET_COLLECT_PATH)
      return secretCollect(request, (path) => this.#secret(path));
    if (isApprovalsPath(pathname))
      return secretApprovals(request, {
        mind: this.env.DOMAIN,
        index: this.env.APPROVALS.getByName(INDEX),
        secretOf: (path) => this.#secret(path),
      });
    if (pathname === "/secrets" || pathname === "/secrets/")
      return new Response(`secrets: the vault of ${this.env.DOMAIN}`);
    return new Response("Not found", { status: 404 });
  }

  /* oxlint-disable iterate/mechanical-class-impl -- a generic method: `Parameters<>` of the contract would lose `V`, which ties each verb to its input and its answer */
  secret<V extends SecretVerb>(path: string, verb: V, input: SecretVerbs[V]["input"]) {
    // the object answers the verb's own answer; RPC's stub types cannot say which
    return this.#secret(path).secret(path, verb, input) as Promise<SecretVerbs[V]["answer"]>;
  }
  /* oxlint-enable iterate/mechanical-class-impl */

  #secret(path: string) {
    return this.env.SECRET.getByName(assertSecretPath(path));
  }
}

// Only egress binds this entrypoint, so no caller's copy of `SECRET_USE_HEADER` reaches it.
export class SecretUse extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    const path = request.headers.get(SECRET_USE_HEADER) ?? "";
    if (!SECRET_PATH.test(path))
      return new Response(`itx.fetch: ${JSON.stringify(path)} names no secret\n`, { status: 502 });
    return this.env.SECRET.getByName(path).fetch(request);
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
