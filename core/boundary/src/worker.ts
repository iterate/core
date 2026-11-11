import { recordFacts as recorded } from "iterate/facts";
import { platformRouteOf } from "iterate/project-api";
import type { Env } from "./env.ts";
import { projectHostResponse } from "./host-session.ts";
import { parseEmail } from "./mail.ts";
import { confinedAnswer, httpsRedirect, stampedRequest } from "./stamp.ts";

export { Door } from "./door.ts";

export default {
  async fetch(request, env, ctx) {
    const secure = httpsRedirect(request);
    if (secure) return secure;
    const domain = env.DOMAIN;
    const route = platformRouteOf(new URL(request.url), domain);
    const recordFacts = (response: Response) => {
      const { answer, recorded: appended } = recorded(response, (path, events) =>
        env.PROJECT.append(path, events),
      );
      ctx.waitUntil(appended);
      return answer;
    };
    if (!route)
      return projectHostResponse(request, { auth: env.AUTH, domain, recordFacts }, (forwarded) =>
        env.PROJECT.fetch(forwarded),
      );
    if (route === "provide") return new Response("Not found", { status: 404 });
    const { forwarded, answer } = await stampedRequest(request, { auth: env.AUTH, route, domain });
    if (answer) return answer;
    if (route === "auth") return recordFacts(await env.AUTH.fetch(forwarded));
    if (route === "secrets") return recordFacts(await env.SECRETS.fetch(forwarded));
    return confinedAnswer(await env.PROJECT.fetch(forwarded));
  },

  // A failure throws, so Cloudflare delivers the mail again; the fact's idempotency key keeps a retry
  // after a committed append from landing twice.
  async email(message, env) {
    await env.PROJECT.receiveEmail(
      await parseEmail({
        from: message.from,
        to: message.to,
        raw: message.raw,
        isMember: (address) => env.AUTH.isMember(address),
      }),
    );
  },
} satisfies ExportedHandler<Env>;
