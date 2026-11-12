// api.ts — THE API AN APP DIALS: the shapes of a mind's `/api` session and a context's surface, as
// a capnweb client sees them. DECLARED here, never generated, and never the platform's classes:
// core/itx serves a context as `IterateContextRpcTarget` (core/itx/src/iterate-context.ts, served
// by core/itx/src/session.ts), so an app built against this package types against what the
// deployment answers. A context
// has ONE method — `invoke(call, ...args)`, a dotted itx expression — and a capnweb stub proxies the
// dotted spelling (`itx.repos.get(path).readFile(file)`) onto it. THIS FILE IS THE SOURCE OF TRUTH
// for every root app code reaches: core/itx derives its built-in record's type from these members
// (core/itx/src/context/built-ins.ts `BuiltInScope`), so a root or a verb the platform
// implements and this file does not declare — or declares differently — fails to typecheck there.
// The roots installed apps add are NOT here: each app registers its own on `InstalledAppRoots` from
// its package, and `IterateContextApiWith` spells a context that has them.

import type {
  Ai,
  AiGatewayLog,
  AiGatewayPatchLog,
  AIGatewayUniversalRequest,
  AiWebSearchRequest,
  ConversionRequestOptions,
  ConversionResponse,
  ImageDrawOptions,
  ImageInfoResponse,
  ImageInputOptions,
  ImageOutputOptions,
  ImageTransform,
  ImageTransformationOutputOptions,
  ImageTransformationResponseOptions,
  R2HTTPMetadata,
  R2Range,
  SupportedFileFormat,
  TextOptions,
  UniversalGatewayOptions,
} from "@cloudflare/workers-types";
import type { InvokeHandle, ItxExpression, ItxExpressionInput } from "./expression.ts";
import type { ActRule } from "./acts.ts";
import type { Principal } from "./principal.ts";
import type { StreamEvent, StreamEventInput } from "./stream/processor.ts";

/** One page of a context's durable log (`readEvents`). */
export interface StreamPage {
  events: StreamEvent[];
  scannedThroughOffset: number;
  /** True iff the scan reached the durable mark: nothing more to read until the next commit. */
  atHead: boolean;
}

/** `waitForEvent`'s filter: an event type (or one of a list), payload fields the event must carry
 *  with exactly these values (each a JSON primitive, compared with `===`), a floor, a timeout. With
 *  an explicit `afterOffset` the log after it is searched first, so a match that already landed
 *  answers at once. */
export type WaitForEventFilter = {
  type?: string | string[];
  payload?: Record<string, string | number | boolean | null>;
  afterOffset?: number;
  timeoutMs?: number;
};

/** The `rewrite-rule-configured` event's payload — what `itx.append` writes durably and `provide`
 *  writes for its session: make `match` mean `target` (an expression, or `null` to deny). `description` is the one
 *  line a model reads for the name; it rides the row into `rewriteRules.list()`. */
export type RewriteRuleConfigured = {
  match: ItxExpressionInput;
  target: ItxExpressionInput | null;
  /** What the name means here, in one line (≤ 500 chars). */
  description?: string;
};

/** One row of `rewriteRules.list()` — the tree a context can spell. `context` is the path the row
 *  was read from: this context for its own rows and its implicit rows, the target context for the
 *  rows a bare hop row (`itx ⇒ itx.builtins.cd(path)`) reaches. A mask lists as `target: null`. */
export type RewriteRuleListEntry = {
  match: string;
  target: string | null;
  description?: string;
  context: string;
};

/** One row of `subscriptions.list()` / `processors.list()`. */
export type SubscriptionListEntry = {
  name: string;
  target: string;
  consumes?: string[];
  configuredAtOffset: number;
  afterOffset?: number;
  /** `false`: a FAN-OUT row — one event per call, in any order, each event retried on its own and
   *  dead-lettered alone (`itx/subscription-delivery-failed`). Its `cursor` is how far it has
   *  admitted events, `pending` how many events wait for a retry, and `paused` whether new events
   *  wait for the receiver (it failed the last few distinct events: one new event is let through at
   *  each rung of the row's own probe). */
  ordered?: false;
  pending?: number;
  paused?: boolean;
  /** Set on a copy row (one subscribed with an `EventCopyTarget`): which events it copies, and the
   *  target as it was written. Its `target` is then `itx.cd(path)`, which only checks that this
   *  context's rules still let it reach `path`. */
  filter?: string;
  copy?: EventCopyTarget;
  /** Set when this row hosts a facet (a processor). `restarts`: how many times the platform failed
   *  the facet at its start and the context restarted it under a fresh loaded identity (a platform
   *  defect the context works around; the count is the cheap way to ask "how often, here"). */
  hostedFacet?: {
    name: string;
    className: string;
    cacheKey?: string;
    mainModule?: string;
    /** The worker's name when the source is one (`FacetSpec`): any other source is not listed. */
    source?: unknown;
    restarts: number;
  };
  /** Set for a row the context delivers at-least-once (an itx expression target; a facet and a lent
   *  stub own their progress): the offset the last acked call confirmed, the retry ladder's attempt
   *  and when the next attempt is due. */
  cursor?: { confirmedOffset: number; attempt: number; nextAttemptAtMs?: number };
  /** Set once delivery exhausted its retries: the offset it stopped after, and why. */
  halted?: { afterOffset: number; attempts: number; error?: string };
};

/** A `subscribe` target that copies each event onto the log of the context at `path`. `type`
 *  replaces the event's type in the copy, and can't be an `itx/*` type, since a copy is never one of
 *  the platform's own events. `payload` is a JSONata expression evaluated against the original
 *  event, and the JSON object it answers is the copy's payload, for example
 *  `{ "title": $substring(payload.title, 0, 120) }`. Without it the copy's payload is empty: name
 *  the fields to keep, or write `payload` to keep them all. Quote keys as in JSON: an unquoted key
 *  is a path into the event. */
export type EventCopyTarget = { path: string; type?: string; payload?: string };

/** A loaded worker's source: its modules, literally, or an itx expression that produces them (then
 *  `cacheKey` names the build, and the caller owns "same key ⇒ same code"). */
export type WorkerSource = Record<string, string> | ItxExpressionInput;

/** What hosts a class as a durable facet — `facets.get(name, spec)`, `processors.enable(name, spec)`.
 *  `source` is the code (its modules, or an expression that produces them under `cacheKey`), or —
 *  an expression with NO `cacheKey` — the NAME of a loaded worker: one that resolves, as a call
 *  would, to `itx.builtins.workers.get(spec)` in the table of the context whose rule it is
 *  (`itx.cd('/').config`, the mind's published config). The facet loads that worker's source,
 *  its producer run with that context's authority. `mainModule` names the module of the source that
 *  exports `className` when it is not the source's entry (`agents.ts` of a config repo whose entry
 *  is `worker.ts`): the facet runs that module's own graph, and — named by the mind's published
 *  config — restarts in place, storage kept, only when that module's identity changes, never onto
 *  an older publication. */
export type FacetSpec = {
  source: WorkerSource;
  cacheKey?: string;
  className: string;
  mainModule?: string;
};

/** What `schedules.set` answers: the definition's identity, to cancel exactly it. */
export type ScheduleReceipt = { key: string; scheduledAtOffset: number };

/** A schedule's key: a string, or a pair that scopes a local key to its owner (a facet instance). */
export type ScheduleKey = string | [string, string];

/** When a schedule fires: at an instant (ISO, with offset), after a delay, or on an interval (at
 *  least a second; missed ticks coalesce). */
export type ScheduleWhen = { at: string } | { afterMs: number } | { everyMs: number };

/** What `schedules.set` takes: the key, when, and the events (one to a hundred) each occurrence
 *  appends — an event's type, payload and metadata only: identity and provenance are the firing's. */
export type ScheduledAppendInput = {
  key: ScheduleKey;
  when: ScheduleWhen;
  events: Pick<StreamEventInput, "type" | "payload" | "metadata">[];
};

/** One live schedule as `schedules.list()` / `get(key)` answer it: the definition (its key
 *  normalized to a string), when it fires next, the offset of the fact that set it, who set it, and
 *  the last failure until it is replaced or cancelled. */
export type ScheduledAppend = {
  key: string;
  when: ScheduleWhen;
  events: Pick<StreamEventInput, "type" | "payload" | "metadata">[];
  nextAt: string;
  scheduledAtOffset: number;
  source?: StreamEventInput["source"];
  failure?: { error: string; offset: number };
};

/** A secret's material: one string (`getSecret("/secrets/<name>")` is the whole value) or a JSON
 *  object whose string fields `getSecret("/secrets/<name>", { field: "a.b" })` picks — the
 *  multidimensional shape a credential exchange needs (`{ username, password, accessToken }`,
 *  `{ clientId, clientSecret, refreshToken, accessToken }`). A string is always the one value: it has
 *  no fields, whether or not it parses as JSON. */
export type SecretMaterial = string | Record<string, unknown>;

/** How a token endpoint wants the client credential — the RFC 8414 `token_endpoint_auth_methods_supported`
 *  registry values, so a provider's discovery document pastes straight in: `client_secret_basic`
 *  (HTTP Basic — Google, Slack, the petshop; the default), `client_secret_post` (`client_id` +
 *  `client_secret` as form fields — GitHub, Linear), `none` (a public client: `client_id` alone,
 *  PKCE stands in for the secret). RFC 6749 §2.3.1 forbids sending two forms at once. */
export type ClientAuth = "client_secret_basic" | "client_secret_post" | "none";

/** How the secret's facet re-mints an expired credential, in its own trusted code: the
 *  exchange reads this secret's own material, POSTs to an endpoint within the pin, and writes the
 *  answer back into the material — `accessToken` (and a rotated `refreshToken`). Triggered on a 401
 *  from the pinned host, and on first use when the placeholder's field is not there yet. */
