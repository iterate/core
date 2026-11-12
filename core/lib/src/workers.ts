// Types, and the few names two Workers must share: no Worker imports another Worker's code.
import type { ActRule, GateAnswer } from "./acts.ts";
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
  /** An act a member approved after its caller stopped waiting (./acts.ts): the mind does it now,
   *  once, and writes what came of it on the caller's context. The gate decides whether it is
   *  still to do, so a second call does nothing. */
  runAct(held: { digest: string; text: string; from?: string }): Promise<void>;
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
  listSecrets: SecretsService["listSecrets"];
  refreshGrants: SecretsService["refreshGrants"];
  /** A mail that an approval rule names waits in the vault's gate (./acts.ts). The first call
   *  answers `gate.state: "held"` at once; a call with `wait` waits for the member's answer.
   *  `from` is the caller's claim of where the mail began. */
  sendEmail(
    message: OutboundEmail,
    options?: { wait?: boolean; from?: string },
  ): Promise<EmailOutcome>;
  /** THE GATE FOR ACTS, for the mind's own code (./acts.ts): what it says of a verb's call, the
   *  rules as they are, the rules set while the gate is open, and a rule proposed. A mail is
   *  asked about by `sendEmail` alone. */
  act: SecretsService["act"];
  actRules: SecretsService["actRules"];
  setActRules: SecretsService["setActRules"];
  proposeActRule: SecretsService["proposeActRule"];
  /** Whether `email` is a member of the mind now, as the auth Worker knows it (`AuthService`). */
  isMember(email: string): Promise<boolean>;
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

/** What came of the refresh on word of one person's grant (`SecretsService.refreshGrants`):
 *  `refreshed`, the provider gave new tokens; `fresh`, it was refreshed within the last hour and
 *  is left alone; `failed`, with the error's words, and the secret is as it was. `answerLost`:
 *  it failed because no answer came, not because the provider refused. The provider may have
 *  issued new tokens that never arrived, and the next try tells. */
export type GrantRefreshed =
  | { path: string; outcome: "refreshed" | "fresh" }
  | { path: string; outcome: "failed"; error: string; answerLost?: true };

/** One call's part of a refresh of the grants: the rows of the grants it asked, and `next`, the
 *  path to go on from, when the vault holds more grants than one call refreshes. */
export type GrantsRefreshed = { grants: GrantRefreshed[]; next?: string };

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
  /** ./api.ts `secrets.importSealed` says what the proof is over and which cells are taken. */
  importSealed: { input: { cell: string; proof: string }; answer: SecretAnswer<{ path: string }> };
  /** ./api.ts `secrets.exportSealed` says what the proof is over, when it ends, and what the
   *  sealed text is. */
  exportSealed: {
    input: { proof: string; until: number };
    answer: SecretAnswer<{ sealed: string }>;
  };
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
  /** THE SECRETS THAT ARE SET, IN ONE CALL: the vault keeps their paths, so it asks about no
   *  secret that was deleted. `known` is the mind's own list of the paths it ever had: a vault
   *  that held secrets before it kept its list asks about those once, and never reads it after. */
  listSecrets(known?: string[]): Promise<SecretDescription[]>;
  /** THE PERSONS' GRANTS THAT THE ITERATE CLOUD BROKERS, REFRESHED ON WORD, whichever client of
   *  the Cloud a grant is of: one row for each, and the facts for the mind's log.
   *  core/secrets-worker/src/grant-refresh.ts says why these grants need a refresh on word.
   *  `known` is as for `listSecrets`. One call refreshes twenty grants at most, by path, and
   *  answers `next` when there are more: the caller calls again with it as `after`, so every
   *  grant is reached. */
  refreshGrants(known?: string[], after?: string): Promise<SecretAnswer<GrantsRefreshed>>;
  /** THE GATE FOR ACTS (./acts.ts): what it says of a mail or of a verb's call, by its exact
   *  text. `from` is the caller's claim of where the act began. With `wait`, a held act's answer
   *  comes when a member decided, or after five minutes. */
  act(input: { text: string; from?: string; wait?: boolean }): Promise<GateAnswer>;
  /** An act a member approved that is not done yet, by its id: what `runAct` of the mind takes. */
  approvedAct(digest: string): Promise<{ digest: string; text: string; from?: string } | null>;
  /** The boundary's alone, never the mind's: a mail the gate let go (`go`) that the mail service
   *  refused keeps its approval. With this, a mind could send one approved mail many times. */
  actNotDone(digest: string): Promise<void>;
  /** The rules, set by the mind's own code. Refused once a member locked the gate. */
  setActRules(input: { rules: unknown; from: string }): Promise<{ rules: ActRule[]; facts: Facts }>;
  /** A rule the mind's code asks for: a member signs it on `/secrets/approvals`, or does not. */
  proposeActRule(input: { rule: unknown; from?: string }): Promise<{ id: string; facts: Facts }>;
  actRules(): Promise<{ locked: boolean; rules: ActRule[] }>;
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
  /** `path`: where the file is in the mind's files, so a mail approved later is made again. */
  attachments: { filename: string; contentType: string; content: Uint8Array; path?: string }[];
};

/** `gate`: why the mail was not sent, when an approval rule holds it (./acts.ts). `code`: the mail
 *  provider's error code, when it refused the mail and gave one. */
export type EmailOutcome =
  | { sent: true; messageId: string }
  | {
      sent: false;
      error: string;
      code?: string;
      gate?: Exclude<GateAnswer, { state: "free" | "go" }>;
    };

/** Each file is a stream: Workers RPC sends a stream beside its 32 MiB call limit, and capnweb sends
 *  one chunk a message. */
export type ReceivedEmail = {
  events: StreamEventInput[];
  files: { path: string; contentType: string; size: number; data: ReadableStream<Uint8Array> }[];
};
