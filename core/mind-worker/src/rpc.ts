// rpc.ts — THE MIND AS THE BOUNDARY CALLS IT: the `Mind` entrypoint, which is `MindTarget`
// (iterate/workers). The boundary alone holds a binding to it. A mind that runs elsewhere (a home
// lab) answers the same four calls over its socket.
import { WorkerEntrypoint } from "cloudflare:workers";
import { contextAt, implicitRootsAt, sessionContext } from "core-itx";
import { requestWithOwnedBody } from "core-itx/request-body";
import { memberPrincipalOf } from "iterate/principal";
import type { MindTarget } from "iterate/workers";
import { runApprovedAct } from "./approved-acts.ts";
import type { Env } from "./env.ts";
import { mindResponse } from "./http.ts";
import {
  EMAIL_PATH,
  emailForwardClaim,
  emailForwardRequest,
  receiveEmail,
} from "./integrations/email.ts";
import { LenderRoot } from "./lender-root.ts";
import { appendAsPlatform } from "./platform-append.ts";

export class Mind extends WorkerEntrypoint<Env> implements MindTarget {
  // The body goes on to the config's Worker, or a context, which may answer without reading it:
  // this invocation reads it itself (core-itx/request-body).
  fetch(request: Parameters<MindTarget["fetch"]>[0]) {
    return mindResponse(requestWithOwnedBody(request, "mind"), this.env, this.ctx);
  }

  /** THE MIND FOR ONE SESSION OF THE CONTROL PLANE'S API. The boundary ended the session and
   *  learned who it is (iterate/workers `ApiCaller`); only the boundary reaches this entrypoint,
   *  so `who` is trusted as it stands. This invocation lives for as long as the boundary holds
   *  the answer, and what the session lent ends with it (core-itx `sessionContext`). */
  api(who: Parameters<MindTarget["api"]>[0]) {
    const waitUntil = (promise: Promise<unknown>) => this.ctx.waitUntil(promise);
    if ("principal" in who)
      return sessionContext(waitUntil, { ...who, principal: memberPrincipalOf(who.principal) });
    // A key is no principal. Its lend is its own act in the log, through its key, and the root
    // below is all that it reaches.
    const { lender } = who;
    return new LenderRoot(
      sessionContext(waitUntil, { principal: { actor: lender.actor }, grant: lender.key }),
      lender,
      implicitRootsAt("/"),
    );
  }

  /** Only the boundary reaches this entrypoint, so what it appends is the platform's, which the
   *  kernel refuses from any other caller. A signed statement is its signer's: only the auth
   *  Worker's answer names one, and each is appended under its own signer. */
  async append(...[path, events, fromAuth]: Parameters<MindTarget["append"]>) {
    const signed = fromAuth ? events.filter((event) => event.source?.signer) : [];
    const own = events.filter((event) => !signed.includes(event));
    if (own.length) await appendAsPlatform(path, own);
    for (const event of signed) await appendAsPlatform(path, [event], event.source?.signer);
  }

  async receiveEmail(mail: Parameters<MindTarget["receiveEmail"]>[0]) {
    return await receiveEmail(this.env.FILES, contextAt(EMAIL_PATH), mail);
  }

  async emailForwardRequest(wait: Parameters<MindTarget["emailForwardRequest"]>[0]) {
    return await emailForwardRequest(contextAt(EMAIL_PATH), wait);
  }

  async emailForwardClaim(claim: Parameters<MindTarget["emailForwardClaim"]>[0]) {
    return await emailForwardClaim(contextAt(EMAIL_PATH), claim);
  }

  async runAct(held: Parameters<MindTarget["runAct"]>[0]) {
    await runApprovedAct(
      { files: this.env.FILES, egress: this.env.DOOR, contextAt, appendAsPlatform },
      held,
    );
  }
}
