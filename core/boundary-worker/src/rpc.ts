import { WorkerEntrypoint } from "cloudflare:workers";
import {
  actOfText,
  actText,
  isMailAct,
  mailActOf,
  mailHeaderRefusal,
  mailHeadersOf,
  recipientsRefusal,
} from "iterate/acts";
import { withFacts } from "iterate/facts";
import {
  causeLeavingTheStack,
  codedError,
  ITERATE_CAUSE_HEADER,
  leavingTheStack,
  reportIssue,
} from "iterate/lib";
import { SECRET_USE_HEADER, secretPathsReferenced } from "iterate/secret-placeholder";
import type { Door as DoorService, SecretVerb, SecretVerbs } from "iterate/workers";
import type { DoorEnv } from "./env.ts";
import { ownRequestHeaders } from "./own-request.ts";

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
        { status: 403 },
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
    // The mind's own request to one of its hosts is nobody's (./own-request.ts).
    return withFacts(
      await inbound.fetch(new Request(outbound, { headers: ownRequestHeaders(outbound.headers) })),
      [],
    );
  }

  /* oxlint-disable iterate/mechanical-class-impl -- a generic method: `Parameters<>` of the contract would lose `V`, which ties each verb to its input and its answer */
  secret<V extends SecretVerb>(path: string, verb: V, input: SecretVerbs[V]["input"]) {
    return this.env.SECRETS.secret(path, verb, input);
  }
  /* oxlint-enable iterate/mechanical-class-impl */

  // THE GATE FOR ACTS, for the mind's own code. A mail is asked about by `sendEmail` below alone:
  // through `act` the mind could spend a mail's approval and send nothing.
  async act(input: Parameters<DoorService["act"]>[0]) {
    // as the gate reads the text: a text that is no act is the gate's to refuse
    const act = actOfText(input.text);
    if (act && isMailAct(act))
      throw codedError("FORBIDDEN", "the gate is asked about a mail by sending it, never apart");
    return this.env.SECRETS.act(input);
  }

  async actRules() {
    return this.env.SECRETS.actRules();
  }

  async listSecrets(known?: Parameters<DoorService["listSecrets"]>[0]) {
    return this.env.SECRETS.listSecrets(known);
  }

  async refreshGrants(...[known, after]: Parameters<DoorService["refreshGrants"]>) {
    return this.env.SECRETS.refreshGrants(known, after);
  }

  async setActRules(input: Parameters<DoorService["setActRules"]>[0]) {
    return this.env.SECRETS.setActRules(input);
  }

  async proposeActRule(input: Parameters<DoorService["proposeActRule"]>[0]) {
    return this.env.SECRETS.proposeActRule(input);
  }

  async sendEmail(...[message, options]: Parameters<DoorService["sendEmail"]>) {
    const domain = this.env.DOMAIN;
    if (!message.from.email.toLowerCase().endsWith(`@${domain}`))
      return { sent: false as const, error: `mail leaves from an address @${domain} alone` };
    const odd = recipientsRefusal([...message.to, ...message.cc]);
    if (odd) return { sent: false as const, error: odd };
    // THE GATE FIRST (iterate/acts): the mail as its approver reads it is made here, from what is
    // about to be sent, so a mind cannot have one mail approved and another sent. `free` and `go`
    // go on: `go` is the gate's mark that a member approved this mail, set once.
    const act = await mailActOf(message);
    const broken = mailHeaderRefusal(act);
    if (broken) return { sent: false as const, error: broken };
    const gate = await this.env.SECRETS.act({
      text: actText(act),
      from: options?.from,
      wait: options?.wait,
    });
    if (gate.state !== "free" && gate.state !== "go")
      return {
        sent: false as const,
        error:
          gate.state === "rejected"
            ? `${gate.by} rejected this mail: ${gate.reason}`
            : gate.state === "done"
              ? "this exact mail was sent before, for a member's one approval: a new mail differs"
              : "this mail waits for a member's approval",
        gate,
      };
    // The headers that go are made again from the act, so none goes that an approver did not see.
    // Our mark goes beside them: a mail leaves the stack as a request to another host does.
    const headers = mailHeadersOf(act, message.headers);
    const mark = causeLeavingTheStack(message.headers[ITERATE_CAUSE_HEADER]);
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
      // The gate's `notDone` says what this gives back. It is not reached when the boundary dies
      // in the send: that mail may have gone, so the gate's mark stays.
      if (gate.state === "go")
        await this.env.SECRETS.actNotDone(gate.digest).catch((failed: unknown) =>
          reportIssue("approval.not-given-back", failed, { digest: gate.digest }),
        );
      const code = (error as { code?: unknown } | null)?.code;
      return {
        sent: false as const,
        error: error instanceof Error ? error.message : String(error),
        ...(typeof code === "string" && { code }),
      };
    }
  }

  async isMember(email: Parameters<DoorService["isMember"]>[0]) {
    return this.env.AUTH.isMember(email);
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
