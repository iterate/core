// http.ts — THE BOUNDARY'S REQUEST POLICY, once, for both builds: which Worker of the stack a
// request goes to, what is stamped on it, and what an answer may record in the mind's log. The
// two builds differ only in how the mind is reached (`MindTransport`): by a service binding
// (./transport/bound.ts), or through the session a mind at home dials (./transport/provided.ts).
import { runApprovedActs } from "iterate/acts";
import { recordFacts as recorded } from "iterate/facts";
import { platformRouteOf } from "iterate/mind-api";
import type { MindTarget } from "iterate/workers";
import type { DoorEnv } from "./env.ts";
import { mindHostResponse } from "./host-session.ts";
import { confinedAnswer, httpsRedirect, stampedRequest } from "./stamp.ts";

/** The mind, as the boundary reaches it. */
export type MindTransport = Pick<MindTarget, "fetch" | "append" | "runAct" | "receiveEmail">;

/** `provide`: what answers `/provide` in the build whose mind runs elsewhere. Absent, it is not
 *  found. */
export async function boundaryResponse(
  request: Request,
  env: DoorEnv,
  ctx: ExecutionContext,
  mind: MindTransport,
  provide?: (request: Request, domain: string) => Promise<Response>,
): Promise<Response> {
  const secure = httpsRedirect(request);
  if (secure) return secure;
  const domain = env.DOMAIN;
  const route = platformRouteOf(new URL(request.url), domain);
  if (route === "provide")
    return provide ? provide(request, domain) : new Response("Not found", { status: 404 });
  // `fromAuth`: only the auth Worker's answer names the signer of an event (the key it verified)
  const recordFacts = (response: Response, fromAuth = false) => {
    const { answer, recorded: appended } = recorded(response, (path, events) =>
      mind.append(path, events, fromAuth),
    );
    ctx.waitUntil(appended);
    return answer;
  };
  if (!route)
    return mindHostResponse(request, { auth: env.AUTH, domain, recordFacts }, (forwarded) =>
      mind.fetch(forwarded),
    );
  const { forwarded, answer } = await stampedRequest(request, { auth: env.AUTH, route, domain });
  if (answer) return answer;
  if (route === "auth") return recordFacts(await env.AUTH.fetch(forwarded), true);
  if (route === "secrets") {
    // an approval of an act whose caller stopped waiting: the mind does the act now
    const { answer: answered, ran } = runApprovedActs(
      await env.SECRETS.fetch(forwarded),
      async (digest) => {
        const held = await env.SECRETS.approvedAct(digest);
        if (held) await mind.runAct(held);
      },
    );
    ctx.waitUntil(ran);
    return recordFacts(answered);
  }
  return confinedAnswer(await mind.fetch(forwarded));
}
