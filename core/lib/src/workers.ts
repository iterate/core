// Types, and the few names two Workers must share: no Worker imports another Worker's code.
import type { ActRule, GateAnswer } from "./acts.ts";
import type {
  ControlPlaneSessionApi,
  SecretBodyField,
  SecretOperation,
  SecretProxy,
  SecretRefresh,
  StackClientName,
  TelemetryRows,
} from "./api.ts";
import type { EmailHookArgs } from "./email.ts";
import type { Facts } from "./facts.ts";
import type { Lender, Principal, SignInMethod } from "./principal.ts";
import type { Envelope, Statement } from "./signed.ts";
import type { StreamEvent, StreamEventInput } from "./stream/processor.ts";

/** WHO A SESSION OF THE CONTROL PLANE'S API IS, as the boundary learned it at `authenticate`
 *  (./api.ts `ControlPlaneApi`). The mind gets this and never the credential: a mind that held a
 *  member's token could use it again. A member comes with a principal, and with the grant that
 *  the token acts through (a browser's session cookie has none). A key comes as its `Lender`. */
export type ApiCaller = { principal: Principal; grant?: string } | { lender: Lender };

export interface MindTarget {
  /** The mind trusts the boundary's stamp because only the boundary can reach it. */
  fetch(request: Request): Promise<Response>;
  /** THE MIND'S OWN API FOR ONE SESSION OF `who`, which the boundary hands to its client as
   *  `session.mind`: for a member the mind's root context, `/` (./api.ts `IterateContextApi`), and
   *  for a key the one lend that it may make. The answer is a capability, held as a Workers RPC
   *  stub: letting go of it ends what the session lent. */
  api(who: ApiCaller): unknown;
  /** Idempotent by each event's `idempotencyKey`. `fromAuth`: the events are the auth Worker's own
   *  answer, so the `source.signer` one names is the key the auth Worker verified. In any other
   *  call an event's signer is dropped. */
  append(path: string, events: StreamEventInput[], fromAuth?: boolean): Promise<void>;
  /** A redelivery records nothing new. */
  receiveEmail(mail: ReceivedEmail): Promise<void>;
  /** THE CONFIG'S `email` HOOK FOR ONE DELIVERY, after `receiveEmail` took the mail (iterate/sdk
   *  `IterateConfigEntrypoint.email`). `forward` is a capability that the boundary made for this
   *  delivery and that dies with it: a function, which Workers RPC and capnweb each pass as a stub,
   *  and which each hop wraps again in a function of its own (core/boundary-worker/src/mail.ts).
   *  The mind records what the hook did: a throw, or a config with no `email`, is an
   *  `email/hook-failed` fact, never this call's failure. It throws only when the mind could not
   *  be reached or could not record. */
  email(args: EmailHookArgs): Promise<void>;
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
  /** Always true for the API, the MCP server and the right to hand in the mind
   *  (./mind-api.ts `mindProvideConnectResourceOf`); a mind hostname's token answers for anyone
   *  signed in. False for a key's token. */
  member: boolean;
  /** How the person signed in, whose session got the token's grant. A key's token has none: it is
   *  no person's. */
  method?: SignInMethod;
  /** The name a guest typed (`method` "guest"), which is all a guest has: their `principal` has no
   *  email. Absent for everyone else. */
  name?: string;
  /** The mind that vouched for the person (`method` "mind"; iterate/principal `MindPerson`): its
   *  id, its control-plane hostname and the person's user id there. Absent for everyone else. */
  mind?: { id: string; hostname: string; userId: string };
  /** A KEY'S TOKEN, never a person's (core/auth-worker/src/key-tokens.ts): the one capability name
   *  it may lend to the mind as `itx.<provide>`. It is live for the API alone, where it reaches
   *  that lend and nothing else of the mind. `principal.actor` is the key's service and `grant`
   *  is `key:<the key's id>`. */
  provide?: string;
};

