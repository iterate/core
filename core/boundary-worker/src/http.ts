// http.ts — THE BOUNDARY'S REQUEST POLICY, for every topology: which Worker of the stack a
// request goes to, what is stamped on it, and what an answer may record in the mind's log. It has
// ONE RULE (`isControlPlaneRequest`): a request on the mind's control-plane hostname is the control
// plane's, and a request on any other hostname goes to the mind, for its config worker. The
// topologies differ only in how the mind is reached (`MindTransport`, ./mind-transport.ts).
import { runApprovedActs } from "iterate/acts";
import { recordFacts as recorded, withFacts } from "iterate/facts";
import { controlPlaneRouteOf, MIND_PROVIDE_EXTERNAL_MIND_HEADER } from "iterate/mind-api";
import { isControlPlaneHostname, type MindConfig } from "iterate/mind-config";
import { MIND_IDENTITY_PATH } from "iterate/mind-identity-log";
import { ITERATE_CAUSE_HEADER, ITX_OWN_HEADER } from "iterate/lib";
import { withoutOutsidePlaceholders } from "iterate/secret-placeholder";
import type { MindTarget } from "iterate/workers";
import { boundaryConfigOf } from "./config.ts";
import { controlPlaneApiResponse, isWebSocketUpgrade } from "./control-plane-api.ts";
import type { DoorEnv } from "./env.ts";
import { mindHostResponse } from "./host-session.ts";
import { identityIntakeAnswer } from "./identity-delivery.ts";
import { confinedAnswer, httpsRedirect, stampedRequest } from "./stamp.ts";

/** The mind, as the boundary reaches it. */
export type MindTransport = Pick<
  MindTarget,
  "fetch" | "append" | "runAct" | "receiveEmail" | "email" | "api"
> & {
  /** Only where the mind runs elsewhere: the answer to its dial, a session of the API that ends
   *  in the object which holds the mind's link (./provided-mind.ts). */
  link?(dial: Request): Promise<Response>;
  /** Only where the mind runs elsewhere: one platform fact, appended now, or kept and appended
   *  when the mind is back (./provided-mind.ts `appendOrKeep`). */
  appendOrKeep?(path: string, fact: PlatformFact): Promise<void>;
};

/** One platform fact for the mind's log, with the key that makes it one. */
export type PlatformFact = {
  type: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

/** THE BOUNDARY'S ONE RULE: a request on the mind's control-plane hostname is the control plane's
 *  (sign-in, the secrets pages, the API, the MCP server). A request on any other
 *  hostname is the mind's: its config worker answers it, and what happens there is userland's
 *  decision. */
export const isControlPlaneRequest = (
  request: Pick<Request, "url">,
  config: Pick<MindConfig, "controlPlaneHostname">,
) => isControlPlaneHostname(config, new URL(request.url).hostname);

/** A REQUEST WHOSE HOSTNAME ENDS WITH A DOT IS REFUSED, before anything else. `example.com.` is
 *  the same DNS name as `example.com`, but another origin to a browser and another string to
 *  every comparison after this one: its cookies, its tokens' resource and its place on one side
 *  of the boundary's rule would each need the same care. 421: this server does not answer for
 *  that authority (RFC 9110 §15.5.20). */
function dottedHostnameRefusal(request: Pick<Request, "url">): Response | undefined {
  if (!new URL(request.url).hostname.endsWith(".")) return undefined;
  return new Response("This hostname ends with a dot. Ask again without it.\n", { status: 421 });
}

export async function boundaryResponse(
  incoming: Request,
  env: DoorEnv,
  ctx: ExecutionContext,
  mind: MindTransport,
  // the Door's alone (./rpc.ts), for every request of the mind's to a hostname of its zones; the
  // stamp is set only on the forward to the mind's hosts (`ownStamped`)
  { own }: { own?: true } = {},
): Promise<Response> {
  const request = withoutOutsidePlaceholders(incoming);
  const dotted = dottedHostnameRefusal(request);
  if (dotted) return dotted;
  const secure = httpsRedirect(request);
  if (secure) return secure;
  const config = boundaryConfigOf(env);
  // `fromAuth`: only the auth Worker's answer names the signer of an event (the key it verified)
  const recordFacts = (response: Response, fromAuth = false) => {
    const { answer, recorded: appended } = recorded(response, (path, events) =>
      mind.append(path, events, fromAuth),
    );
    ctx.waitUntil(appended);
    return answer;
  };
  if (!isControlPlaneRequest(request, config))
    return mindHostResponse(request, { auth: env.AUTH, config, recordFacts }, (forwarded) =>
      mind.fetch(own ? ownStamped(forwarded, request) : forwarded),
    );
  const url = new URL(request.url);
  const route = controlPlaneRouteOf(url);
  // THE API IS A SESSION THAT ENDS HERE (./control-plane-api.ts), and the mind gets none of its
  // socket. Under `/api/` the rest is the mind's, as before (a signed file URL, a webhook).
  if (route === "api" && url.pathname === "/api") {
    // WHERE THE SESSION ENDS is the dial's to say, and nothing about who it is: a mind that hands
    // itself in says so (iterate/mind-api `MIND_PROVIDE_EXTERNAL_MIND_HEADER`), and its socket
    // ends in the object that holds its link. A stack whose mind is a Worker takes none.
    if (!isWebSocketUpgrade(request) || !request.headers.has(MIND_PROVIDE_EXTERNAL_MIND_HEADER))
      return controlPlaneApiResponse(request, { auth: env.AUTH, config, mind });
    if (!mind.link)
      return new Response("This stack's mind is a Worker of the stack: it takes no mind.\n", {
        status: 403,
      });
    return mind.link(request);
  }
  const { forwarded, answer } = await stampedRequest(request, {
    auth: env.AUTH,
    route,
    config,
  });
  if (answer) return answer;
  // A RECORD OF THE MIND'S IDENTITY, posted to the auth Worker's intake: the answer is the auth
  // Worker's own, at once, and the facts that its rows owe the mind's log are delivered to `/`
  // after it, as well as that goes (./identity-delivery.ts). The facts come by RPC, so this answer's
  // facts header, which the intake does not set, is dropped unread.
  if (route === "auth" && forwarded.method === "POST" && url.pathname === MIND_IDENTITY_PATH)
    return identityIntakeAnswer(
      withFacts(await env.AUTH.fetch(forwarded), []),
      env.AUTH,
      (events) => mind.append("/", events),
      (work) => ctx.waitUntil(work),
    );
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

/** The mind's own request, stamped so after `stampedRequest` stripped every `x-itx-*` header and
 *  every mark: only the mind's hosts get it, with the mark that the code's egress wrote, which
 *  resumes its chain there (core/itx/src/cause.ts). */
function ownStamped(forwarded: Request, own: Request): Request {
  const headers = new Headers(forwarded.headers);
  headers.set(ITX_OWN_HEADER, "1");
  const mark = own.headers.get(ITERATE_CAUSE_HEADER);
  if (mark) headers.set(ITERATE_CAUSE_HEADER, mark);
  return new Request(forwarded, { headers });
}
