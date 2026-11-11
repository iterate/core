import { runApprovedActs } from "iterate/acts";
import { recordFacts as recorded } from "iterate/facts";
import { platformRouteOf } from "iterate/mind-api";
import type { Env } from "./env.ts";
import { mindHostResponse } from "./host-session.ts";
import { parseEmail } from "./mail.ts";
import { confinedAnswer, httpsRedirect, stampedRequest } from "./stamp.ts";

export { Door } from "./door.ts";

export default {
  async fetch(request, env, ctx) {
    const secure = httpsRedirect(request);
    if (secure) return secure;
    const domain = env.DOMAIN;
    const route = platformRouteOf(new URL(request.url), domain);
    // `fromAuth`: only the auth Worker's answer names the signer of an event (the key it verified)
    const recordFacts = (response: Response, fromAuth = false) => {
      const { answer, recorded: appended } = recorded(response, (path, events) =>
        env.MIND.append(path, events, fromAuth),
      );
      ctx.waitUntil(appended);
      return answer;
    };
    if (!route)
      return mindHostResponse(request, { auth: env.AUTH, domain, recordFacts }, (forwarded) =>
        env.MIND.fetch(forwarded),
      );
    if (route === "provide") return new Response("Not found", { status: 404 });
    const { forwarded, answer } = await stampedRequest(request, { auth: env.AUTH, route, domain });
    if (answer) return answer;
    if (route === "auth") return recordFacts(await env.AUTH.fetch(forwarded), true);
    if (route === "secrets") {
      // an approval of an act whose caller stopped waiting: the mind does the act now
      const { answer: answered, ran } = runApprovedActs(
        await env.SECRETS.fetch(forwarded),
        async (digest) => {
          const held = await env.SECRETS.approvedAct(digest);
          if (held) await env.MIND.runAct(held);
        },
      );
      ctx.waitUntil(ran);
      return recordFacts(answered);
    }
    return confinedAnswer(await env.MIND.fetch(forwarded));
  },

  // A failure throws, so Cloudflare delivers the mail again; the fact's idempotency key keeps a retry
  // after a committed append from landing twice.
  async email(message, env) {
    await env.MIND.receiveEmail(
      await parseEmail({
        from: message.from,
        to: message.to,
        raw: message.raw,
        isMember: (address) => env.AUTH.isMember(address),
      }),
    );
  },
} satisfies ExportedHandler<Env>;
