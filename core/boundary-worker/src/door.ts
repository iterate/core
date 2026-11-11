import { WorkerEntrypoint } from "cloudflare:workers";
import { withFacts } from "iterate/facts";
import {
  causeLeavingTheStack,
  codedError,
  ITERATE_CAUSE_HEADER,
  leavingTheStack,
} from "iterate/lib";
import { SECRET_USE_HEADER, secretPathsReferenced } from "iterate/secret-placeholder";
import type { Door as DoorService, SecretVerb, SecretVerbs } from "iterate/workers";
import type { DoorEnv } from "./env.ts";

export class Door extends WorkerEntrypoint<DoorEnv> implements DoorService {
  async fetch(request: Parameters<DoorService["fetch"]>[0]) {
    // Only the door names a secret in SECRET_USE_HEADER, never a caller.
    const headers = new Headers(request.headers);
    headers.delete(SECRET_USE_HEADER);
    const outbound = new Request(request, { headers });
    const paths = secretPathsReferenced(outbound);
    if (paths.length > 1)
      return new Response(
        `itx.fetch: one request, one secret — this one names ${paths.map((path) => JSON.stringify(path)).join(", ")}\n`,
        { status: 502 },
      );
    if (paths[0]) {
      headers.set(SECRET_USE_HEADER, paths[0]);
      return this.env.SECRET_USE.fetch(new Request(outbound, { headers }));
    }
    const domain = this.env.DOMAIN;
    const { hostname } = new URL(outbound.url);
    const ownDomain =
      this.env.HOSTNAMES === "platform"
        ? hostname === `iterate.${domain}`
        : hostname === domain || hostname.endsWith(`.${domain}`);
    // The global `fetch` fails inside the zone: the boundary's own handler answers, and strips the
    // mind's stamps. No answer keeps a facts header: the mind would append what it says.
    const inbound = (this.ctx.exports as unknown as { default: Fetcher }).default;
    if (!ownDomain) return withFacts(await fetch(leavingTheStack(outbound)), []);
    // The mind's own request to one of its hosts is nobody's: it carries no session in.
    const ownHeaders = new Headers(outbound.headers);
    ownHeaders.delete("cookie");
    return withFacts(await inbound.fetch(new Request(outbound, { headers: ownHeaders })), []);
  }

  /* oxlint-disable iterate/mechanical-class-impl -- a generic method: `Parameters<>` of the contract would lose `V`, which ties each verb to its input and its answer */
  secret<V extends SecretVerb>(path: string, verb: V, input: SecretVerbs[V]["input"]) {
    return this.env.SECRETS.secret(path, verb, input);
  }
  /* oxlint-enable iterate/mechanical-class-impl */

  async sendEmail(message: Parameters<DoorService["sendEmail"]>[0]) {
    const domain = this.env.DOMAIN;
    if (!message.from.email.toLowerCase().endsWith(`@${domain}`))
      return { sent: false as const, error: `mail leaves from an address @${domain} alone` };
    // a mail leaves the stack as a request to another host does
    const { [ITERATE_CAUSE_HEADER]: cause, ...headers } = message.headers;
    const mark = causeLeavingTheStack(cause);
    try {
      const { messageId } = await this.env.SEND_EMAIL.send({
        from: message.from,
        to: message.to,
        ...(message.cc.length > 0 && { cc: message.cc }),
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: mark ? { ...headers, [ITERATE_CAUSE_HEADER]: mark } : headers,
        ...(message.attachments.length > 0 && {
          attachments: message.attachments.map(({ filename, contentType, content }) => ({
            disposition: "attachment" as const,
            filename,
            type: contentType,
            content,
          })),
        }),
      });
      return { sent: true as const, messageId };
    } catch (error) {
      return {
        sent: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async queryTelemetry(...[sql, hours]: Parameters<DoorService["queryTelemetry"]>) {
    return this.#telemetry().query(sql, hours);
  }

  async sendEvents(events: Parameters<DoorService["sendEvents"]>[0]) {
    return this.#telemetry().sendEvents(events);
  }

  async writeMetrics(points: Parameters<DoorService["writeMetrics"]>[0]) {
    return this.#telemetry().writeMetrics(points);
  }

  #telemetry() {
    if (!this.env.TELEMETRY)
      throw codedError(
        "UNAVAILABLE",
        'telemetry: this stack has no telemetry part (core/alchemy README, "Telemetry")',
      );
    return this.env.TELEMETRY;
  }
}