export interface Door {
  /** A request for a hostname of one of the mind's own zones is answered in the boundary: the
   *  global `fetch` fails inside a zone. */
  fetch(request: Request): Promise<Response>;
  secret: SecretCall;
  listSecrets: SecretsService["listSecrets"];
  cloud: SecretsService["cloud"];
  hasStackClient: SecretsService["hasStackClient"];
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
  proposeStatement: AuthService["proposeStatement"];
  /** A statement for another mind, signed with this mind's key (`AuthService.sign` with `mind`):
   *  never one for the Cloud, which reads a statement with no `from`. */
  signForMind(
    input: Parameters<AuthService["sign"]>[0] & { mind: string },
  ): ReturnType<AuthService["sign"]>;
  /** `request`, signed for the mind `signFor`. Called for the built-in fetch's `signFor`
   *  (core/itx/src/context/built-ins.ts), which `itx.minds.get(hostname).fetch` asks for; a
   *  provided mind's Door and the home lab relay it for the mind that they are. */
  fetchForMind(signFor: string, request: Request): Promise<Response>;
  /** The mind's telemetry, through the telemetry Worker (`TelemetryService`). */
  queryTelemetry(sql: string, hours?: number): Promise<TelemetryRows>;
  sendEvents(events: StreamEvent[]): Promise<void>;
  writeMetrics(points: MetricPoint[]): Promise<void>;
}

/** As workers-types' `AnalyticsEngineDataPoint` spells it. */
export type MetricPoint = { indexes?: string[]; blobs?: string[]; doubles?: number[] };

/** It holds the warehouse's tokens, so the mind, which may be hostile, never holds one. A mind
 *  that made its tables itself holds a token of its own: for it the cut of a query is a
 *  convenience, not a boundary (core/configs/default/telemetry.ts). */
export interface TelemetryService {
  /** `hours` is 24 by default and at most 720; at most 1,000 rows. */
  query(sql: string, hours?: number): Promise<TelemetryRows>;
  sendEvents(events: StreamEvent[]): Promise<void>;
  /** For a mind with no metrics binding of its own, a home lab's. */
  writeMetrics(points: MetricPoint[]): Promise<void>;
}

/** ONE AUTHENTICATED SESSION OF THE CONTROL PLANE'S API, whole (./api.ts `ControlPlaneSessionApi`
 *  is what a client of a mind reads of it). What it offers follows from what its credential is
 *  for (./api.ts `ControlPlaneApi.authenticate`):
 *
 *      a member's token, or a member's cookie    `mind`, as that member
 *      a key's token                             `mind`, the key's one lend
 *      the token of the right to hand in a mind  `provideExternalMind`, and nothing else
 */
export interface ControlPlaneSession extends ControlPlaneSessionApi {
  /** THE MIND RUNS ELSEWHERE AND HANDS IN HOW TO REACH IT. Only a token of that right calls it
   *  (./mind-api.ts `mindProvideConnectResourceOf`), on a session whose dial said so
   *  (./mind-api.ts `MIND_PROVIDE_EXTERNAL_MIND_HEADER`). The boundary calls `connect(door)`
   *  once and sends every request, mail, act and session of the mind to the `MindTarget` that it
   *  answers, until the session ends, which it does when the token does. A newer session's call
   *  takes the mind over. `door` is the function's for its call alone: `door.dup()` keeps it. */
  provideExternalMind(connect: (door: Door) => MindTarget): void;
}

/** THE CLOSE CODE OF A SESSION WHOSE MIND ANOTHER SESSION TOOK OVER (`provideExternalMind`
 *  of a newer one), from the range that RFC 6455 section 7.4.2 leaves for private use. The
 *  process that gets it does not dial again: two that did would end each other's link, and every
 *  visitor's socket with it, about once a second. */
export const MIND_TAKEN_OVER_CLOSE_CODE = 4001;

