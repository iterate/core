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
  fetchLeavingTheStack,
  ITERATE_CAUSE_HEADER,
  reportIssue,
} from "iterate/lib";
import { SECRET_USE_HEADER, secretPathsReferenced } from "iterate/secret-placeholder";
import { type MindConfig, zoneOf, zoneOfMailAddress } from "iterate/mind-config";
import type { Door as DoorService, SecretVerb, SecretVerbs } from "iterate/workers";
import {
  isMindControlPlaneHostname,
  isMindId,
  ITERATE_STATEMENT_HEADER,
  mindFetchStatements,
  signedRequestHeaders,
} from "iterate/signed";
import { z } from "zod";
import { boundaryConfigOf } from "./config.ts";
import type { Env } from "./env.ts";
import { boundaryResponse } from "./http.ts";
import { mindTransportOf } from "./mind-transport.ts";
import { ownRequestHeaders } from "./own-request.ts";

// The Door is an entrypoint of the boundary Worker, whose `env` holds the mind's binding too.
/** `provided`: the Door that a mind which runs elsewhere is given (./provided-mind.ts). The stack's
 *  own binding (core/alchemy `DOOR`) sets none. */
export type DoorProps = { provided?: true };

export class Door extends WorkerEntrypoint<Env, DoorProps> implements DoorService {
  async fetch(request: Parameters<DoorService["fetch"]>[0]) {
    // Only the Door names a secret in SECRET_USE_HEADER, and only `fetchForMind` signs.
    const headers = new Headers(request.headers);
    headers.delete(SECRET_USE_HEADER);
    headers.delete(ITERATE_STATEMENT_HEADER);
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
    // A hostname of one of the mind's zones is the mind's own. No answer keeps a facts header: the
    // mind would append what it says.
    const url = new URL(outbound.url);
    const ownZone = zoneOf(boundaryConfigOf(this.env), url.hostname);
    if (!ownZone) return withFacts(await fetchLeavingTheStack(this.env, outbound), []);
    // The boundary's handler refuses a hostname that ends with a dot (421): the mind's own
    // request goes in as the same DNS name without it.
    url.hostname = url.hostname.replace(/\.$/, "");
    // The global `fetch` fails inside a zone of the stack: the boundary's own handler answers, in
    // this invocation, and strips the mind's stamps. An argument, never a header, says that the
    // request is the mind's own, so nothing from outside can say it. The mind's own request to one
    // of its hosts is nobody's (./own-request.ts). Only the stack's own mind Worker says so: a
    // provided mind's Door may serve a session that is not the active mind's.
    return withFacts(
      await boundaryResponse(
        new Request(url, new Request(outbound, { headers: ownRequestHeaders(outbound.headers) })),
        this.env,
        this.ctx,
        mindTransportOf(this.env),
        this.ctx.props?.provided ? {} : { own: true },
      ),
      [],
    );
  }

