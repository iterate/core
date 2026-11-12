// rpc.ts — THE VAULT AS THE STACK'S OTHER WORKERS CALL IT: the `Secrets` entrypoint, which is
// `SecretsService` (iterate/workers), and `SecretUse`, which egress alone binds for a request that
// names a secret.
import { WorkerEntrypoint } from "cloudflare:workers";
import { releasedAnswer } from "iterate/lib";
import { SECRET_PATH, SECRET_USE_HEADER } from "iterate/secret-placeholder";
import type { SecretsService, SecretVerb, SecretVerbs } from "iterate/workers";
import { SET } from "./approvals-index.ts";
import type { Env } from "./env.ts";
import { secretsResponse } from "./http.ts";
import { actsGate, secretObject } from "./objects.ts";
import { listSetSecrets } from "./secret-list.ts";

export class Secrets extends WorkerEntrypoint<Env> implements SecretsService {
  fetch(request: Parameters<SecretsService["fetch"]>[0]) {
    return secretsResponse(request, this.env);
  }

  /* oxlint-disable iterate/mechanical-class-impl -- a generic method: `Parameters<>` of the contract would lose `V`, which ties each verb to its input and its answer */
  secret<V extends SecretVerb>(path: string, verb: V, input: SecretVerbs[V]["input"]) {
    // the object answers the verb's own answer; RPC's stub types cannot say which
    return secretObject(this.env, path).secret(path, verb, input) as Promise<
      SecretVerbs[V]["answer"]
    >;
  }
  /* oxlint-enable iterate/mechanical-class-impl */

  /** The secrets that are set, in one call (./secret-list.ts). `known` is the mind's own list of
   *  paths, used until the vault's set is complete. */
  async listSecrets(known: string[] = []) {
    return listSetSecrets(
      {
        list: this.env.APPROVALS.getByName(SET),
        secretOf: (path) => {
          const secret = secretObject(this.env, path);
          return {
            // copied and let go at once: a list asks many objects in one call of this Worker
            describe: (asked) => releasedAnswer(secret.secret(asked, "describe", undefined)),
            keepListed: (asked) => secret.keepListed(asked),
          };
        },
      },
      known,
    );
  }

  async act(input: Parameters<SecretsService["act"]>[0]) {
    return actsGate(this.env).act(input);
  }

  async approvedAct(digest: string) {
    return actsGate(this.env).approved(digest);
  }

  async actNotDone(digest: string) {
    return actsGate(this.env).notDone(digest);
  }

  // Only the mind's own code comes this way (the boundary's Door): never a member's session.
  async setActRules(input: Parameters<SecretsService["setActRules"]>[0]) {
    return actsGate(this.env).setRules({ rules: input.rules, by: { mind: input.from } });
  }

  async proposeActRule(input: Parameters<SecretsService["proposeActRule"]>[0]) {
    return actsGate(this.env).propose(input);
  }

  async actRules() {
    const { locked, rules } = await actsGate(this.env).state();
    return { locked, rules };
  }
}

// Only egress binds this entrypoint, so no caller's copy of `SECRET_USE_HEADER` reaches it.
export class SecretUse extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    const path = request.headers.get(SECRET_USE_HEADER) ?? "";
    if (!SECRET_PATH.test(path))
      return new Response(`itx.fetch: ${JSON.stringify(path)} names no secret\n`, { status: 403 });
    return this.env.SECRET.getByName(path).fetch(request);
  }
}
