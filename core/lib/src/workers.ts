// Types, and the few names two Workers must share: no Worker imports another Worker's code.
import type { SecretOperation, SecretRefresh } from "./api.ts";
import type { Facts } from "./facts.ts";
import type { Principal } from "./principal.ts";
import type { Envelope, Statement } from "./signed.ts";
import type { StreamEvent, StreamEventInput } from "./stream/processor.ts";

export interface MindTarget {
  /** The mind trusts the boundary's stamp because only the boundary can reach it. */
  fetch(request: Request): Promise<Response>;
  /** Idempotent by each event's `idempotencyKey`. `fromAuth`: the events are the auth Worker's own
   *  answer, so the `source.signer` one names is the key the auth Worker verified. In any other
   *  call an event's signer is dropped. */
  append(path: string, events: StreamEventInput[], fromAuth?: boolean): Promise<void>;
  /** A redelivery records nothing new. */
  receiveEmail(mail: ReceivedEmail): Promise<void>;
}

export type TokenIdentity = {
  principal: Principal;
  grant: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Always true for the API, the MCP server and `/provide`; a mind hostname's token answers for
   *  anyone signed in. False for a key's token. */
  member: boolean;
  /** A KEY'S TOKEN, never a person's (core/auth-worker/src/key-tokens.ts): the one capability name
   *  it may lend to the mind as `itx.<provide>`. It is live for the API alone, where it reaches
   *  that lend and nothing else of the mind. `principal.actor` is the key's service and `grant`
   *  is `key:<the key's id>`. */
  provide?: string;
};

export interface Door {
  /** A request for a hostname of the mind's own domain is answered in the boundary: the global
   *  `fetch` fails inside the zone. */
  fetch(request: Request): Promise<Response>;
  secret: SecretCall;
  sendEmail(message: OutboundEmail): Promise<EmailOutcome>;
  /** Refused in a stack without the telemetry part. */
  queryTelemetry(sql: string, hours?: number): Promise<TelemetryAnswer>;
  sendEvents(events: StreamEvent[]): Promise<void>;
  writeMetrics(points: MetricPoint[]): Promise<void>;
}

/** As workers-types' `AnalyticsEngineDataPoint` spells it. */
export type MetricPoint = { indexes?: string[]; blobs?: string[]; doubles?: number[] };

export type TelemetryAnswer = { rows: Record<string, unknown>[]; sql: string };

/** It holds the warehouse's tokens, so the mind, which may be hostile, never holds one. */
export interface TelemetryService {
  /** `hours` is 24 by default and at most 720; at most 1,000 rows. */
  query(sql: string, hours?: number): Promise<TelemetryAnswer>;
  sendEvents(events: StreamEvent[]): Promise<void>;
  /** For a mind with no metrics binding of its own, a home lab's. */
  writeMetrics(points: MetricPoint[]): Promise<void>;
}

/** One connection carries both directions, and it ends when the token does. */
export interface ProvideSession {
  /** Disposing of the handle ends the lend; `lendEnded` settles, with why, when the other side ends it. */
  provide(mind: MindTarget): Promise<{ [Symbol.dispose](): void; lendEnded(): Promise<string> }>;
  door: Door;
}

export interface AuthService {
  fetch(request: Request): Promise<Response>;
  /** RFC 8707: a token is for one resource. Null when it is not live for `resource`, or, for any
   *  resource but a hostname, when its person is no member now. */
  whoIs(token: string, resource: string): Promise<TokenIdentity | null>;
  /** A public client whose one redirect is `https://<host>${HOST_SESSION_PREFIX}callback`. Refused
   *  for a host outside the mind's domain, or the platform's. */
  hostClient(host: string): Promise<string>;
  isMember(email: string): Promise<boolean>;
  /** `cookie` is the request's `Cookie` header on the issuer's origin; null when signed out. */
  browserSession(
    cookie: string | null,
  ): Promise<{ userId: string; email: string; member: boolean } | null>;
  /** A statement counts once: a second `verify` of it is refused. Its `path` and `type` are the
   *  business of whoever acts on it. */
  verify(envelope: Envelope): Promise<Verified>;
  /** `expiresInSeconds`: five minutes by default, a day at most. `verify` never takes the result: it
   *  is for others, at `GET iterate.<domain>/keys/stack.json`. */
  sign(input: {
    path: string;
    type: string;
    payload?: Record<string, unknown>;
    about?: string[];
    expiresInSeconds?: number;
  }): Promise<Envelope>;
}