export type SecretRefresh =
  /** RFC 6749 §6, the refresh_token grant: `refreshToken` + `clientId` (+ `clientSecret` for a
   *  confidential client) from the material → `accessToken` (+ the newest `refreshToken`). Google,
   *  GitHub, an MCP server's authorization server, the petshop fixture. With `client`, the client is
   *  the deployment's own app at the provider (an integration connected through it): the material
   *  holds the tokens alone, and the refresh attaches the client's credentials inside the facet. */
  | {
      kind: "oauth-refresh-token";
      tokenEndpoint: string;
      clientAuth?: ClientAuth;
      /** `cloud`: the client is iterate Cloud's of that name, and `tokenEndpoint` is the Cloud's
       *  broker, which adds the client secret. The refresh token in the material is sealed for
       *  this deployment and means nothing anywhere else. */
      client?: { platform: IntegrationProvider } | { cloud: string };
    }
  /** A GitHub App installation's token (`POST <apiOrigin>/app/installations/<id>/access_tokens`
   *  with an App JWT) → `accessToken`, minted on first use and on a 401. The App is iterate Cloud's
   *  (`{ cloud }`) or one whose `appId` and `privateKey` the material holds (`{ mind: "github" }`,
   *  and `{ platform: "github" }` the same way); either of those two fields may be a
   *  `getSecret("/secrets/<name>", { field })` placeholder naming another of the owner's secrets
   *  pinned to `apiOrigin`, so one secret holding the App's key serves every installation's
   *  secret. */
  | {
      kind: "github-app-installation";
      apiOrigin: string;
      installationId: string;
      /** `cloud`: iterate Cloud's GitHub App of that name, whose key stays at the Cloud. The Cloud
       *  mints the token, for an installation this deployment connected. */
      client: { platform: "github" } | { mind: "github" } | { cloud: string };
    }
  /** EXCHANGE CODE: `source` is one ES module exporting `async function exchange(material, fetch)`,
   *  which logs in (any vendor's shape: a CSRF form and its cookie, a GraphQL mutation) and returns
   *  the NEXT material — keep what the next login needs (`{ ...material, accessToken }`). It runs
   *  only on first use and on a 401, in a jail the secret's facet loads: no bindings, `fetch` (the
   *  argument and the global alike) reaches the secret's pinned origins and nothing else — a
   *  request anywhere else fails the refresh — and `console` is silenced. Only the returned object
   *  is kept. The source is part of the record, so changing it is a `set` like the material's. */
  | { kind: "worker"; source: string };

/** A SECRET'S SEALED CELL — what every fact that writes material carries (`secret/set`, a
 *  `secret/refreshed` that minted, `secret/resealed`): the record with its material sealed under
 *  the deployment's secrets key and bound to this one secret and write
 *  (core/secrets-worker/src/secret-at-rest.ts says how, and what opens it). The log is the secret:
 *  a backup of it and the key is everything. `itx.cd(path).facets.get("secret").snapshot()` answers
 *  the current one as `state.material.sealed`. */
export type SealedSecretCell = {
  /** The secret's context name (its Durable Object's), the first part of the cell's binding. */
  context: string;
  urls: string[];
  refresh: SecretRefresh | null;
  /** The workspace whose iterate's-Slack-app token this is, kept with the record. */
  routedAccount?: { provider: "slack"; externalId: string };
  /** Minted for this write: the last part of the binding. */
  nonce: string;
  material: { algorithm: "AES-256-GCM+SECRET-V1"; iv: string; ciphertext: string };
};

/** A secret's catalog entry — `secrets.list()` — its path, the pin, the strategy's KIND, when it
 *  was first set and its public fields; never a secret value (the owner root's fold of the
 *  `secret/set` certificates). */
export type SecretCatalogEntry = {
  path: string;
  urls: string[];
  refresh?: SecretRefresh["kind"];
  /** For exchange code (`refresh.kind` "worker"): the SHA-256 of its source, hex — which code it is. */
  refreshSourceSha256?: string;
  createdAt: string;
  /** The material's public fields (`set`'s `public`, a collection form's public parts), by name:
   *  an OAuth client's `clientId` beside the secret that holds its `clientSecret`. */
  public?: Record<string, string>;
  /** A path that forwards every use to a secret elsewhere, as a lend of the old platform left it:
   *  whose, under which lend, and the connection it is. packages/mind-backup reads it. */
  borrowed?: {
    lendId: string;
    lender: { userId: string; email?: string } | { instance: true };
    integration?: { provider: string; account: string; externalId: string };
  };
};

/** THE OPERATIONS a secret may answer, the vault used as a signer: none unless the secret is made
 *  with them (`SecretUses.operations`). */
export const SECRET_OPERATIONS = [
  "signHmac",
  "verifyHmac",
  "verifyEquals",
  "deriveSharedSecret",
  "publicKeyOf",
  "signWithKey",
] as const;
export type SecretOperation = (typeof SECRET_OPERATIONS)[number];

/** WHAT A SECRET MAY BE USED FOR, fixed when it is made, kept by the secrets Worker and shown to the
 *  person who gives it on the collection form or the OAuth start page: the mind's code cannot
 *  widen it later. */
export type SecretUses = {
  /** Where its placeholder may sit in a request: in a header (`"header"`, the default; a `Basic`
   *  credential is a header), or also in the URL (`"url"`, a Telegram bot token in the path). */
  placement?: "header" | "url";
  /** The operations it answers (`SECRET_OPERATIONS`). Default: none. */
  operations?: SecretOperation[];
  /** The secrets whose refresh may borrow its material, by path: as a client secret or a GitHub
   *  App's key that their refresh names with `getSecret("/secrets/<name>", { field })`. Default:
   *  none. */
  lendTo?: string[];
};

/** The input an agent gives `itx.secrets.collectFromUser`: the write-only secret path, the
 * origins its material may reach, what the collection page shows the person, and, for a secret of
 * several parts, one field each. `description` is markdown: say where the value comes from, with
 * links (they open in a new tab). */
export type CollectSecretInput = {
  path: string;
  egress: { urls: string[] };
  description?: string;
  /** One input per field, saved as one JSON secret `{ [name]: value }`, whose parts are then
   *  `getSecret(path, { field: name })`: an OAuth app's `clientSecret` (which `beginOAuth` takes as
   *  a placeholder), a webhook's `signingSecret`. Without it, one Value. */
  fields?: CollectSecretField[];
  /** Where the page sends the person once the secret is saved, as an OAuth redirect does: an
   *  absolute http(s) URL without credentials, such as the mind's page that asked. The page
   *  shows its host before the person saves. Without it, the page says the tab can close. */
  redirectUrl?: string;
  /** Whoever holds the link may fill the form, signed in or not; the page says so. Without it, only
   *  a member of the mind, signed in. */
  anyoneWithLink?: boolean;
} & SecretUses;

/** One part of a secret a collection page asks for: its name in the JSON secret
 *  (`[A-Za-z_][A-Za-z0-9_]*`), the label the person reads, whether its value is several lines
 *  (a PEM private key), and whether it is PUBLIC. A public part is no secret (an OAuth client's
 *  ID, a GitHub App's ID and slug): it is entered on the same form as the parts that are, and the
 *  catalog answers its value (`SecretCatalogEntry.public`), so the code that needs it reads it
 *  there and keeps no copy. `placeholder` and `pattern` are the input's (HTML's `pattern`
 *  attribute: the whole value must match; it is compiled with the `v` flag). */
export type CollectSecretField = {
  name: string;
  label: string;
  multiline?: boolean;
  public?: boolean;
  placeholder?: string;
  pattern?: string;
};

/** A secret collection link. Sending this asks the person to authenticate to the intended
 * Iterate instance; it is not itself permission to write a secret. */
export type CollectSecretLink = { path: string; url: string };

/** What `secrets.verifyHmac(path, input)` checks: the bytes the provider signed (a string is its
 *  UTF-8 bytes), the hex HMAC-SHA256 it sent (either case, the scheme's prefix — `sha256=`, `v0=` —
 *  stripped), and which field of a JSON material is the key (the whole material when omitted).
 *  Stripe signs `${t}.${body}`, GitHub the body, Slack `v0:${t}:${body}`: the caller assembles them. */
export type SecretHmacVerification = {
  payload: string | Uint8Array;
  signature: string;
  field?: string;
};

/** What `secrets.signHmac(path, input)` signs: the bytes to sign (a string is its UTF-8 bytes),
 *  which field of a JSON material is the key (the whole material when omitted), and how the
 *  signature is written: `hex` (the default) or `base64`. X's webhook check wants
 *  `sha256=<base64>` of its `crc_token`. */
export type SecretHmacSigning = {
  payload: string | Uint8Array;
  field?: string;
  encoding?: "hex" | "base64";
};

/** What `secrets.verifyEquals(path, input)` checks: the candidate string a request presented (a
 *  static header token, say), and which field of a JSON material is the secret (the whole
 *  material when omitted). */
export type SecretEqualsVerification = {
  value: string;
  field?: string;
};

/** EVERY PROVIDER AN INTEGRATION CONNECTS, spelled once: a connection to one is the log
 *  `/integrations/<provider>/<connection>` and the secret `/secrets/<provider>-<connection>`. The
 *  kinds below are read off it. */
