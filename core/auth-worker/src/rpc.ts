// rpc.ts — AUTH AS THE STACK'S OTHER WORKERS CALL IT: the `Auth` entrypoint, which is `AuthService`
// (iterate/workers). The boundary sends it the requests for the control-plane hostname (./http.ts) and
// asks it who a token or a cookie is.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { AuthService } from "iterate/workers";
import { isBlocked } from "./blocked.ts";
import { personSessionOf } from "./cookies.ts";
import { type Env, issuerOf } from "./env.ts";
import { authResponse } from "./http.ts";
import { identityFactsDelivered, identityFactsToDeliver, identityLogResponse } from "./identity.ts";
import { verifiedStatement } from "./keys.ts";
import { isMember, isMemberSession } from "./members.ts";
import { mindOfSignedRequest } from "./mind-fetch.ts";
import { hostClientOf } from "./oauth.ts";
import { signedByStack, signedDeliveryByStack } from "./stack-key.ts";
import { proposeStatement } from "./statement-drafts.ts";
import { whoIs } from "./who-is.ts";

export class Auth extends WorkerEntrypoint<Env> implements AuthService {
  fetch(asked: Parameters<AuthService["fetch"]>[0]) {
    return authResponse(asked, this.env, this.ctx);
  }

  whoIs(...[token, resource]: Parameters<AuthService["whoIs"]>) {
    return whoIs(this.env, token, resource);
  }

  async hostClient(host: Parameters<AuthService["hostClient"]>[0]) {
    return hostClientOf(this.env, host);
  }

  async isMember(email: Parameters<AuthService["isMember"]>[0]) {
    return isMember(this.env, email);
  }

  async browserSession(cookie: Parameters<AuthService["browserSession"]>[0]) {
    if (!cookie) return null;
    // anyone signed in: a person who is no member too, and `member` says which
    const session = await personSessionOf(
      this.env,
      new Request(issuerOf(this.env), { headers: { cookie } }),
    );
    if (!session) return null;
    const member = await isMemberSession(this.env, session);
    if (!member && (await isBlocked(this.env, session.email))) return null;
    return {
      userId: session.userId,
      email: session.email,
      member,
      method: session.method,
      expiresAt: Math.floor(session.expiresAt / 1000),
    };
  }

  async identityLog(...[hostname, after]: Parameters<AuthService["identityLog"]>) {
    return identityLogResponse(this.env, { hostname, after });
  }

  async identityFactsToDeliver() {
    return identityFactsToDeliver(this.env);
  }

  async identityFactsDelivered(ids: Parameters<AuthService["identityFactsDelivered"]>[0]) {
    return identityFactsDelivered(this.env, ids);
  }

  // a key's `paths` stay here: only the intake reads them
  async verify(envelope: Parameters<AuthService["verify"]>[0]) {
    const verified = await verifiedStatement(this.env, envelope);
    if ("refused" in verified) return verified;
    return { signer: verified.signer, statement: verified.statement };
  }

  // only a Worker of the stack reaches this, over a binding
  async sign(input: Parameters<AuthService["sign"]>[0]) {
    return signedByStack(this.env, input);
  }

  async mindOfSignedRequest(input: Parameters<AuthService["mindOfSignedRequest"]>[0]) {
    return mindOfSignedRequest(this.env, input);
  }

  async proposeStatement(input: Parameters<AuthService["proposeStatement"]>[0]) {
    return proposeStatement(this.env, input);
  }
}

/** WHAT A FORWARDING WORKER OF THE SAME ACCOUNT MAY SIGN AS THIS MIND, over a binding to this
 *  entrypoint alone: a provider's delivery for another mind (./stack-key.ts `signedDeliveryByStack`). The bound is here and not
 *  in the caller: this entrypoint has no other method. */
export class Deliveries extends WorkerEntrypoint<Env> {
  async sign(input: Parameters<typeof signedDeliveryByStack>[1]) {
    return signedDeliveryByStack(this.env, input);
  }
}