export interface AuthService {
  fetch(request: Request): Promise<Response>;
  /** RFC 8707: a token is for one resource. Null when it is not live for `resource`, or, for any
   *  resource but a hostname, when its person is no member now. */
  whoIs(token: string, resource: string): Promise<TokenIdentity | null>;
  /** A public client whose one redirect is `https://<host>${HOST_SESSION_PREFIX}callback`. Refused
   *  for a host outside the mind's zones, and for the control-plane hostname. */
  hostClient(host: string): Promise<string>;
  isMember(email: string): Promise<boolean>;
  /** `cookie` is the request's `Cookie` header on the issuer's origin; null when signed out.
   *  `expiresAt`: when the browser's session ends, in Unix seconds, as a token's. */
  browserSession(cookie: string | null): Promise<{
    userId: string;
    email: string;
    member: boolean;
    method: SignInMethod;
    expiresAt: number;
  } | null>;
  /** The mind's identity log as `GET /.well-known/iterate` answers it on `hostname`
   *  (./mind-identity-log.ts `PublishedLog`), for the boundary, which answers that path itself on
   *  a hostname of the mind's own code: 404 unless the log's last record lists `hostname`.
   *  `after`: the hash of the record that the answer starts after, or null for the whole log. */
  identityLog(hostname: string, after: string | null): Promise<Response>;
  /** THE IDENTITY FACTS THAT `/` DOES NOT HOLD YET, as the auth Worker's rows say: the accepted
   *  records of every mind id, each id's in the order of its log, then the refusals. A few at
   *  a time. FOR THE BOUNDARY ALONE, as is the call below: it appends each fact's event on `/`
   *  and then says so. Nothing in the auth Worker waits for that: a record is accepted, and
   *  the stack may sign, by the rows alone. No Door method reaches either call, so no mind's own Worker, and no mind
   *  that runs elsewhere, can say what is stored. */
  identityFactsToDeliver(): Promise<IdentityFact[]>;
  /** The events of these facts are stored on `/`: the boundary's append of them has resolved. */
  identityFactsDelivered(ids: string[]): Promise<void>;
  /** A statement counts once: a second `verify` of it is refused. Its `path` and `type` are the
   *  business of whoever acts on it. */
  verify(envelope: Envelope): Promise<Verified>;
  /** Signed with the stack's ML-DSA-65 working key, and refused until the mind's identity lists
   *  it. `expiresInSeconds`: five minutes by default, a day at most. `verify` never takes the
   *  result: it is for others, who read the key at
   *  `GET https://<controlPlaneHostname>/keys/stack.json`. `mind`: the
   *  mind the statement is for, which then names this mind as `from`. Without it, the statement's
   *  `mind` is this mind's own control-plane hostname, as the Cloud reads it. */
  sign(input: {
    mind?: string;
    path: string;
    type: string;
    payload?: Record<string, unknown>;
    about?: string[];
    expiresInSeconds?: number;
  }): Promise<Envelope>;
  /** WHO SENT A MIND'S SIGNED REQUEST, or why it is refused (core/auth-worker/src/mind-fetch.ts):
   *  `statement` is its `iterate-auth-statement`, `method` and `url` the request's as it arrived. */
  mindOfSignedRequest(input: {
    statement: string;
    method: string;
    url: string;
  }): Promise<
    | { principal: { actor: string; kind: "mind"; hostname: string }; expiresAt: number }
    | { refused: string }
  >;
  /** A statement that waits a day for a member's passkey at `signAt`, a page that needs no
   *  sign-in. Signed, it lands on `path` as `POST /statements` takes it. `from`: the context that
   *  asks, as the page shows it; `next`: where the page goes once signed, a host of the mind.
   *  `signerEmail`: the one person who signs; a non-member signs at `/people/<address>` alone.
   *  `by`: who asked, as the platform stamped the call (`ProposedBy`). */
  proposeStatement(input: {
    path: string;
    type: string;
    payload?: Record<string, unknown>;
    from?: string;
    by?: ProposedBy;
    signerEmail?: string;
    next?: string;
  }): Promise<{ draft: string; signAt: string; expires: number }>;
}

/** WHO ASKED FOR A STATEMENT, as the platform stamped the call that proposed it (core/itx
 *  `Caller`): a member, a signed-in person who is no member, a guest, another mind, or `code`,
 *  the mind's own code with nobody's call behind it (an agent's own turn, a schedule). None of
 *  these is the caller's own word, but a guest's `name` is what the guest typed, and a mind's
 *  `hostname` is a label. */