export const INTEGRATION_PROVIDERS = ["slack", "google", "cloudflare", "github", "x"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** Each provider's name as a person reads it, wherever a page or a message names one. */
export const INTEGRATION_PROVIDER_NAMES = {
  slack: "Slack",
  google: "Google",
  cloudflare: "Cloudflare",
  github: "GitHub",
  x: "X",
} as const satisfies Record<IntegrationProvider, string>;

/** The providers an integration connects through OAuth (`/api/integrations/<provider>/callback`):
 *  GitHub's connect is its App's install instead. */
export type OAuthIntegrationProvider = Exclude<IntegrationProvider, "github">;

/** The providers a person signs in with, each through iterate's app there. */
export type SignInProvider = Exclude<IntegrationProvider, "slack" | "x">;

/** Whose OAuth app a secret's `beginOAuth` goes through when it is not a client passed in the
 *  clear: the deployment's own at that provider (an integration connected through it), or one of
 *  iterate Cloud's by its name there (`github`, `google`, `x`), the app every deployment shares.
 *  The Cloud keeps that app's secret and adds it to the exchange and to each refresh; the tokens
 *  stay in this secret. */
export type SecretOAuthClient =
  | { platform: OAuthIntegrationProvider }
  | {
      cloud: string;
      /** For a GitHub App of the Cloud's: the accounts (a person's or an organization's login)
       *  whose installations this mind asks to be connected to. The member's consent reaches
       *  every account they administer; the mind gets the events and the installation tokens
       *  of these alone, and the Cloud's page names them before the member approves. With none
       *  named it gets no installation, unless `install: true` sends the member to the App's
       *  install page, where the one they choose is connected. */
      accounts?: string[];
    };

/** What `secrets.beginOAuth(path, options)` takes: the provider's two endpoints, the OAuth client
 *  (the mind's own in the clear, or an integration's `client`), the scope, the pin, and any extra
 *  authorize parameters the provider needs (Google: `access_type=offline`, `prompt=consent`). */
export type SecretOAuthOptions = {
  /** The provider's two endpoints. Absent with a Cloud client, which names them, the client's id
   *  and the pin itself. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** Exactly one of `clientId` and `client`. */
  clientId?: string;
  /** Absent for a public client (PKCE alone), and with `client`. The secret itself, or one
   *  placeholder naming the secret that holds it — `getSecret("/secrets/<name>")`, or
   *  `getSecret("/secrets/<name>", { field: "a.b" })` — so it never passes through your hands:
   *  collect it with `collectFromUser` into a secret pinned to the token endpoint's origin. The
   *  platform reads it from there at the code exchange and at every refresh, and stores only the
   *  placeholder, so rotating that secret takes effect at the next refresh. `beginOAuth` refuses
   *  a placeholder that names no such secret. */
  clientSecret?: string;
  client?: SecretOAuthClient;
  /** Where the platform's callback sends the human once the tokens are stored: an absolute URL on
   *  the platform's origin or the Dash's, or a page of this mind's, `{ routingSlug?, path }`:
   *  `routingSlug`'s host (the apex when absent) at `path` (a query is fine), composed by the
   *  deployment's static rules alone — on the hostname its config pins to the mind when it has
   *  one, else under its ingress — so it is the mind's own by construction. That page reads what
   *  the consent granted with `oauthResult`. Every attempt comes back to the platform's callback
   *  first (`oauthCallbackUrl`, the redirect URI to register for a client of your own), which
   *  completes it only in the browser that opened the start link. */
  next?: string | { routingSlug?: string; path: string };
  /** The one person who may complete the attempt, by their user id (`user_…`), when they need not
   *  reach this secret's owner: a customer of the mind's own app connecting their own account,
   *  whom the mind knows from a sign-in with this platform. The platform's callback then
   *  completes the attempt only in a browser signed in as that person, in place of one that reaches
   *  the owner; a member who is not that person is refused like anyone else. Only for a mind's
   *  secret, and only with a client of your own (`clientId`): the deployment's app is consented to
   *  by someone who reaches the owner. */
  completedByUserId?: string;
  /** How the token endpoint wants the client credential. */
  clientAuth?: ClientAuth;
  scope?: string;
  /** The origins the tokens may be sent to; defaults to the token endpoint's, which it must include. */
  urls?: string[];
  extra?: Record<string, string>;
  /** The account the tokens must be for — an existing connection's, asked for more: the provider's
   *  id for it (a Slack team, an OpenID `sub`), read off the token response, or off `account`'s
   *  endpoint when given. Another account's tokens are refused before anything is stored. */
  expectAccount?: string;
  /** Where the provider names the account the new tokens are for, when its token response does
   *  not (X; any provider without an ID token): a JSON endpoint within `urls`, which the secret's
   *  facet calls once with the new access token before anything is stored, and the paths of the
   *  account's id and, when it has one, its name (`data.id`, `data.username`). `completeOAuth`
   *  answers the account, and `expectAccount` is checked against its id. Not with `client`: the
   *  deployment's app names its own accounts. */
  account?: { url: string; id: string; name?: string };
  /** Whoever holds the start link may consent, signed in or not; the page says so. Without it, only
   *  a member of the mind, signed in. */
  anyoneWithLink?: boolean;
} & SecretUses;

/** An `R2Object` as `itx.r2` answers it: every field the class carries, as data — the key with the
 *  owner prefix stripped, dates as ISO strings, checksums as hex. */
export type R2ObjectRecord = {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  checksums: Record<string, string>;
  uploaded: string;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  range?: R2Range;
  storageClass: string;
};

/** A Browser Run quick-action name (`browser.quickAction`'s first argument): what to extract from
 *  the rendered page — content, screenshot, PDF, markdown, accessibility snapshot, scraped elements,
 *  structured JSON, links, or a crawl. */
export type CfBrowserQuickAction =
  | "content"
  | "screenshot"
  | "pdf"
  | "markdown"
  | "snapshot"
  | "scrape"
  | "json"
  | "links"
  | "crawl";

/** Options for a Browser Run quick action: the target page as a `url` or as inline `html`, plus the
 *  action's own pass-through options (e.g. `screenshotOptions`). */
export type CfBrowserQuickActionOptions = Record<string, unknown> &
  ({ url: string } | { html: string });

/** What a browser session is acquired with: how long it lives idle (`keepAlive`, 10 seconds to 20
 *  minutes, in milliseconds), whether it is recorded, the country its requests leave from (ISO
 *  3166 alpha-2), and the hosts it may reach. */
export type CfBrowserSessionOptions = {
  keepAlive?: number;
  recording?: boolean;
  location?: string;
  guardrails?: { allowedDomains?: string[]; allowedDomainSets?: string[] };
};

/** A tab (or worker, or frame) of a session's browser, as its DevTools endpoint lists it. */
export type CfBrowserTarget = {
  id: string;
  type: string;
  url: string;
  title?: string;
  description?: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
};

/** A page a session has open, once it loaded (`loaded: false` when its load event did not arrive
 *  in time: the page may still be usable). */
export type CfBrowserPage = {
  sessionId: string;
  targetId: string;
  url: string;
  title: string;
  loaded: boolean;
};

/** Which of a session's targets a call is for: the session's first page when omitted, and
 *  `"browser"` for the browser's own endpoint (`Target.*`, `Browser.*`). `timeoutMs` bounds the
 *  command (30 seconds when omitted). */
export type CfBrowserCdpOptions = { targetId?: string; timeoutMs?: number };

/** `itx.ai`: the Workers AI binding's methods under their own names and shapes, as far as a call
 *  across RPC can carry them. No RPC carries a Blob, so a file for `toMarkdown` is its bytes; and a
 *  method whose binding answers a Response (`websearch`, a gateway's `run`) answers that Response's
 *  body. The binding's `aiSearch()` and `autorag(id)` are not here: Cloudflare deprecated both for
 *  the `ai_search` bindings, and both reach every instance on the deployment's account. Nor is
 *  `aiGatewayLogId`, which the binding sets after each `run` and so holds whichever call ended
 *  last. */
export type ItxAiApi = Pick<Ai, "run" | "models"> & {
  /** Documents, spreadsheets, web pages and pictures as Markdown: Cloudflare's `toMarkdown`. One
   *  file answers one result, a list a list; a file Cloudflare cannot convert answers
   *  `format: "error"` in its place. With no files, the service, for `supported()`. */
  toMarkdown(): ItxToMarkdownService;
  toMarkdown(
    files: ItxMarkdownDocument[],
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse[]>;
  toMarkdown(
    files: ItxMarkdownDocument,
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse>;
  /** AI Gateway `gatewayId` on the deployment's account. */
  gateway(gatewayId: string): ItxAiGateway;
  /** Cloudflare's Web Search API through AI Gateway `gatewayId`, billed to that gateway's
   *  credits (or a provider key stored on it): the answer's body. */
  websearch(request: AiWebSearchRequest): Promise<ItxWebSearchAnswer>;
};

/** A file for `itx.ai.toMarkdown`: Cloudflare's `{ name, blob }` with what the Blob is made of in
 *  place of the Blob, bytes or text (`new Blob([blob], { type })`), or `{ name, data }` with the
 *  bytes in base64. `name`'s extension tells Cloudflare the format; `type` is
 *  `application/octet-stream` when omitted. */
export type ItxMarkdownDocument =
  | { name: string; blob: Uint8Array | ArrayBuffer | string; type?: string }
  | { name: string; data: string; type?: string };

/** `itx.ai.toMarkdown()`: the binding's `ToMarkdownService`. */
export type ItxToMarkdownService = {
  transform(
    files: ItxMarkdownDocument[],
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse[]>;
  transform(
    files: ItxMarkdownDocument,
    options?: ConversionRequestOptions,
  ): Promise<ConversionResponse>;
  supported(): Promise<SupportedFileFormat[]>;
};

/** `itx.ai.gateway(id)`: the binding's `AiGateway`. `run` is the gateway's universal endpoint and
 *  answers the provider's body: parsed JSON, text, or bytes. `getLog` and `patchLog` take a log's
 *  id as the gateway's log list shows it; a gateway may log other minds' calls too, so nothing
 *  here lists them. */
export type ItxAiGateway = {
  getLog(logId: string): Promise<AiGatewayLog>;
  patchLog(logId: string, data: AiGatewayPatchLog): Promise<void>;
  getUrl(provider?: string): Promise<string>;
  run(
    data: AIGatewayUniversalRequest | AIGatewayUniversalRequest[],
    options?: { gateway?: UniversalGatewayOptions; extraHeaders?: object },
  ): Promise<unknown>;
};

/** What `itx.ai.websearch` answers: the Web Search API's JSON. A result carries more fields when its
 *  provider gives them (Exa: `imageUrl`, `lastModifiedDate`). */
export type ItxWebSearchAnswer = {
  items: ({ url: string; title: string; description?: string } & Record<string, unknown>)[];
  metadata: { query: string; requestId: string; latencyMs: number } & Record<string, unknown>;
};

/** `itx.browser`: Cloudflare Browser Run.
 *
 *  ONE-SHOT: `quickAction` renders a page and answers the action's RESULT (a string, parsed JSON, or
 *  bytes for a screenshot or a PDF), not the binding's `{ success, result }` envelope; a failed
 *  action throws.
 *
 *  A SESSION is a browser that stays open between calls, with its pages, cookies and sign-ins:
 *  `openPage({ url })` starts one and answers once the page loaded, `cdp(sessionId, method, params)`
 *  runs one Chrome DevTools Protocol command on it (read with `Runtime.evaluate`, click by
 *  evaluating a script, type with `Input.insertText`, picture with `Page.captureScreenshot`),
 *  `navigate` loads another URL in the same page, and `closeSession` ends it. A session left open
 *  is billed until its `keepAlive` runs out. Every session call names a session by the id
 *  `openPage` or `acquire` answered, which is the capability: nothing here lists sessions.
 *
 *  `fetch` is the binding's raw endpoint, for a library that speaks CDP itself. */
export type CfBrowserApi = {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
  quickAction(action: CfBrowserQuickAction, options: CfBrowserQuickActionOptions): Promise<unknown>;
  /** A new session with `url` open in its page. `keepAlive` is five minutes when omitted. */
  openPage(input: { url: string } & CfBrowserSessionOptions): Promise<CfBrowserPage>;
  /** Another URL in a session's page (the first page, or `targetId`'s). */
  navigate(sessionId: string, url: string, options?: CfBrowserCdpOptions): Promise<CfBrowserPage>;
  /** One CDP command on a session's page, answered with the command's result. A CDP error throws. */
  cdp(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: CfBrowserCdpOptions,
  ): Promise<unknown>;
  /** The binding's own `acquire`: a session with a blank page, and `targets` when asked for. */
  acquire(
    options?: CfBrowserSessionOptions & { targets?: boolean; liveViewUrlExpiresInMs?: number },
  ): Promise<{ sessionId: string; targets?: CfBrowserTarget[] }>;
  /** The session's times and state, or null when there is no such session. */
  getSession(sessionId: string): Promise<Record<string, unknown> | null>;
  closeSession(sessionId: string): Promise<{ status: "closing" | "closed" }>;
  /** A link a person opens to watch (or, without `guardrails`, drive) the session. The link is a
   *  credential. */
  getLiveView(
    sessionId: string,
    options?: {
      mode?: "devtools" | "tab" | "full";
      targetId?: string;
      expiresInMs?: number;
      guardrails?: { mode: "readonly" };
    },
  ): Promise<{ webSocketDebuggerUrl: string; devtoolsFrontendUrl: string; id: string }>;
  /** How many sessions the account may run and is running, and when the next may start. */
  limits(): Promise<{
    activeSessions: number;
    maxConcurrentSessions: number;
    allowedBrowserAcquisitions: number;
    timeUntilNextAllowedBrowserAcquisition: number;
    usedBrowserTimeSeconds?: number;
  }>;
  /** A session's tabs: list them, open one, bring one to the front, close one. */
  devtools: {
    getVersion(sessionId: string): Promise<Record<string, unknown>>;
    listTargets(sessionId: string): Promise<CfBrowserTarget[]>;
    getTarget(sessionId: string, targetId: string): Promise<CfBrowserTarget>;
    newTarget(sessionId: string, url?: string): Promise<CfBrowserTarget>;
    activateTarget(sessionId: string, targetId: string): Promise<{ message: string }>;
    closeTarget(sessionId: string, targetId: string): Promise<{ message: string }>;
  };
};

/** Where an `itx.images` image comes from: its bytes, a `ReadableStream` of them, an http(s) URL
 *  (fetched by the platform through the mind's egress, so the bytes never visit you), a mind
 *  file's path (`"/images/photo.jpg"`), or a file handle (`itx.files.get(path)`). A script uses the
 *  path: its `itx.files.get(path)` is a promise it must `await` before it can pass the handle on.
 *  At most 20 MB, the Images binding's own limit. */
export type CfImageSource =
  | Uint8Array
  | ArrayBuffer
  | ReadableStream<Uint8Array>
  | string
  | URL
  | Pick<FileHandle, "bytes">;

/** A file `itx.images` writes into: its path (`"/images/small.jpg"`) or `itx.files.get(path)`. */
export type CfImagesFile = Pick<FileHandle, "put"> | string;

/** What `itx.images.input(…)` and `.text(…)` answer, and every `.transform(…)` and `.draw(…)` on it:
 *  the Images binding's `ImageTransformer`, a plan nothing has run yet. `draw`'s overlay is any
 *  `CfImageSource`. Chain freely: `input(x).transform(a).output(o).response()` is one round trip. */
export type CfImageTransformer = {
  transform(transform: ImageTransform): CfImageTransformer;
  draw(image: CfImageSource, options?: ImageDrawOptions): CfImageTransformer;
  output(options: ImageOutputOptions): Promise<CfImageTransformationResult>;
};

/** The binding's `ImageTransformationResult`. The image is made when `response`, `image` or
 *  `writeTo` runs (and again each time you call one, which Images bills once per unique image and
 *  parameters per month); `contentType` is the output format and runs nothing. */
export type CfImageTransformationResult = {
  response(options?: ImageTransformationResponseOptions): Promise<Response>;
  contentType(): Promise<string>;
  image(options?: ImageTransformationOutputOptions): Promise<ReadableStream<Uint8Array>>;
  /** The image into a file, without visiting the caller; answers the stored file's record. */
  writeTo(file: CfImagesFile): Promise<FileRecord>;
};

/** `itx.images`: the Cloudflare Images binding (`env.IMAGES`), same method names and options, over
 *  `CfImageSource`s. `info` is free; every unique transformation is billed once a month. Not wrapped
 *  yet: `hosted`. A caller's non-image fails as `INVALID_INPUT`. */
export type CfImagesApi = {
  info(image: CfImageSource, options?: ImageInputOptions): Promise<ImageInfoResponse>;
  input(image: CfImageSource, options?: ImageInputOptions): CfImageTransformer;
  text(content: string, options: TextOptions): CfImageTransformer;
};

/** A token for an Artifacts repo's git remote. */
export interface ArtifactToken {
  plaintext: string;
  expiresAt?: string;
}

/** `itx.cfArtifacts.get(path)`: the repo's handle — a token for its remote, and the remote's
 *  git-over-HTTPS URL. A repo that does not exist fails at these, with the binding's own error. */
export interface CfArtifactRepoApi {
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<ArtifactToken>;
  remote(): Promise<string>;
}

/** `itx.cfArtifacts`: Cloudflare Artifacts, mind-scoped and addressed BY THE REPO'S PATH — the
 *  binding's own verbs. `repos` is the friendlier surface. */
export interface CfArtifactsApi {
  /** The Artifacts repo, `main` unborn until the first commit; false when it already existed. */
  create(path: string): Promise<{ created: boolean }>;
  get(path: string): Promise<CfArtifactRepoApi>;
  /** This mind's repos, as paths (one page). */
  list(options?: { limit?: number; cursor?: string }): Promise<{
    repos: { path: string }[];
    cursor?: string;
  }>;
  /** True when the repo existed; false when it was already gone. */
  delete(path: string): Promise<boolean>;
}

/** `connectToMcp`'s options: headers every request carries (`getSecret(…)` placeholders substitute
 *  at egress). */
export type McpConnectOptions = { headers?: Record<string, string> };

/** An MCP server's protocol version, capabilities, name and version. */
export type McpServerInfo = {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
};

/** One tool as an MCP server's `tools/list` describes it. */
export type McpTool = { name: string; description?: string; inputSchema?: unknown };

/** One event an MCP server offers (the draft MCP Events extension's `events/list`): its name, the
 *  delivery modes it supports, the subscription arguments it takes and the payload it delivers. */
export type McpEvent = {
  name: string;
  description?: string;
  delivery: string[];
  inputSchema?: unknown;
  payloadSchema?: unknown;
};

/** An MCP server's grant for a subscription: its id, and when it lapses unless `subscribe` is called
 *  again (an ISO time, or null for never). */
export type McpSubscription = { id: string; refreshBefore: string | null };

/** `itx.connectToMcp(url)`: an MCP server over Streamable HTTP. Besides these, the connection has
 *  one method per tool whose name is a legal identifier (reached by dotted spelling, untyped here);
 *  `callTool` reaches every tool. */
export interface McpConnectionApi {
  serverInfo(): McpServerInfo;
  listTools(): Promise<McpTool[]>;
  /** The result's `structuredContent`, else its text content JSON-parsed when it parses, else the
   *  text; an `isError` result throws with that text. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** The events the server offers. */
  listEvents(): Promise<McpEvent[]>;
  /** Subscribe this context to the event `name` with its arguments: the server POSTs each one to
   *  this context's MCP webhook, which appends it here as `events.iterate.com/mcp/webhook-received`
   *  `{ server, subscriptionId, body }`. Calling it again renews the subscription. */
  subscribe(name: string, args?: Record<string, unknown>): Promise<McpSubscription>;
  /** End the subscription `subscribe(name, args)` made. */
  unsubscribe(name: string, args?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

/** `connectToOpenApi`'s options: the base URL requests go to (default: the document's first
 *  server), and headers every request carries. */
export type OpenApiConnectOptions = { baseUrl?: string; headers?: Record<string, string> };

/** An OpenAPI 3 document — only `openapi`, `servers` and `paths` are read. */
export type OpenApiDocument = {
  openapi: string;
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
};

/** One operation an OpenAPI connection grew a method for. */
export type OpenApiOperation = {
  operationId: string;
  method: string;
  path: string;
  parameters: Array<{ name: string; in: string; required?: boolean }>;
  hasRequestBody: boolean;
  summary?: string;
};

/** `itx.connectToOpenApi(specOrUrl)`: an OpenAPI 3 service. Besides these, one method per
 *  `operationId` (dotted spelling, untyped here), each taking one input object. */
export interface OpenApiConnectionApi {
  operations(): OpenApiOperation[];
  /** The input object's fields become path, query and header parameters, the rest the JSON body;
   *  the answer is JSON when the response says so, else its text. */
  call(operationId: string, input?: Record<string, unknown>): Promise<unknown>;
}

/** `connectToCapnweb`'s options: headers for the session's requests, and the transport — a
 *  WebSocket session (default) or one HTTP batch per chain. */
export type CapnwebConnectOptions = {
  headers?: Record<string, string>;
  transport?: "websocket" | "batch";
};

/** `itx.connectToCapnweb(url)`: a remote capnweb API's main object as a pipelinable handle (its
 *  methods are the remote's, untyped here), and `close()` for the session (the next call reopens). */
export type CapnwebConnectionApi = InvokeHandle & { close(): void };

/** A stored file as `itx.files` answers it: its path, content type and size. */
export type FileRecord = { path: string; contentType: string; size: number };

/** `itx.files.get(path)`: a file's verbs. `put`'s string data is base64 or a `data:` URL; `url` is
 *  a signed URL on the mind host that downloads (`GET`, the default) or uploads (`PUT`) it. */
export type FileHandle = {
  put(input: {
    contentType?: string;
    data: Uint8Array | ArrayBuffer | string;
  }): Promise<FileRecord>;
  bytes(): Promise<Uint8Array>;
  head(): Promise<FileRecord | null>;
  delete(): Promise<void>;
  url(input?: {
    method?: "GET" | "PUT";
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresAt: string }>;
};

/** `itx.email.send`: one message from the mind's own address. `inReplyToOffset` names a
 *  message on the mind's `/integrations/email` and answers it in its thread: its recipients,
 *  `Re:` subject and threading headers are the defaults. Each attachment is a mind file
 *  (`itx.files`). */
export type EmailSendInput = {
  /** The mind's own address by default (a reply's: the address the answered message reached);
   *  the mind that owns the deployment's mind wildcard domain may name any address there
   *  (`hello@iterate.com`). Any other address is refused. */
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  inReplyToOffset?: number;
  attachments?: { path: string; filename?: string }[];
};

/** WHICH requests a fetch route takes — every field given must hold. A fetch route matches an HTTP
 *  request: `url` is a standard `URLPattern` over the real URL (hostname and path; its init's
 *  fields, each a pattern string), `headers` exact values. `routingSlug` is a convenience, the one
 *  address component both ingress modes can express: paths routing shares one host, so it is the
 *  `/minds/<mind>/<routingSlug>` segment; subdomains make it `<routingSlug>--<mind>` or
 *  `<routingSlug>.<custom hostname>`. Without paths routing it could go, and a route would match
 *  its hostname directly (`url: { hostname: "here.tunnels.templestein.com" }`). `{}` takes every
 *  request. */
export type FetchRouteRequestMatcher = {
  routingSlug?: string;
  url?: {
    protocol?: string;
    username?: string;
    password?: string;
    hostname?: string;
    port?: string;
    pathname?: string;
    search?: string;
    hash?: string;
    baseURL?: string;
  };
  headers?: Record<string, string>;
};

/** A route as `itx.fetchRoutes.set(name, route)` takes it: the requests it takes, the itx
 *  expression they go to, who may use it (`mind-members`: the config worker answers anyone else
 *  the sign-in challenge; absent or null: public) and its priority (higher first, then by name). */
export type FetchRouteInput = {
  requestMatcher: FetchRouteRequestMatcher;
  target: ItxExpressionInput;
  authRequirement?: { visitors: "mind-members" } | null;
  priority?: number;
};

/** A live route as `list()` and `match` answer it, its target parsed, with the offset of the
 *  `itx/fetch-route-configured` fact that set it. */
export type FetchRouteEntry = {
  fetchRouteName: string;
  requestMatcher: FetchRouteRequestMatcher;
  target: ItxExpression;
  authRequirement: { visitors: "mind-members" } | null;
  priority: number;
  configuredOffset: number;
};

/** One change a repo commit applies: a file's new content, as text or as bytes, or its deletion. */
export type RepoFileChange =
  | { path: string; content: string }
  | { path: string; bytes: Uint8Array | ArrayBuffer }
  | { path: string; delete: true };
/** One commit as `log` lists it, newest first (`timestamp` is epoch milliseconds). */
export type RepoLogEntry = {
  oid: string;
  message: string;
  author: { name: string; email: string };
  /** who made the commit: `iterate` for every commit the platform makes, whoever wrote it */
  committer: { name: string; email: string };
  timestamp: number;
  parents: string[];
};
/** What a commit reports: the new tip (null on an unborn repo that stayed empty) and the paths it
 *  changed (none when the tree was already as asked). */
export type RepoCommitResult = { commitOid: string | null; changedPaths: string[] };
/** How a `pull` or `push` ended: `main` moved from `previousOid` to `commitOid` (`updated`), or both
 *  sides were already at `commitOid` (`up-to-date`). Pulling or pushing without `force` when neither
 *  side contains the other throws `NOT_FAST_FORWARD`, with `{ ours, theirs }` as its data. */
export type RepoSyncResult = {
  status: "updated" | "up-to-date";
  commitOid: string | null;
  previousOid: string | null;
};
/** `itx.repos.get(path)`: the repo's verbs, branch `main` only (core/mind-worker/src/repo). A
 *  `commitOid` pins a read to that commit; without one, a read is of the tip. */
export type RepoHandle = InvokeHandle & {
  tip(): Promise<string | null>;
  /** A text file's text; null when the repo has no such file. A file that is not text is refused:
   *  `readBytes` reads any file. */
  readFile(path: string, options?: { commitOid: string }): Promise<string | null>;
  /** Any file's bytes, as a stream with its size: `await new Response(file.data).bytes()`. */
  readBytes(
    path: string,
    options?: { commitOid: string },
  ): Promise<{ data: ReadableStream<Uint8Array>; size: number } | null>;
  /** The repo's text files by path, or with `dir` those under that folder. */
  modules(options?: { commitOid?: string; dir?: string }): Promise<Record<string, string>>;
  /** Every file, as the loader reads a worker's source: text, or `{ base64 }` for a file that is
   *  not text. */
  files(options?: {
    commitOid?: string;
    dir?: string;
  }): Promise<Record<string, string | { base64: string }>>;
  listFiles(): Promise<{ commitOid: string | null; paths: string[] }>;
  commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
    parent?: string | null;
  }): Promise<RepoCommitResult>;
  writeFile(path: string, content: string): Promise<RepoCommitResult>;
  log(options?: { limit?: number }): Promise<RepoLogEntry[]>;
  /** Lands the tip's `repo/commit-completed` fact again, and answers the tip. A `git push` to the
   *  repo's remote moves the tip and lands no fact, so `/repos/config` does not publish by itself:
   *  call this after such a push. Null when the repo has no commit. */
  announceTip(): Promise<string | null>;
  /** The one remote the repo remembers, as git's `origin`: a git URL over HTTP(S) whose userinfo may
   *  hold a secret placeholder (`https://x-access-token:getSecret("/secrets/github-acme", { field:
   *  "accessToken" })@github.com/acme/config.git`, the placeholder percent-encoded or not), never a
   *  token; null when none. */
  origin(): Promise<string | null>;
  /** Remember `url` as origin, or forget it (`null`): a `repo/origin-set` fact on the repo's log. */
  setOrigin(url: string | null): Promise<{ origin: string | null }>;
  /** Bring the remote's `main` into this repo, the same commits and oids, fast-forward only unless
   *  `force` (which resets `main` to the remote's). A pull that moves `main` lands
   *  `repo/commit-completed` like a commit, so `/repos/config` publishes. `remote` defaults to origin. */
  pull(options?: { remote?: string; force?: boolean }): Promise<RepoSyncResult>;
  /** Send this repo's `main` to the remote's `main`, fast-forward only unless `force` (which
   *  overwrites the remote's). `remote` defaults to origin. */
  push(options?: { remote?: string; force?: boolean }): Promise<RepoSyncResult>;
  /** Append the repo's own events on its context; its lifecycle facts are the collection's. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
};

/** One overlay entry as a workspace's `gitStatus` reports it, against its mount at HEAD. */
export type WorkspaceChange = { path: string; change: "added" | "deleted" | "modified" };
/** One mount as `gitStatus` reports it: its path, its repo, and the overlay's changes under it. */
export type WorkspaceMountStatus = { path: string; repo: string; changes: WorkspaceChange[] };
/** `itx.workspaces.get(path)`: a private overlay over the mind's repos, each repo mounted at its
 *  path (core/mind-worker/src/workspace). Reads see the overlay, then the mounted repo's tip. */
export type WorkspaceHandle = InvokeHandle & {
  mounts(): Promise<Record<string, { repo: string }>>;
  /** The overlay's copy (a deletion reads null), else the mounted repo's file at its tip. */
  readFile(path: string): Promise<string | null>;
  /** The mounted repo's file at its tip whatever the overlay says. */
  readBase(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  /** False when the path was not a file of the merged view. */
  deleteFile(path: string): Promise<boolean>;
  /** Drop the overlay's entry at `path`. */
  revert(path: string): Promise<void>;
  listAllFiles(): Promise<string[]>;
  gitStatus(): Promise<{ mounts: WorkspaceMountStatus[]; unmounted: WorkspaceChange[] }>;
  /** Commit the overlay's changes under one mount (`scope`, needed when several are dirty). */
  gitCommit(input: {
    message: string;
    scope?: string;
    author?: { name: string; email: string };
  }): Promise<{ commitOid: string | null; mount: string; repo: string; changedPaths: string[] }>;
  gitLog(input?: { scope?: string; limit?: number }): Promise<RepoLogEntry[]>;
  /** Append the workspace's own events on its context; its lifecycle facts are the collection's. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
};

/** Cloudflare's handle to a saved disk, as `itx.sandboxes` records it. Opaque; valid only for the
 *  image it was taken from, and for 30 days after its last restore. */
export type SandboxSnapshot = { id: string; size: number; name?: string };

/** What the container API's `start` takes: `ctx.container.start`'s options, but for
 *  `enableInternet` (refused: a sandbox's only way out is the mind's egress) and a
 *  `containerSnapshot`, which can only be the snapshot the sandbox's own log records. A start that
 *  names a size (`instance`) is remembered: the sandbox starts on it again until one names another. */
export type SandboxContainerStartOptions = {
  image?: string;
  containerSnapshot?: { id: string };
  entrypoint?: string[];
  env?: Record<string, string>;
  instance?:
    | "lite"
    | "standard-1"
    | "standard-2"
    | "standard-3"
    | "standard-4"
    | { vcpu: number; memoryMib: number; diskMb: number };
  labels?: Record<string, string>;
};

/** What the sandbox's own `start` takes: the container API's, and `from`, the path of another
 *  sandbox of this mind whose snapshot this one starts from (a golden toolset made once, then
 *  started many times). That snapshot is this sandbox's disk from then on. One of `image`,
 *  `containerSnapshot` and `from` at most. */
export type SandboxStartOptions = SandboxContainerStartOptions & {
  from?: string;
};

/** What a sandbox's `files.stat` and `files.lstat` answer (the `iterate fs` tool's, run in the
 *  container). */
export type SandboxFileStat = {
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
};

/** `itx.sandboxes.get(path).files`: the Sandbox SDK's `Files`, over the sandbox's container, with
 *  `iterate fs` (the CLI's file tool) running inside it. A file is read and written as a stream. A
 *  failure carries the errno's name as `code`: `ENOENT`, `EISDIR`, `ENOTDIR`, … Each call starts the
 *  container first, from the disk last saved, as `exec` does. */
export type SandboxFilesApi = {
  /** A file's bytes. A missing file, or a directory, fails the call, never the stream half way. */
  read(path: string): Promise<ReadableStream<Uint8Array>>;
  /** `content` into a file, created or truncated; its directory must exist. A string is UTF-8. */
  write(
    path: string,
    content: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  ): Promise<void>;
  /** A path's metadata, a symbolic link followed. */
  stat(path: string): Promise<SandboxFileStat>;
  /** `stat` without following a symbolic link at the end of the path. */
  lstat(path: string): Promise<SandboxFileStat>;
  /** A directory's immediate entries, in the order it gives them. */
  readDirectory(path: string): Promise<{ name: string; type: SandboxFileStat["type"] }[]>;
  /** A directory; with `recursive`, its missing parents too, and no error when it exists. */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** A file, directory or link renamed; an existing file at the destination is replaced. */
  rename(source: string, destination: string): Promise<void>;
  /** A file or link removed; a directory needs `recursive`, `force` makes a missing path no error. */
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
};

/** `itx.sandboxes.get(path).container`: the Durable Object container API (`ctx.container`) itself,
 *  every member under its own name, replayed where the container lives. A member that answers data is
 *  a call: `container.inspect()`, `container.snapshotContainer()`, `container.destroy()`. A CHAIN is
 *  `container.invoke(steps)`: `container.invoke([["exec", argv, { stdin?: ReadableStream }], "stdout"])`
 *  is one call, and a `ReadableStream` comes back as it is; an `exec` chain ends in the process's
 *  `.stdout`, `.stderr`, `.exitCode`, `.pid`, `.output()` (plain `{ exitCode, stdout, stderr }`) or
 *  `.kill(signo?)`. A `start`, `snapshotContainer` or `destroy` lands on the sandbox's log, and a
 *  sandbox with a call running is not parked. Cloudflare's meaning holds: a raw `start` restores
 *  nothing by itself and a `destroy` saves nothing. Not reachable: `interceptOutbound*` (the
 *  mind's egress is the platform's alone). */
export type SandboxContainerApi = InvokeHandle & {
  readonly running: Promise<boolean>;
  readonly images: Promise<Record<string, string>>;
  start(options?: SandboxContainerStartOptions): Promise<void>;
  monitor(): Promise<void>;
  destroy(reason?: string): Promise<void>;
  signal(signo: number): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  snapshotContainer(options?: { name?: string }): Promise<SandboxSnapshot>;
  inspect(): Promise<{ image: string; labels: Record<string, string> } | null>;
  /** The chain, replayed in one call: `[["exec", argv, options], "stdout"]`. */
  invoke(steps: ItxExpression): Promise<any>;
};

/** `itx.sandboxes.get(path)`: a Linux container with a disk (core/mind-worker/src/sandbox). `exec`
 *  and every call of `files` start the container when none runs, from the disk last saved, on
 *  `standard-1` unless `start({ instance })` says otherwise. Memory and running processes do not
 *  survive a stop; the disk does, for 30 days after its last restore and only on the image it was
 *  saved from (the platform's `iterate-dev-image`: Node 24 on Debian with git, gh, Chromium, ffmpeg,
 *  pnpm, the Claude, Codex and Grok CLIs, the cf CLI, doppler and the iterate CLI; `start({ image:
 *  "cloudflare/debian-trixie" })` is Cloudflare's lean one). NOTHING RUNS FOR NOTHING: a sandbox unused for `idleAfterMs` (five minutes by default; a
 *  command, a file call or a stream being read is use; a call left open counts for an hour at most)
 *  is saved and stopped, a sandbox in use has its disk saved every 15 minutes, and Cloudflare stops
 *  the container two hours after it last answered, whatever else fails. THE ONLY WAY OUT IS THE
 *  MIND'S EGRESS: the container starts with the internet off, and every HTTP and HTTPS request it
 *  makes, to any name or address, WebSocket handshakes included, is answered by the mind's own
 *  `itx.fetch` (its rewrite rules;
 *  `getSecret("/secrets/…")` placeholders are substituted there). `apt-get` works through it. A
 *  mind's GitHub connection is in every command's environment as placeholders (`GH_TOKEN`, and a
 *  git credential helper that answers with it): with `git` and `gh` installed, cloning, pushing and
 *  opening pull requests need no setup, and no token ever enters the container. A call
 *  that does not answer within a minute fails: run longer work in the background and poll. Where the
 *  sandbox stands is `(await handle.snapshot()).state`. */
export type SandboxHandle = InvokeHandle & {
  /** `container.start(options)` with the sandbox's disk: make the container run, from the disk last
   *  saved unless `image` asks for a fresh one (which leaves that disk behind). Running already:
   *  nothing happens. A disk Cloudflare will not restore (the image was replaced, or 30 days passed)
   *  FAILS the start rather than start empty; `start({ image: "iterate-dev-image" })` is the way out. */
  start(options?: SandboxStartOptions): Promise<void>;
  /** `container.exec(argv, options)` then `process.output()`: run a command and wait for it
   *  (a shell is `["bash", "-c", "…"]`). A nonzero exit is an answer, not a failure. Output over
   *  8 MiB fails (write it to a file, or stream it with `container.exec(argv).stdout`); take secrets
   *  from `env`, since the log keeps the first 500 characters of the command. */
  exec(
    command: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      user?: string;
      stdin?: string | Uint8Array;
      timeoutMs?: number;
    },
  ): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;
  /** The Sandbox SDK's `Files`. */
  files: SandboxFilesApi;
  /** The container API itself. */
  container: SandboxContainerApi;
  /** How long the sandbox may sit unused before it is saved and stopped: 1 second to 1 hour, five
   *  minutes by default. */
  configure(settings: { idleAfterMs?: number }): Promise<{ idleAfterMs: number }>;
  /** Append the sandbox's own events on its context; its lifecycle facts are the collection's. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
};

/** An entity collection root (`itx.repos`, `itx.workspaces`, `itx.sandboxes`): `get(path)` the entity's handle,
 *  `list()` the mind catalog, `create(path)` the creation saga on that path (the parent link the
 *  caller's context writes first, then the processor row, the request, the terminal fact — created,
 *  or create-failed thrown), `delete(path)` the deletion saga (the request, `deleted` cross-posted to
 *  `/`, the row disabled). A relative `path` means the caller's. `get` and `list` reach the whole
 *  mind; `create` and `delete` only paths strictly beneath the caller's context (FORBIDDEN). An
 *  entity whose creation has not landed refuses its handle's verbs and `delete` (NOT_CREATED). */
export type EntityCollectionApi<Handle> = {
  get(path: string): Handle;
  list(): Promise<{ path: string; createdAt: string }[]>;
  create(path: string): Promise<{ path: string }>;
  delete(path: string): Promise<{ path: string }>;
};

/** The roots an installable app adds by rewrite rule — present only on a context whose table has
 *  the rule (a mind that installed the app), so never part of `IterateContextApi` itself. An
 *  installed app publishes its root by augmenting this interface from its own package
 *  (`declare module "iterate/api" { interface InstalledAppRoots { myApp: MyAppApi } }`), so a root
 *  the platform does not ship is never named here; a caller imports that module to spell
 *  `IterateContextApiWith<"myApp">`. */
export interface InstalledAppRoots {}

/** A context whose mind installed the named apps: with the app's package imported,
 *  `IterateContextApiWith<"myApp">` spells `itx.myApp`. Code that holds a plain scope asserts it
 *  (`itx as IterateContextApiWith<"myApp">`) where it knows the app is installed. */
/** What `itx.telemetry.query` answers: the rows, and the SQL that ran for the mind. */
export type TelemetryRows = { rows: Record<string, unknown>[]; sql: string };

export type IterateContextApiWith<App extends keyof InstalledAppRoots> = IterateContextApi &
  Pick<InstalledAppRoots, App>;

/** A context (a mind, a user, an organization): every `itx` root, reached through `invoke`. */
export interface IterateContextApi {
  invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown>;
  /** Another context of this mind, by path (`..` and `/` allowed; the global namespace is not). */
  cd(path: string): IterateContextApi;
  /** Durable batches appended after a deadline (`afterMs`), at an instant (`at`) or on an interval
   *  (`everyMs`); a key set again is replaced, but an interval set again as it stands keeps its
   *  clock (a failed one is revived); a receipt cancels exactly the definition it names. */
  schedules: {
    set(
      input: ScheduledAppendInput,
      options?: { idempotencyKey?: string },
    ): Promise<ScheduleReceipt>;
    cancel(schedule: ScheduleKey | ScheduleReceipt): Promise<StreamEvent[]>;
    list(): ScheduledAppend[];
    get(key: ScheduleKey): ScheduledAppend | null;
  };
  /** `principal` is who is calling, when the call has one: a person through the mind's API. Code
   *  the mind loaded calls as itself and gets none. A mind names itself by `mindSlug`. A mind on
   *  its own stack has no `mindId`: only the frozen platform, which holds many minds, answers one. */
  whoami():
    | {
        mindId?: string;
        path: string;
        mindSlug?: string;
        mindUrl?: string;
        principal?: Principal;
      }
    | Promise<{
        mindId?: string;
        path: string;
        mindSlug?: string;
        mindUrl?: string;
        principal?: Principal;
      }>;
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** `append`, answered with each event's offset alone: the events do not travel back. */
  appendOffsets(...events: StreamEventInput[]): Promise<number[]>;
  /** This mind's public URL over HTTP: the apex, or a routing slug's host (`blog--<mind>`, or
   *  `blog.<primary hostname>` once the mind has a primary hostname),
   *  at `path`. Only from a session, which carries the origin to compose it with. */
  url(target?: { routingSlug?: string; path?: string }): Promise<string>;
  /** RESET this context (Cloudflare's `ctx.abort`): its Durable Object drops everything it holds in
   *  memory and the next call starts a fresh incarnation from durable storage. Resolves with the
   *  `events.iterate.com/itx/aborted { reason?, callerPath?, app? }` event it recorded — durable
   *  and attributed to the caller before anything resets — and the reset follows the answer.
   *  SURVIVES: the log and everything derived from it (rewrite rules, subscriptions, schedules),
   *  every facet's storage, kv. GOES: in-memory state, every facet instance and its in-flight work,
   *  every socket on the context (a provider's re-dials), and every other call in flight there — it
   *  rejects with the reset's message (`itx.abort() reset the context <path>: <reason>`). A handle
   *  you kept names its target by expression, so its next call reaches the new incarnation.
   *  Another context of the mind: `itx.cd(path).abort()`. A rewrite rule masks it like any name
   *  (`provide("itx.abort", null)`). */
  abort(reason?: string): Promise<StreamEvent>;
  readEvents(
    afterOffset?: number,
    limit?: number,
    options?: { includeEphemeral?: boolean },
  ): Promise<StreamPage>;
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent>;
  fetch(request: Request): Promise<Response>;
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<{ ok: true }>;
    delete(key: string): Promise<{ ok: true }>;
    list(prefix?: string): Promise<{ keys: string[] }>;
  };
  /** The object store: every write and delete lands `itx/file-set` or `itx/file-deleted` on the
   *  context that made it, so a file always has evidence on a log (a signed upload's is on `/`).
   *  The R2 binding's own verbs on the owner's slice of one bucket (every key
   *  prefixed, the prefix stripped from every key answered); what cannot cross the wire is answered
   *  as data — an `R2Object` as its fields, a body as its bytes. `list` is one page with its cursor.
   *  `presign` is a signed URL on the mind host, a download or an upload. `files` is the
   *  friendlier surface. */
  r2: {
    head(key: string): Promise<R2ObjectRecord | null>;
    get(
      key: string,
      options?: { range?: R2Range },
    ): Promise<(R2ObjectRecord & { data: Uint8Array }) | null>;
    put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string | null,
      options?: {
        httpMetadata?: R2HTTPMetadata;
        customMetadata?: Record<string, string>;
        storageClass?: string;
      },
    ): Promise<R2ObjectRecord>;
    delete(keys: string | string[]): Promise<void>;
    list(options?: {
      limit?: number;
      prefix?: string;
      cursor?: string;
      delimiter?: string;
      startAfter?: string;
    }): Promise<{
      objects: R2ObjectRecord[];
      delimitedPrefixes: string[];
      truncated: boolean;
      cursor?: string;
    }>;
    presign(input: {
      key: string;
      method?: "GET" | "PUT";
      expiresInSeconds?: number;
    }): Promise<{ url: string; expiresAt: string }>;
  };
  /** The mind's secrets, WRITE-ONLY: a secret IS its path (`/secrets/<name>`, the name
   *  `[a-zA-Z0-9._-]+`), and the path is what an outbound request's placeholder spells —
   *  `getSecret("/secrets/<name>")` in a URL or a header substitutes to the value at egress, and only
   *  towards the ORIGINS in `urls` (required: a secret is always pinned). `set` stores a string or a
   *  JSON object (`refresh` names the strategy that re-mints an expiring credential); `delete`
   *  forgets it (re-settable); `list` is the catalog — paths, pins, strategy kinds, when first set,
   *  public fields — never a secret value. Every change is one fact on the secret's path
   *  (`secret/set`, `secret/deleted`), attributed to the caller and cross-posted to the root, so the
   *  log says who set what and when. No fact carries the value, sealed or not. */
  secrets: {
    set(
      path: string,
      material: SecretMaterial,
      /** The material and its options replace the whole of what the secret held. `public`: the
       *  names of the material's top-level string fields that are no secret (an OAuth client's
       *  `clientId`): the `secret/set` fact carries their values and `describe` answers them.
       *  `placement`, `operations` and `lendTo` (`SecretUses`) fix what the secret may be used for:
       *  where its placeholder may sit, the operations it answers, and the secrets whose refresh may
       *  borrow it. */
      options: {
        urls: string[];
        refresh?: SecretRefresh;
        merge?: boolean;
        public?: string[];
      } & SecretUses,
    ): Promise<{ path: string }>;
    /** OAuth's first tokens: the link to send a human to — the secrets Worker's start page on the
     *  platform's hostname, which shows the secret, the origins its tokens go to and what else they
     *  may be used for, and whose Continue sends the browser on to the provider's consent page. A
     *  signed-in member opens it, or anyone with `anyoneWithLink`. The provider redirects to the
     *  secrets Worker's callback, which completes only in the browser shown that page; the secret's
     *  object exchanges the code, `secret/set` lands, and the callback redirects to `next`. The
     *  provider's URL and the PKCE verifier stay in the secrets Worker. The attempt lasts an hour.
     *  `nonce` names it; a later `beginOAuth` on the same path replaces it. */
    beginOAuth(
      path: string,
      options: SecretOAuthOptions,
    ): Promise<{ authorizationUrl: string; nonce: string }>;
    /** What became of the attempt `nonce` (`beginOAuth`'s answer), for the page `next` lands on:
     *  `complete` with the scopes the provider granted and, with `account`, the account the tokens
     *  are for; `pending` while it is in flight; `unavailable` once it expired, a newer attempt
     *  replaced it, or a write since superseded its tokens. Never a token. */
    oauthResult(
      path: string,
      input: { nonce: string },
    ): Promise<
      | { status: "pending" }
      | { status: "complete"; scopes: string[]; account?: { id: string; name: string | null } }
      | { status: "unavailable" }
    >;
    /** The redirect URI to register at a provider for a client of your own: the platform's one
     *  callback, `<platform origin>/secrets/oauth/callback`. */
    oauthCallbackUrl(): Promise<string>;
    delete(path: string): Promise<{ path: string }>;
    /** Whether the secret at `path` holds a value, never the value: `set` is false for a path
     *  that holds none, one never set included. A read alone: no fact. The answer has more fields
     *  (`SecretDescription`, iterate/workers). */
    describe(path: string): Promise<{ path: string; set: boolean }>;
    list(): Promise<SecretCatalogEntry[]>;
    /** The link to a form on the platform's own hostname where a person enters a value an agent
     *  must never see in chat. The form shows the secret's path, its pin, what it may be used for
     *  (`SecretUses`) and `description` as the requester's words, and answers a signed-in member
     *  alone unless `anyoneWithLink`. */
    collectFromUser(input: CollectSecretInput): Promise<CollectSecretLink>;
    /** A webhook's signature checked against a secret WITHOUT revealing it: one bit back,
     *  constant-time, run in the secrets Worker. A material with no key at the field answers false.
     *  Like every operation, only a secret made with it in `operations` answers, within a limit
     *  per minute (`SecretUses`). */
    verifyHmac(path: string, input: SecretHmacVerification): Promise<boolean>;
    /** The HMAC-SHA256 of `payload` under a secret, WITHOUT revealing it: the signature comes back,
     *  the key never does, run in the secrets Worker. For a provider that proves an endpoint by a
     *  challenge only the key's holder can answer (X's CRC). A secret never set, or a material with
     *  no key at the field, is refused (`SECRET_NOT_SET`); so is a secret not made with it in
     *  `operations` (`FORBIDDEN`). */
    signHmac(path: string, input: SecretHmacSigning): Promise<string>;
    /** A presented string compared with a secret WITHOUT revealing it, for a credential a caller can
     *  only send as it is (a webhook's static header token): one bit back, constant-time, run in the
     *  secrets Worker, for a secret made with it in `operations`. No string at the field answers
     *  false. A replayable token stays replayable: prefer `verifyHmac` wherever the sender signs. */
    verifyEquals(path: string, input: SecretEqualsVerification): Promise<boolean>;
  };
  /** The mind's fetch routes, on its root `/`: which itx expression, the route's `target`, a
   *  request on its hosts goes to. `set` appends one `itx/fetch-route-configured` fact (`null`
   *  deletes the route); `match` answers the route a request takes. The platform serves a request a
   *  route takes from `route.target` (a WebSocket upgrade included), before the config worker's
   *  fetch; a write answers once no host is served from the routes before it. */
  fetchRoutes: {
    set(fetchRouteName: string, route: FetchRouteInput | null): Promise<{ fetchRouteName: string }>;
    list(): Promise<FetchRouteEntry[]>;
    match(request: {
      url: string;
      headers: Headers | Record<string, string> | [string, string][];
    }): Promise<FetchRouteEntry | null>;
  };
  /** The table this context resolves against, described — the tree a model reads. `list()` follows a
   *  bare hop row into the context it names (a Durable Object hop, hence async). */
  rewriteRules: {
    /** `depth`: how many bare hop rows to follow (default: all). */
    list(depth?: number): Promise<RewriteRuleListEntry[]>;
    get(match: string): Promise<RewriteRuleListEntry | null>;
    resolve(call: ItxExpressionInput): string[];
  };
  /** A facet of this context: a caller reaches only what its class lists in `static publicMethods`
   *  (sdk/index.ts `FacetDurableObject`); anything else is refused FORBIDDEN. */
  facets: {
    /** The facet `name` — addressed when it is running (a processor, a named instance), loaded and
     *  hosted from `spec` otherwise. `Facet` types its methods for the caller
     *  (`facets.get<{ snapshot(): Promise<Snapshot> }>("x").snapshot()`): an UNCHECKED assertion,
     *  like a cast — nothing verifies the hosted class has them, so name the facet's own published
     *  type where there is one. A capnweb `RpcStub` of this interface erases the type parameter:
     *  there, cast the handle instead. */
    get<Facet = unknown>(name: string, spec?: FacetSpec): InvokeHandle & Facet;
    /** RESET one facet of this context, from the context that hosts it — any facet, whether or not
     *  it extends the SDK's host, including one that would never answer a call. Its instance and
     *  in-memory state go, and every call in flight on it rejects `FACET_ABORTED`; its storage
     *  stays, and its next call starts it fresh. The context itself is not reset. Resolves with the
     *  `events.iterate.com/itx/facet-aborted { name, reason?, callerPath?, app? }` event;
     *  `NO_FACET` for a name never hosted here. */
    abort(name: string, reason?: string): Promise<StreamEvent>;
  };
  subscriptions: {
    list(): SubscriptionListEntry[];
    get(name: string): SubscriptionListEntry | null;
  };
  /** The rpc stubs lent to this context right now, by key (a live session's `provide`): `get(key)`
   *  one, as a handle over its transport (offline ⇒ RPC_STUB_OFFLINE at call time). */
  rpcStubs: { get(rpcStubKey: string): InvokeHandle; list(): string[] };
  processors: {
    enable(
      name: string,
      spec?: (FacetSpec & { consumes?: string[] }) | { consumes?: string[] },
    ): Promise<{ name: string }>;
    disable(name: string): Promise<void>;
    list(): SubscriptionListEntry[];
    /** A hosted processor's claim on this context's alarm: "revive me by `at`" (a facet with a
     *  `runInBackground` attempt in flight), or `null` to release it. */
    claim(name: string, at: number | null): Promise<void>;
  };
  workers: {
    /** A stateless worker loaded from `spec`: `mainModule` loads that module of the source as its
     *  entry in place of package.json's `main`. `source` is as `FacetSpec`'s: an expression with no
     *  `cacheKey` is the NAME of a loaded worker (`itx.cd('/').config`), whose code each call loads,
     *  `mainModule` as the mind's publication of it recorded it. */
    get(spec: {
      source: WorkerSource;
      cacheKey?: string;
      mainModule?: string;
      className?: string;
      props?: unknown;
    }): InvokeHandle;
  };
  /** HTTP WEBHOOKS, the target of a fan-out row that sends each event to another server, Stripe's
   *  way: `webhooks.get({ url, signingSecret? }).deliverEvent` POSTs the event as JSON from this
   *  context through its own `itx.fetch` (a context that may not fetch sends nothing), with
   *  `iterate-event-id: <mindId><path>@<offset>` (repeats share it) and, given a signing secret (a secret
   *  path pinned to `url`'s origin), `iterate-timestamp` and `iterate-signature: v1=<hex
   *  HMAC-SHA256 of "<timestamp>.<body>">`. A 2xx acks; any other status retries on the event's own
   *  ladder (~44 h); a 410 halts the row until a resume. `deliverEvent` is the delivery loop's call
   *  alone. A signature vouches for the MIND, not a context: a receiver checks the body's `path`,
   *  and loaded code names a signing secret only at the mind's root. */
  webhooks: {
    get(spec: {
      url: string;
      signingSecret?: string;
      /** The MCP Events subscription it delivers: each event as an `event.appended` occurrence,
       *  signed per Standard Webhooks with `signingSecret` (our MCP server's `events/subscribe`). */
      mcpSubscription?: string;
    }): InvokeHandle;
  };
  /** A subscription: a pure itx expression, or a live callback lent to the registry (what live state
   *  uses); `null` removes the row. The handle's dispose removes it too. */
  subscribe(input: {
    name?: string;
    target:
      | ItxExpressionInput
      | ((events: unknown[], range: unknown) => void)
      | EventCopyTarget
      | null;
    consumes?: string[];
    afterOffset?: number;
    /** `false`: FAN-OUT delivery — one event per call (`deliverEvent(event)`), in any order, each
     *  retried and dead-lettered on its own. Absent: the ordered queue, the one that may take a
     *  dead letter (`itx/subscription-delivery-failed`): alert on dead letters from an ordered row. */
    ordered?: false;
    /** With an `EventCopyTarget`, the row COPIES each event it takes onto the log at the target's
     *  `path`. It's always `ordered: false`, and each copy gets a `source.copiedFrom` saying which
     *  event it copies. `filter` is only for such a row: a JSONata expression over the event, and
     *  only events it answers exactly `true` for are copied.
     *
     *  An expression that doesn't compile, or uses something forbidden
     *  (core/itx/src/stream/event-expressions.ts), makes `subscribe` throw. One that throws on a
     *  particular event fails that event's delivery, which is retried like any other. `itx/*`
     *  events are never copied. Copies can land in any order, so read `copiedFrom` to see when and
     *  where each original happened. */
    filter?: string;
  }): Promise<{ [Symbol.dispose](): void }>;
  /** A rewrite rule of this context, session-scoped (the handle's dispose removes it): make `match`
   *  mean `target`, an expression, a live stub, or null to deny. `description` is the one line a
   *  model reads for the name. `fetchRoute` (a live stub, on the mind's root) is a fetch route to
   *  `match` that lives exactly as long as the lend: set with it, set again when the platform
   *  re-attaches it, removed when it ends however it ends. A live stub's handle answers
   *  `lendEnded()` with why the lend ended — it can end while the session lives (the platform lost
   *  its pager). The durable spelling is the rule's event (`RewriteRuleConfigured`) through
   *  `itx.append`. */
  provide(
    match: ItxExpressionInput,
    // Expressions, null, or live RPC references (RpcTarget / callable), serialized by capnweb.
    target: unknown,
    options?: {
      description?: string;
      fetchRoute?: Omit<FetchRouteInput, "target"> & { fetchRouteName: string };
    },
  ): Promise<{ [Symbol.dispose](): void; lendEnded(): Promise<string> }>;
  /** A script — the text of `async (itx) => { … }` — run once against this context, on its log:
   *  `itx/run-requested` under the caller, the context's runner, `run-settled` (JSON in, JSON
   *  out); resolves with the result or rejects with the settlement's error. Never re-run. A script
   *  still running ten minutes after it started is settled failed (`failureKind: "deadline"`). */
  run(script: string): Promise<unknown>;
  /** The mind's repos and workspaces as domain objects — one shape each: `get(path)` is
   *  the entity's facet on the context at `path` (its verbs, plus the typed `append` on that
   *  context), `list()` the mind catalog, `create(path)` the creation saga on that path (the
   *  parent link the caller's context writes first, then the processor row, the request, the
   *  terminal fact — created, or create-failed thrown), `delete(path)` the deletion saga (the
   *  request, `deleted` cross-posted to `/`, the row disabled). A relative `path` means the caller's. */
  repos: EntityCollectionApi<RepoHandle>;
  workspaces: EntityCollectionApi<WorkspaceHandle>;
  /** Linux containers with a disk: `create(path)` once, then `get(path).exec("make test")`. */
  sandboxes: EntityCollectionApi<SandboxHandle>;
  /** Workers AI's binding (`ItxAiApi`), under this context's capability rules. */
  ai: ItxAiApi;
  /** Cloudflare Browser Run. */
  browser: CfBrowserApi;
  /** Cloudflare Images: `info` and `transform` over image bytes. */
  images: CfImagesApi;
  /** Cloudflare Artifacts, mind-scoped (`repos` is the friendlier surface). */
  cfArtifacts: CfArtifactsApi;
  /** Files stored in the mind's object store, by path (`r2` underneath). */
  files: {
    get(path: string): InvokeHandle & FileHandle;
    list(prefix?: string): Promise<FileRecord[]>;
  };
  /** THE MIND'S TELEMETRY (docs/telemetry.md): `query(sql, { hours })` runs one SELECT over
   *  `events`, `logs` and `spans` (Basin SQL), or over `metrics` alone (Workers Analytics Engine),
   *  each cut to this mind's rows of the last `hours` (default 24, at most 720), and answers the
   *  rows with the SQL that ran. Throws on a deployment with no warehouse. */
  telemetry: { query(sql: string, options?: { hours?: number }): Promise<TelemetryRows> };
  /** WHO IS A MEMBER OF THE MIND NOW, as the stack's sign-in knows it: the addresses its config
   *  names and the members an owner added. `has(email)` answers true or false. The mind's own
   *  code asks it to decide whose words from outside, such as a chat message, are a member's. */
  members: { has(email: string): Promise<boolean> };
  /** The mind's email, `<slug>@iterate.app` (core/lib/src/email.ts has its events and
   *  threads). `send` answers the `email/sent` event. */
  email: {
    send(input: EmailSendInput): Promise<StreamEvent>;
  };
  /** WHAT WAITS FOR A MEMBER'S SIGNED YES before it is done (./acts.ts): a mail, or a call of a
   *  verb, that a rule names. `setRules` replaces the rules while they are open; once a member
   *  locked them it is refused, and `propose` asks a member to sign one rule at `signAt`. A rule
   *  for a request with a secret is a member's alone to put in force: `propose` is the one way
   *  for code or an agent to ask for one. */
  approvals: {
    rules(): Promise<{ locked: boolean; rules: ActRule[] }>;
    setRules(rules: ActRule[]): Promise<ActRule[]>;
    /** With `secret`, a rule for a request with that secret is proposed: the mind's code sets no
     *  such rule, and a member signs the proposal into one or rejects it. */
    propose(
      rule:
        | ActRule
        | {
            secret: string;
            methods: string[];
            hosts: string[];
            jsonStrings?: string[];
            freePaths?: string[];
          },
    ): Promise<{ id: string; signAt: string }>;
  };
  /** An MCP server over Streamable HTTP, through this context's egress; its events subscribed to
   *  land on this context. */
  connectToMcp(url: string, options?: McpConnectOptions): Promise<McpConnectionApi>;
  /** An OpenAPI 3 service from its document or the URL of one, through this context's egress. */
  connectToOpenApi(
    specOrUrl: string | OpenApiDocument,
    options?: OpenApiConnectOptions,
  ): Promise<OpenApiConnectionApi>;
  /** A remote capnweb API's main object — a WebSocket session through egress (default) or one
   *  HTTP batch per chain (`{ transport: "batch" }`). */
  connectToCapnweb(url: string, options?: CapnwebConnectOptions): Promise<CapnwebConnectionApi>;
}
