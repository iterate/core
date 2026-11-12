// rpc.ts — THE MIND AS THE BOUNDARY CALLS IT: the `Mind` entrypoint, which is `MindTarget`
// (iterate/workers). The boundary alone holds a binding to it. A mind that runs elsewhere (a home
// lab) answers the same four calls over its socket.
import { WorkerEntrypoint } from "cloudflare:workers";
import { contextAt } from "core-itx";
import type { MindTarget } from "iterate/workers";
import { runApprovedAct } from "./approved-acts.ts";
import type { Env } from "./env.ts";
import { mindResponse } from "./http.ts";
import { EMAIL_PATH, receiveEmail } from "./integrations/email.ts";
import { appendAsPlatform } from "./platform-append.ts";

export class Mind extends WorkerEntrypoint<Env> implements MindTarget {
  fetch(request: Parameters<MindTarget["fetch"]>[0]) {
    return mindResponse(request, this.env, this.ctx);
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
    await receiveEmail(this.env.FILES, contextAt(EMAIL_PATH), mail);
  }

  async runAct(held: Parameters<MindTarget["runAct"]>[0]) {
    await runApprovedAct(
      { files: this.env.FILES, egress: this.env.DOOR, contextAt, appendAsPlatform },
      held,
    );
  }
}
