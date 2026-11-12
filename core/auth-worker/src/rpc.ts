// rpc.ts — AUTH AS THE STACK'S OTHER WORKERS CALL IT: the `Auth` entrypoint, which is `AuthService`
// (iterate/workers). The boundary sends it the requests for the platform's host (./http.ts) and
// asks it who a token or a cookie is.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { AuthService } from "iterate/workers";
import { isBlocked } from "./blocked.ts";
import { sessionOf } from "./cookies.ts";
import { type Env, issuerOf } from "./env.ts";
import { authResponse } from "./http.ts";
import { verifiedStatement } from "./keys.ts";
import { isMember, standingOf } from "./members.ts";
import { hostClientOf } from "./oauth.ts";
import { signedByStack } from "./stack-key.ts";
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
    const session = await sessionOf(
      this.env,
      new Request(issuerOf(this.env), { headers: { cookie } }),
    );
    if (!session) return null;
    const member = (await standingOf(this.env, session)) === "member";
    if (!member && (await isBlocked(this.env, session.email))) return null;
    return {
      userId: session.userId,
      email: session.email,
      member,
    };
  }

  // a key's `paths` stay here: only the intake reads them
  async verify(envelope: Parameters<AuthService["verify"]>[0]) {
    const verified = await verifiedStatement(this.env, envelope);
    return "refused" in verified
      ? verified
      : { signer: verified.signer, statement: verified.statement };
  }

  // only a Worker of the stack reaches this, over a binding
  async sign(input: Parameters<AuthService["sign"]>[0]) {
    return signedByStack(this.env, input);
  }
}