  /** The built-in `itx.fetch(request, { signFor })` alone (core/itx/src/context/built-ins.ts),
   *  which `itx.minds.get(signFor).fetch` calls (core/mind-worker/src/context/minds.ts). */
  async fetchForMind(...[signFor, request]: Parameters<DoorService["fetchForMind"]>) {
    const headers = signedRequestHeaders(request.headers);
    // a fragment never goes on the wire, so the statement is for the URL without it
    const url = new URL(request.url);
    url.hash = "";
    // workerd takes a URL with userinfo, which the statement would sign and the fetch would send
    if (url.username || url.password)
      throw codedError(
        "INVALID_INPUT",
        "fetch(request, { signFor }): a request signed for another mind takes no credentials in its URL: send them in a header",
      );
    const unsigned = new Request<unknown, CfProperties>(
      url.href,
      new Request(request, { headers }),
    );
    const refusal = this.#signRefusal(
      signFor,
      unsigned,
      secretPathsReferenced(unsigned).length > 0,
    );
    if (refusal) throw codedError("INVALID_INPUT", `fetch(request, { signFor }): ${refusal}`);
    const statement = await this.#statementFor(signFor, unsigned);
    headers.set(ITERATE_STATEMENT_HEADER, statement);
    return withoutStatement(
      withFacts(
        await fetchLeavingTheStack(this.env, new Request(unsigned, { headers }), {
          redirect: "manual",
        }),
        [],
      ),
      statement,
    );
  }

  #signRefusal(signFor: string, request: Request, namesASecret: boolean) {
    const { controlPlaneHostname: own, mindId } = boundaryConfigOf(this.env);
    if (
      (!isMindId(signFor) && !isMindControlPlaneHostname(signFor)) ||
      [own, mindId].includes(signFor)
    )
      return `${signFor} is no other mind to sign a request for`;
    if (new URL(request.url).protocol !== "https:")
      return "a request to another mind goes by https";
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
      return "a WebSocket upgrade is refused: a socket cannot come back across the signing call";
    if (namesASecret) return "a request signed for another mind names no secret";
    return undefined;
  }

  #statementFor(signFor: string, request: Request): Promise<string> {
    return statementsHere((input) => this.env.AUTH.sign(input), {
      from: boundaryConfigOf(this.env).controlPlaneHostname,
      mind: signFor,
      method: request.method,
      url: new URL(request.url).href,
    });
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

  async listSecrets() {
    return this.env.SECRETS.listSecrets();
  }

  async cloud(origin: Parameters<DoorService["cloud"]>[0]) {
    return this.env.SECRETS.cloud(origin);
  }

  async hasStackClient(name: Parameters<DoorService["hasStackClient"]>[0]) {
    return this.env.SECRETS.hasStackClient(name);
  }

  async refreshGrants(after?: string) {
    return this.env.SECRETS.refreshGrants(after);
  }

  async setActRules(input: Parameters<DoorService["setActRules"]>[0]) {
    return this.env.SECRETS.setActRules(input);
  }

  async proposeActRule(input: Parameters<DoorService["proposeActRule"]>[0]) {
    return this.env.SECRETS.proposeActRule(input);
  }

  async sendEmail(...[message, options]: Parameters<DoorService["sendEmail"]>) {
    const refused = senderRefusal(message.from.email, boundaryConfigOf(this.env));
    if (refused) return { sent: false as const, error: refused };
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
      // the provider's own error code (Email Sending throws an Error that carries one)
      const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
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

  async proposeStatement(input: Parameters<DoorService["proposeStatement"]>[0]) {
    return this.env.AUTH.proposeStatement(input);
  }

  // Never without `mind`: a statement with none names this mind as its signer, which the Cloud
  // trusts, and the mind's code must not make one.
  async signForMind(input: Parameters<DoorService["signForMind"]>[0]) {
    if (!input?.mind) throw codedError("INVALID_INPUT", "signForMind names the mind it is for");
    return this.env.AUTH.sign(input);
  }

  async queryTelemetry(...[sql, hours]: Parameters<DoorService["queryTelemetry"]>) {
    return this.env.TELEMETRY.query(sql, hours);
  }

  async sendEvents(events: Parameters<DoorService["sendEvents"]>[0]) {
    return this.env.TELEMETRY.sendEvents(events);
  }

  async writeMetrics(points: Parameters<DoorService["writeMetrics"]>[0]) {
    return this.env.TELEMETRY.writeMetrics(points);
  }
}

const statementsHere = mindFetchStatements(256);

/** `response` with no header that holds `statement`, which is never the code's. */
function withoutStatement(response: Response, statement: string): Response {
  const named = [...response.headers].filter(([, value]) => value.includes(statement));
  if (!named.length) return response;
  const headers = new Headers(response.headers);
  for (const [name] of named) headers.delete(name);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** WHY A MAIL MAY NOT LEAVE FROM `from`, or null. The sender is ONE mailbox at a zone of the
 *  mind: a text with two `@` or a display name is none, whatever its last part says. */
export function senderRefusal(from: string, config: Pick<MindConfig, "zones">): string | null {
  if (z.email().safeParse(from).success && zoneOfMailAddress(config, from)) return null;
  return `mail leaves from one address at a zone of the mind alone: ${config.zones.join(", ")}`;
}