export type Verified =
  | {
      signer: {
        principal: Principal;
        /** The key's id: iterate/signed `keyIdOf`. */
        key: string;
        label: string;
        /** A service's key never is. Only a member's key approves. */
        member: boolean;
        /** WebAuthn: the person was verified, not only present. */
        userVerified?: boolean;
      };
      statement: Statement;
    }
  | { refused: string };

/** The boundary answers everything under it on a mind hostname; the mind never sees it. */
export const HOST_SESSION_PREFIX = "/.iterate/";

export type SecretAnswer<T> = { result: T; facts: Facts };

/** The caller appends the facts, then throws `FORBIDDEN` with the message. */
export type SecretRefusal = { refused: { code: "FORBIDDEN"; message: string }; facts: Facts };

export type SecretDescription = {
  path: string;
  set: boolean;
  urls?: string[];
  refresh?: SecretRefresh["kind"];
  public?: Record<string, string>;
  placement?: "header" | "url";
  operations?: SecretOperation[];
  /** Null is every path, as for an import. */
  lendTo?: string[] | null;
};

export type SecretOAuthResult =
  | { status: "pending" }
  | { status: "complete"; scopes: string[]; account?: { id: string; name: string | null } }
  | { status: "unavailable" };

/** The secret's object refuses a verb not on the list, and checks each input, which arrives untyped. */
export type SecretVerbs = {
  /** The options, with `material` beside them. */
  set: { input: unknown; answer: SecretAnswer<{ path: string }> };
  delete: { input: undefined; answer: SecretAnswer<{ path: string }> };
  describe: { input: undefined; answer: SecretDescription };
  /** `proof`: the HMAC-SHA256 of `[path, cell]` as JSON under the at-rest key. */
  importSealed: { input: { cell: string; proof: string }; answer: SecretAnswer<{ path: string }> };
  /** `authorizationUrl` is the platform's start link, not the provider's URL. */
  beginOAuth: {
    input: unknown;
    answer: SecretAnswer<{ authorizationUrl: string; nonce: string }> | SecretRefusal;
  };
  oauthResult: { input: { nonce: string }; answer: SecretOAuthResult };
  collectFromUser: { input: unknown; answer: { path: string; url: string } };
  signHmac: { input: unknown; answer: SecretAnswer<string> | SecretRefusal };
  verifyHmac: { input: unknown; answer: SecretAnswer<boolean> | SecretRefusal };
  verifyEquals: { input: unknown; answer: SecretAnswer<boolean> | SecretRefusal };
  deriveSharedSecret: { input: unknown; answer: SecretAnswer<string> | SecretRefusal };
  publicKeyOf: { input: unknown; answer: SecretAnswer<string> | SecretRefusal };
  signWithKey: { input: unknown; answer: SecretAnswer<string> | SecretRefusal };
};

export type SecretVerb = keyof SecretVerbs;

export type SecretCall = <V extends SecretVerb>(
  path: string,
  verb: V,
  input: SecretVerbs[V]["input"],
) => Promise<SecretVerbs[V]["answer"]>;

/** A request sent with a secret goes to its other entrypoint, `SecretUse`, which only the boundary binds. */
export interface SecretsService {
  fetch(request: Request): Promise<Response>;
  secret: SecretCall;
}

/** `from` must be an address on the mind's domain. */
export type OutboundEmail = {
  from: { email: string; name: string };
  to: string[];
  cc: string[];
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments: { filename: string; contentType: string; content: Uint8Array }[];
};

export type EmailOutcome = { sent: true; messageId: string } | { sent: false; error: string };

/** Each file is a stream: Workers RPC sends a stream beside its 32 MiB call limit, and capnweb sends
 *  one chunk a message. */
export type ReceivedEmail = {
  events: StreamEventInput[];
  files: { path: string; contentType: string; size: number; data: ReadableStream<Uint8Array> }[];
};