export type ProposedBy =
  | { kind: "member"; email?: string }
  | { kind: "person"; email: string }
  | { kind: "guest"; name: string }
  | { kind: "mind"; hostname: string }
  | { kind: "code" };

/** One fact of the mind's identity on its way to `/`: the event to append there as the platform,
 *  and the id by which the auth Worker is told that it is stored. `mind`: an accepted record's
 *  mind id. The facts of one mind id come in the order of its log, and `/` folds a record only
 *  after the one before it, so none of them is appended after one that could not be. A
 *  refusal has no place in an order, and no `mind`. */
export type IdentityFact = { id: string; mind?: string; event: StreamEventInput };

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
  /** The iterate Cloud's client that brokers the secret's refresh, by the Cloud's name for it,
   *  and that Cloud's origin, which the secret has kept since it was made. */
  cloud?: string;
  cloudOrigin?: string;
  public?: Record<string, string>;
  placement?: "header" | "url";
  operations?: SecretOperation[];
  /** Null is every path, as for an import. */
  lendTo?: string[] | null;
  statementPaths?: string[];
  bodyFields?: SecretBodyField[];
  /** Why a secret that the stack makes at its deploy is not set: the deploy's words
   *  (core/secrets-worker src/stack-secrets.ts). */
  reason?: string;
  proxy?: SecretProxy;
  /** A secret by proxy whose cell does not open: no `proxy` is shown. */
  byProxy?: true;
  unreadable?: string;
};

export type SecretOAuthResult =
  | { status: "pending" }
  | { status: "complete"; scopes: string[]; account?: { id: string; name: string | null } }
  | { status: "declined" | "failed"; error: string }
  | { status: "unavailable" };

/** The secret's object refuses a verb not on the list, and checks each input, which arrives untyped. */
export type SecretVerbs = {
  /** The options, with `material` beside them. */
  set: { input: unknown; answer: SecretAnswer<{ path: string }> };
  delete: { input: undefined; answer: SecretAnswer<{ path: string }> };
  /** ./api.ts `secrets.deleteIfProxy` says when it deletes. */
  deleteIfProxy: { input: undefined; answer: SecretAnswer<{ path: string; deleted: boolean }> };
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
  signStatement: { input: unknown; answer: SecretAnswer<Envelope> | SecretRefusal };
  seal: { input: unknown; answer: SecretAnswer<string> | SecretRefusal };
  unseal: { input: unknown; answer: SecretAnswer<string> | SecretRefusal };
  generateSigningKey: {
    input: unknown;
    answer: SecretAnswer<{ path: string; publicKey: string; keyId: string }>;
  };
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
   *  secret that was deleted. */
  listSecrets(): Promise<SecretDescription[]>;
  /** THE ITERATE CLOUD AT `origin` (an exact `https:` origin, no path), and the clients that
   *  Cloud publishes, by name: what `beginOAuth(path, { client: { cloud, origin } })` can go
   *  through. The caller names the Cloud: no config of the stack does. No client when the Cloud
   *  gave no list. */
  cloud(origin: string): Promise<{ origin: string; clients: string[] }>;
  /** Always false: the stack makes no OAuth client at Cloudflare (./api.ts `hasStackClient`). */
  hasStackClient(name: StackClientName["stack"]): Promise<boolean>;
  /** THE PERSONS' GRANTS THAT THE ITERATE CLOUD BROKERS, REFRESHED ON WORD, whichever client of
   *  the Cloud a grant is of: one row for each, and the facts for the mind's log.
   *  core/secrets-worker/src/grant-refresh.ts says why these grants need a refresh on word. One
   *  call refreshes twenty grants at most, by path, and answers `next` when there are more: the
   *  caller calls again with it as `after`, so every grant is reached. */
  refreshGrants(after?: string): Promise<SecretAnswer<GrantsRefreshed>>;
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

/** `from` must be one address at a zone of the mind. */
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
