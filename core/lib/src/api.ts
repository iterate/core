// api.ts — THE API AN APP DIALS: the shapes of core/os's `/api` root, the session it vends and a
// context's surface, as a capnweb client sees them. DECLARED here, never generated, and never the
// platform's classes: in core/os `IterateRpcTarget implements IterateApi` and
// `IterateContextRpcTarget implements IterateContextApi` (src/session.ts, src/iterate-context.ts),
// so an app built against this package types against exactly what the deployment answers. A context
// has ONE method — `invoke(call, ...args)`, a dotted itx expression — and a capnweb stub proxies the
// dotted spelling (`itx.repos.get(path).readFile(file)`) onto it. THIS FILE IS THE SOURCE OF TRUTH
// for every root app code reaches: core/os derives its built-in record's type from these members
// (context/built-ins.ts `BuiltInScope`, library.ts `LibraryRoots`), so a root or a verb the platform
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
import type { ConsentScope } from "./oauth-scopes.ts";
import type { Principal } from "./principal.ts";
import type { IngressRouting } from "./project-ingress.ts";
import type { StreamEvent, StreamEventInput } from "./stream/processor.ts";

/** What `authenticate` accepts: the browser (its login cookie rode the upgrade), a device or script
 *  (its bearer `token`, always presented here: a static page on another origin cannot put a header
 *  on a WebSocket), or the operator (the deployment's admin secret, verified in-band). */
export type SessionCredentials =
  | { type: "from-server-cookie" }
  | { type: "bearer"; token: string }
  | { type: "admin-secret"; secret: string; as?: { email: string } };

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

/** A loaded worker's source: its modules, literally, or an itx expression that produces them (then
 *  `cacheKey` names the build, and the caller owns "same key ⇒ same code"). */
export type WorkerSource = Record<string, string> | ItxExpressionInput;

/** What hosts a class as a durable facet — `facets.get(name, spec)`, `processors.enable(name, spec)`.
 *  `source` is the code (its modules, or an expression that produces them under `cacheKey`), or —
 *  an expression with NO `cacheKey` — the NAME of a loaded worker: one that resolves, as a call
 *  would, to `itx.builtins.workers.get(spec)` in the table of the context whose rule it is
 *  (`itx.cd('/').config`, the project's published config). The facet loads that worker's source,
 *  its producer run with that context's authority. `mainModule` names the module of the source that
 *  exports `className` when it is not the source's entry (`agents.ts` of a config repo whose entry
 *  is `worker.ts`): the facet runs that module's own graph, and — named by the project's published
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
      client?: { platform: IntegrationProvider };
    }
  /** A GitHub App installation's token (`POST <apiOrigin>/app/installations/<id>/access_tokens`
   *  with an App JWT) → `accessToken`, minted on first use and on a 401. The App is the deployment's
   *  (`{ platform: "github" }`, minted only for an installation the control plane routes to this
   *  project) or the project's own, whose `appId` and `privateKey` the material holds
   *  (`{ project: "github" }`); either may be a `getSecret("/secrets/<name>", { field })`
   *  placeholder naming another of the owner's secrets pinned to `apiOrigin`, so one secret holding
   *  the App's key serves every installation's secret. */
  | {
      kind: "github-app-installation";
      apiOrigin: string;
      installationId: string;
      client: { platform: "github" } | { project: "github" };
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
 *  the deployment's secrets key and bound to this one secret and write (core/os
 *  src/secret-at-rest.ts says how, and what opens it). The log is the secret: a backup of it and
 *  the key is everything. `itx.cd(path).facets.get("secret").snapshot()` answers the current one
 *  as `state.material.sealed`. */
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
  /** A path that forwards every use to a secret elsewhere: a person's account connected to this
   *  project (`integrations.connect(provider, { account })`), or the deployment's own secret its
   *  operator lent (`itx.secrets.lend`) — whose, under which lend, and the connection it is. */
  borrowed?: {
    lendId: string;
    lender: { userId: string; email?: string } | { instance: true };
    integration?: { provider: string; account: string; externalId: string };
  };
  /** A lender's secret's live lends, by lend id: the project (or `every-project`) and the path it
   *  is lent as. */
  lends?: Record<string, { to: string; as: string; since: string }>;
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
   *  absolute http(s) URL without credentials, such as the project's page that asked. The page
   *  shows its host before the person saves. Without it, the page says the tab can close. */
  redirectUrl?: string;
};

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
 *  clear: the deployment's own at that provider (an integration connected through it). */
export type SecretOAuthClient = { platform: OAuthIntegrationProvider };

/** What `secrets.beginOAuth(path, options)` takes: the provider's two endpoints, the OAuth client
 *  (the project's own in the clear, or an integration's `client`), the scope, the pin, and any extra
 *  authorize parameters the provider needs (Google: `access_type=offline`, `prompt=consent`). */
export type SecretOAuthOptions = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
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
   *  the platform's origin or the Dash's. Not with `redirect`, whose page is the landing. */
  next?: string;
  /** YOUR OWN CALLBACK, a page of this project's: `routingSlug`'s host (the apex when absent) at
   *  `path`, composed by the deployment's static rules alone: on the hostname its config pins to
   *  the project when it has one, else under its ingress, never on a hostname the project claimed,
   *  so it is the project's own by construction and holds still whatever the project claims or
   *  releases later. Register that URL at the provider as the app's redirect URI.
   *  The provider sends the human there with `code` and `state`, and the page, for members only
   *  (`auth.require`), hands both to `completeOAuth`, which exchanges the code inside the secret's
   *  facet: the page never sees a token. Without it, the provider sends the human to the platform's
   *  callback. Not with `client`: the deployment's app comes back to the callback registered for it.
   *  The URL follows the project: a rename moves the page, and the URI registered at the provider
   *  must follow. */
  redirect?: { routingSlug?: string; path: string };
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
};

/** How a lend to every project went, project by project: how many borrow it, the projects that
 *  keep a secret of their own at its path, and the ones whose borrow failed. */
export type EveryProjectBorrows = {
  borrowed: number;
  kept: string[];
  failed: { projectId: string; error: string }[];
};

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
 *  id as the gateway's log list shows it; a gateway may log other projects' calls too, so nothing
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
 *  (fetched by the platform through the project's egress, so the bytes never visit you), a project
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

/** `itx.cfArtifacts`: Cloudflare Artifacts, project-scoped and addressed BY THE REPO'S PATH — the
 *  binding's own verbs. `repos` is the friendlier surface. */
export interface CfArtifactsApi {
  /** The Artifacts repo, `main` unborn until the first commit; false when it already existed. */
  create(path: string): Promise<{ created: boolean }>;
  get(path: string): Promise<CfArtifactRepoApi>;
  /** This project's repos, as paths (one page). */
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
 *  a signed URL on the project host that downloads (`GET`, the default) or uploads (`PUT`) it. */
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

/** `itx.email.send`: one message from the project's own address. `inReplyToOffset` names a
 *  message on the project's `/integrations/email` and answers it in its thread: its recipients,
 *  `Re:` subject and threading headers are the defaults. Each attachment is a project file
 *  (`itx.files`). */
export type EmailSendInput = {
  /** The project's own address by default (a reply's: the address the answered message reached);
   *  the project that owns the deployment's project wildcard domain may name any address there
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
 *  `/projects/<project>/<routingSlug>` segment; subdomains make it `<routingSlug>--<project>` or
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
 *  expression they go to, who may use it (`project-members`: the config worker answers anyone else
 *  the sign-in challenge; absent or null: public) and its priority (higher first, then by name). */
export type FetchRouteInput = {
  requestMatcher: FetchRouteRequestMatcher;
  target: ItxExpressionInput;
  authRequirement?: { visitors: "project-members" } | null;
  priority?: number;
};

/** A live route as `list()` and `match` answer it, its target parsed, with the offset of the
 *  `itx/fetch-route-configured` fact that set it. */
export type FetchRouteEntry = {
  fetchRouteName: string;
  requestMatcher: FetchRouteRequestMatcher;
  target: ItxExpression;
  authRequirement: { visitors: "project-members" } | null;
  priority: number;
  configuredOffset: number;
};

/** One change a repo commit applies: a file's new content, or its deletion. */
export type RepoFileChange = { path: string; content: string } | { path: string; delete: true };
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
/** `itx.repos.get(path)`: the repo's verbs, branch `main` only (the repo facet in core/os). A
 *  `commitOid` pins a read to that commit; without one, a read is of the tip. */
export type RepoHandle = InvokeHandle & {
  tip(): Promise<string | null>;
  readFile(path: string, options?: { commitOid: string }): Promise<string | null>;
  /** The repo as a loaded worker's source: every file, or with `dir` those under that folder. */
  modules(options?: { commitOid?: string; dir?: string }): Promise<Record<string, string>>;
  listFiles(): Promise<{ commitOid: string | null; paths: string[] }>;
  commitFiles(input: {
    message: string;
    changes: RepoFileChange[];
    author?: { name: string; email: string };
    parent?: string | null;
  }): Promise<RepoCommitResult>;
  writeFile(path: string, content: string): Promise<RepoCommitResult>;
  log(options?: { limit?: number }): Promise<RepoLogEntry[]>;
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
/** `itx.workspaces.get(path)`: a private overlay over the project's repos, each repo mounted at its
 *  path (the workspace facet in core/os). Reads see the overlay, then the mounted repo's tip. */
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
 *  `enableInternet` (refused: a sandbox's only way out is the project's egress) and a
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
 *  sandbox of this project whose snapshot this one starts from (a golden toolset made once, then
 *  started many times). That snapshot is this sandbox's disk from then on. One of `image`,
 *  `containerSnapshot` and `from` at most. */
export type SandboxStartOptions = SandboxContainerStartOptions & { from?: string };

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
 *  project's egress is the platform's alone). */
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

/** `itx.sandboxes.get(path)`: a Linux container with a disk (the sandbox facet in core/os). `exec`
 *  and every call of `files` start the container when none runs, from the disk last saved, on
 *  `standard-1` unless `start({ instance })` says otherwise. Memory and running processes do not
 *  survive a stop; the disk does, for 30 days after its last restore and only on the image it was
 *  saved from (the platform's `iterate-dev-image`: Node 24 on Debian with git, gh, Chromium, ffmpeg,
 *  pnpm, the Claude, Codex and Grok CLIs, the cf CLI, doppler and the iterate CLI; `start({ image:
 *  "cloudflare/debian-trixie" })` is Cloudflare's lean one). NOTHING RUNS FOR NOTHING: a sandbox unused for `idleAfterMs` (five minutes by default; a
 *  command, a file call or a stream being read is use; a call left open counts for an hour at most)
 *  is saved and stopped, a sandbox in use has its disk saved every 15 minutes, and Cloudflare stops
 *  the container two hours after it last answered, whatever else fails. THE ONLY WAY OUT IS THE
 *  PROJECT'S EGRESS: the container starts with the internet off, and every HTTP and HTTPS request it
 *  makes, to any name or address, WebSocket handshakes included, is answered by the project's own
 *  `itx.fetch` (its rewrite rules;
 *  `getSecret("/secrets/…")` placeholders are substituted there). `apt-get` works through it. A
 *  project's GitHub connection is in every command's environment as placeholders (`GH_TOKEN`, and a
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

/** What a deployment's `plan` and `deploy` take, and nothing else: an unknown key is refused
 *  (INVALID_INPUT). */
export type DeploymentRunInput = {
  /** The release: a zip of bundle/, assets/ and migrations/ in the project's files, by its path
   *  (`/releases/<sha256>.zip` by convention), and its SHA-256 as 64 lowercase hex digits, which
   *  each attempt checks before it unzips the release. */
  release: { file: string; sha256: string };
  /** The whole iterate config, as one JSON string, its secrets inline: the object `pnpm run deploy`
   *  reads from iterate.config.ts and .secrets, with `cloudflare.apiToken`, the account's API token
   *  the deploy runs with and the Worker keeps. Its Worker must be the one that the deployment's
   *  path names. The facet parses it as the Worker does (a malformed field is refused by name) and
   *  keeps it in its own storage under an id of its own, never on the log: a run's fact names the
   *  release, the images, the account and that id. A destroy and the deletion's teardown run with
   *  the config of the last plan or deploy that opened a run. */
  config: string;
  /** Image name ⇒ its reference in the account's registry, pinned by digest
   *  (`registry.cloudflare.com/<account>/<name>@sha256:<digest>`). With none, a sandbox starts
   *  Cloudflare's managed image. */
  images?: Record<string, string>;
  /** The release's version, which the message of the Worker version names. */
  version?: string;
};

/** `itx.deployments.get(path)`: one deployment of core/os on Cloudflare (the deployment facet in
 *  core/os), run by Alchemy in the facet. The path's last segment is the Worker's name and
 *  Alchemy's stage. The config a run deploys, secrets and token included, is the run's input, kept
 *  in the facet's storage. A RUN IS A FACT: each verb appends `deployment/run-requested`
 *  and answers its offset at once, which is the run's id. The run lands on the path's log
 *  (`attempt-started`, `release-staged`, `run-planned`, `resource-applied`) and ends with one
 *  `deployment/run-settled`, which `itx.cd(path).waitForEvent({ type:
 *  "events.iterate.com/deployment/run-settled", payload: { requestOffset }, afterOffset:
 *  requestOffset })` follows. It says how the run ended: `succeeded` (with the Worker's `url` after
 *  a deploy), `refused` (an expected outcome: the request opened no run, or the release, the
 *  secret, the config or the token's reach refused it), `failed` (any other error, Cloudflare's
 *  answers among them: `error` names each by its tag; run it again) or `unavailable` (the
 *  attempt's own deadline, or the platform failed the facet's own calls; run it again), and
 *  `error` says why, with every secret value masked. If anything goes wrong, the stack is run
 *  again: an attempt lost with its incarnation starts again at once, four attempts at most.
 *  ONE RUN AT A TIME: a verb refuses RUN_IN_PROGRESS while a run is open. Every verb
 *  refuses until the deployment is created and once its deletion is asked.
 *  `itx.deployments.delete(path)` first destroys what the runs deployed: a destroy that fails keeps
 *  the deployment, and `delete` answers WAIT_TIMEOUT. Where the deployment stands is
 *  `(await handle.snapshot()).state`. */
export type DeploymentHandle = InvokeHandle & {
  /** Plan a deploy of the release: Alchemy's plan of each resource lands as `run-planned`, and
   *  nothing changes. */
  plan(input: DeploymentRunInput): Promise<{ requestOffset: number }>;
  /** Deploy the release: plan, then apply. */
  deploy(input: DeploymentRunInput): Promise<{ requestOffset: number }>;
  /** Destroy what the deployment's state holds, with the config its last plan or deploy kept.
   *  Refused (INVALID_INPUT) when no plan or deploy ran here. */
  destroy(): Promise<{ requestOffset: number }>;
  /** Append the deployment's own events on its context; its lifecycle facts are the
   *  collection's. */
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
};

/** An entity collection root (`itx.repos`, `itx.workspaces`, `itx.sandboxes`, `itx.deployments`): `get(path)` the entity's handle,
 *  `list()` the project catalog, `create(path)` the creation saga on that path (the parent link the
 *  caller's context writes first, then the processor row, the request, the terminal fact — created,
 *  or create-failed thrown), `delete(path)` the deletion saga (the request, `deleted` cross-posted to
 *  `/`, the row disabled). A relative `path` means the caller's. `get` and `list` reach the whole
 *  project; `create` and `delete` only paths strictly beneath the caller's context (FORBIDDEN). An
 *  entity whose creation has not landed refuses its handle's verbs and `delete` (NOT_CREATED). */
export type EntityCollectionApi<Handle> = {
  get(path: string): Handle;
  list(): Promise<{ path: string; createdAt: string }[]>;
  create(path: string): Promise<{ path: string }>;
  delete(path: string): Promise<{ path: string }>;
};

/** The roots an installable app adds by rewrite rule — present only on a context whose table has
 *  the rule (a project that installed the app), so never part of `IterateContextApi` itself. An
 *  installed app publishes its root by augmenting this interface from its own package
 *  (`declare module "iterate/api" { interface InstalledAppRoots { myApp: MyAppApi } }`), so a root
 *  the platform does not ship is never named here; a caller imports that module to spell
 *  `IterateContextApiWith<"myApp">`. */
export interface InstalledAppRoots {}

/** A context whose project installed the named apps: with the app's package imported,
 *  `IterateContextApiWith<"myApp">` spells `itx.myApp`. Code that holds a plain scope asserts it
 *  (`itx as IterateContextApiWith<"myApp">`) where it knows the app is installed. */
/** What `itx.telemetry.query` answers: the rows, and the SQL that ran for the project. */
export type TelemetryRows = { rows: Record<string, unknown>[]; sql: string };

export type IterateContextApiWith<App extends keyof InstalledAppRoots> = IterateContextApi &
  Pick<InstalledAppRoots, App>;

/** A context (a project, a user, an organization): every `itx` root, reached through `invoke`. */
export interface IterateContextApi {
  invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown>;
  /** Another context of this project, by path (`..` and `/` allowed; the global namespace is not). */
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
  whoami():
    | { projectId: string; path: string; projectSlug?: string; projectUrl?: string }
    | Promise<{ projectId: string; path: string; projectSlug?: string; projectUrl?: string }>;
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  /** This project's public URL over HTTP: the apex, or a routing slug's host (`blog--<project>`, or
   *  `blog.<primary hostname>` once the project has a primary hostname),
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
   *  Another context of the project: `itx.cd(path).abort()`. A rewrite rule masks it like any name
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
  /** The object store: the R2 binding's own verbs on the owner's slice of one bucket (every key
   *  prefixed, the prefix stripped from every key answered); what cannot cross the wire is answered
   *  as data — an `R2Object` as its fields, a body as its bytes. `list` is one page with its cursor.
   *  `presign` is a signed URL on the project host, a download or an upload. `files` is the
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
  /** The project's secrets, WRITE-ONLY: a secret IS its path (`/secrets/<name>`, the name
   *  `[a-zA-Z0-9._-]+`), and the path is what an outbound request's placeholder spells —
   *  `getSecret("/secrets/<name>")` in a URL or a header substitutes to the value at egress, and only
   *  towards the ORIGINS in `urls` (required: a secret is always pinned). `set` stores a string or a
   *  JSON object (`refresh` names the strategy that re-mints an expiring credential); `delete`
   *  forgets it (re-settable); `list` is the catalog — paths, pins, strategy kinds, when first set,
   *  public fields — never a secret value. Every change is one fact on the secret's path
   *  (`secret/set`, `secret/deleted`), attributed to the caller and cross-posted to the root, so the
   *  log says who set what and when; a fact that writes material carries it sealed
   *  (`SealedSecretCell`), so the log is the secret and the deployment's key reads it. */
  secrets: {
    set(
      path: string,
      material: SecretMaterial,
      /** `merge`: the material's fields go over the ones already stored, whose pin must be `urls`
       *  (a strategy added to a secret a person filled through `collectFromUser`). `public`: the
       *  names of the material's top-level string fields that are no secret (an OAuth client's
       *  `clientId`): the `secret/set` fact carries their values and the catalog answers them
       *  (`SecretCatalogEntry.public`). A merge keeps the ones the catalog has, under the new. */
      options: { urls: string[]; refresh?: SecretRefresh; merge?: boolean; public?: string[] },
    ): Promise<{ path: string }>;
    /** OAuth's first tokens: the provider's authorize URL to send a human to. The provider
     *  redirects them to the platform's callback (they must be signed in as someone who reaches the
     *  secret's owner), the secret's facet exchanges the code, `secret/set` lands, and the callback
     *  redirects to `next`. Only from a session, which carries the platform's origin. `nonce`
     *  names this attempt (the callback's signed `state` carries it); a later `beginOAuth` on the
     *  same path replaces it. */
    beginOAuth(
      path: string,
      options: SecretOAuthOptions,
    ): Promise<{ authorizationUrl: string; nonce: string }>;
    /** OAuth's second step, from your own callback page (`beginOAuth`'s `redirect`): the `code`
     *  and the `state` the provider sent back, as they came. The platform checks the state is one
     *  it signed for this very secret and still stands, exchanges the code inside the secret's facet
     *  (the PKCE verifier and the client secret live there), stores the tokens and lands
     *  `secret/set`. Answers the scopes the provider says it granted. The same callback again, a
     *  refreshed tab, answers the same and exchanges nothing twice. With `account`, answers the
     *  account the tokens are for too. An attempt begun without `redirect` (the platform's
     *  callback, a deployment app's) is refused here. */
    completeOAuth(
      path: string,
      input: { code: string; state: string },
    ): Promise<{ path: string; scopes: string[]; account?: { id: string; name: string | null } }>;
    delete(path: string): Promise<{ path: string }>;
    list(): Promise<SecretCatalogEntry[]>;
    /** Build the authenticated Dash link (`/collect-secret/<slug>`, a page of its own) where a
     * person enters a value an agent must never see in chat. The link fixes the project, platform
     * instance, secret path and egress pin, and shows `description` as the requester's words. If
     * called from an agent context, a successful submission messages that same agent with the path
     * only. */
    collectFromUser(input: CollectSecretInput): Promise<CollectSecretLink>;
    /** A webhook's signature checked against a secret WITHOUT revealing it: one bit back,
     *  constant-time, run in the secret's facet. A secret never set (or a material with no key at
     *  the field) answers false, never a description. */
    verifyHmac(path: string, input: SecretHmacVerification): Promise<boolean>;
    /** The HMAC-SHA256 of `payload` under a secret, WITHOUT revealing it: the signature comes back,
     *  the key never does, run in the secret's facet. For a provider that proves an endpoint by a
     *  challenge only the key's holder can answer (X's CRC). A secret never set, or a material with
     *  no key at the field, is refused (`SECRET_NOT_SET`). */
    signHmac(path: string, input: SecretHmacSigning): Promise<string>;
    /** A presented string compared with a secret WITHOUT revealing it, for a credential a caller can
     *  only send as it is (a webhook's static header token): one bit back, constant-time, run in the
     *  secret's facet. A secret never set (or no string at the field) answers false. A replayable
     *  token stays replayable: prefer `verifyHmac` wherever the sender signs. */
    verifyEquals(path: string, input: SecretEqualsVerification): Promise<boolean>;
    /** The operator's, on the global root (`session.global`): lend the deployment's own secret to
     *  a project, as the project's path `as`, or `to: "every-project"`: every project, one created
     *  later included, borrows it unless its path holds a secret of its own. The project's uses are
     *  forwarded to this secret, and the material never leaves it. `revokeLend` ends it; so does a
     *  project deleting its path, for that project alone. (A person's account reaches a project
     *  through `integrations.connect(provider, { account })` instead.) */
    lend(
      path: string,
      input: { to: string; as: string },
    ): Promise<{ lendId: string; everyProject?: EveryProjectBorrows }>;
    revokeLend(path: string, lendId: string): Promise<{ lendId: string }>;
  };
  /** Connect and disconnect this context's owner — a project (its root), or a person
   *  (`session.user`) — and a provider THROUGH THE DEPLOYMENT'S OWN APP there (`session.info()`'s
   *  `iterateAppProviders`; a project's own app at a provider is a package the project hosts,
   *  iterate/sdk `Integration`, which registers itself in `iterate/integrations`). `connect` answers
   *  where to send the human, and the connection's name; again for one that exists asks for more
   *  `scopes` on the same account. GitHub's `installationId` connects an installation the App
   *  already has, without GitHub's configure page. On a project, `account` connects one of YOUR
   *  accounts instead — the address the provider gives it, as `session.user`'s
   *  `state.integrations` lists it: with no `authorizationUrl` when it already holds what the
   *  project asks for, else one that asks the provider to add it. The project then uses it as
   *  `/secrets/<provider>-<connection>` while it stays connected and you stay a member.
   *  `disconnect` revokes the token where the provider allows and removes the connection, its secret
   *  and its webhook route; an account of yours disconnected from a project stays yours.
   *  `requestFromUser` answers a Dash link asking the signed-in person to connect the provider to
   *  this project. */
  integrations: {
    connect(
      provider: IntegrationProvider,
      options?:
        | {
            scopes?: string[];
            next?: string;
            connection?: string;
            installationId?: string;
            account?: never;
          }
        | {
            scopes?: string[];
            next?: string;
            account: string;
            connection?: never;
            installationId?: never;
          },
    ): Promise<{ authorizationUrl?: string; connection: string }>;
    disconnect(provider: IntegrationProvider, connection: string): Promise<void>;
    requestFromUser(
      provider: IntegrationProvider,
      options?: { scopes?: string[] },
    ): Promise<{ url: string }>;
  };
  /** The project's fetch routes, on its root `/`: which itx expression, the route's `target`, a
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
     *  `mainModule` as the project's publication of it recorded it. */
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
   *  `iterate-event-id: <projectId><path>@<offset>` (repeats share it) and, given a signing secret (a secret
   *  path pinned to `url`'s origin), `iterate-timestamp` and `iterate-signature: v1=<hex
   *  HMAC-SHA256 of "<timestamp>.<body>">`. A 2xx acks; any other status retries on the event's own
   *  ladder (~44 h); a 410 halts the row until a resume. `deliverEvent` is the delivery loop's call
   *  alone. A signature vouches for the PROJECT, not a context: a receiver checks the body's `path`,
   *  and loaded code names a signing secret only at the project's root. */
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
    target: ItxExpressionInput | ((events: unknown[], range: unknown) => void) | null;
    consumes?: string[];
    afterOffset?: number;
    /** `false`: FAN-OUT delivery — one event per call (`deliverEvent(event)`), in any order, each
     *  retried and dead-lettered on its own. Absent: the ordered queue, the one that may take a
     *  dead letter (`itx/subscription-delivery-failed`): alert on dead letters from an ordered row. */
    ordered?: false;
  }): Promise<{ [Symbol.dispose](): void }>;
  /** A rewrite rule of this context, session-scoped (the handle's dispose removes it): make `match`
   *  mean `target`, an expression, a live stub, or null to deny. `description` is the one line a
   *  model reads for the name. `fetchRoute` (a live stub, on the project's root) is a fetch route to
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
  /** The project's repos and workspaces as domain objects — one shape each: `get(path)` is
   *  the entity's facet on the context at `path` (its verbs, plus the typed `append` on that
   *  context), `list()` the project catalog, `create(path)` the creation saga on that path (the
   *  parent link the caller's context writes first, then the processor row, the request, the
   *  terminal fact — created, or create-failed thrown), `delete(path)` the deletion saga (the
   *  request, `deleted` cross-posted to `/`, the row disabled). A relative `path` means the caller's. */
  repos: EntityCollectionApi<RepoHandle>;
  workspaces: EntityCollectionApi<WorkspaceHandle>;
  /** Linux containers with a disk: `create(path)` once, then `get(path).exec("make test")`. */
  sandboxes: EntityCollectionApi<SandboxHandle>;
  /** Deployments of core/os on Cloudflare: `create(path)` once, then `get(path).deploy({ … })`. */
  deployments: EntityCollectionApi<DeploymentHandle>;
  /** Workers AI's binding (`ItxAiApi`), under this context's capability rules. */
  ai: ItxAiApi;
  /** Cloudflare Browser Run. */
  browser: CfBrowserApi;
  /** Cloudflare Images: `info` and `transform` over image bytes. */
  images: CfImagesApi;
  /** Cloudflare Artifacts, project-scoped (`repos` is the friendlier surface). */
  cfArtifacts: CfArtifactsApi;
  /** Files stored in the project's object store, by path (`r2` underneath). */
  files: {
    get(path: string): InvokeHandle & FileHandle;
    list(prefix?: string): Promise<FileRecord[]>;
  };
  /** THE PROJECT'S TELEMETRY (docs/telemetry.md): `query(sql, { hours })` runs one SELECT over
   *  `events`, `logs` and `spans` (Basin SQL), or over `metrics` alone (Workers Analytics Engine),
   *  each cut to this project's rows of the last `hours` (default 24, at most 720), and answers the
   *  rows with the SQL that ran. Throws on a deployment with no warehouse. */
  telemetry: { query(sql: string, options?: { hours?: number }): Promise<TelemetryRows> };
  /** The project's email, `<slug>@iterate.app` (core/os/src/email/contract.ts has its events and
   *  threads). `send` answers the `email/sent` event. */
  email: {
    send(input: EmailSendInput): Promise<StreamEvent>;
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

/** What a grant is: a sign-in not yet exchanged, a device's key, a personal access token, or a
 *  browser or app session. A client labels it for display. */
export type GrantKind = "pending" | "device" | "personal" | "session";

/** One grant as `grants.list()` shows it: a session or a connected app (an OAuth grant), or a
 *  personal access token or a device's key (the account's own API key, `pat_…`). */
export interface GrantRecord {
  id: string;
  clientId?: string;
  logoUri?: string;
  clientDomain?: string;
  name: string;
  kind: GrantKind;
  /** An OAuth grant's one resource: Cap'n Web at `/api` (and the projects' hosts), or `/mcp`. A
   *  personal access token has none: it works at `/api`, at `/mcp` and on its projects' hosts. */
  resource?: "api" | "mcp";
  /** A personal access token's projects, by id: all it reaches. */
  projects?: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  expired: boolean;
  /** The grant this very session rides on. */
  current?: boolean;
  /** A personal access token's: the grant of the session that minted it (listed here while it
   *  lives). */
  mintedBy?: string;
  /** A platform admin's sign-in as this person: the admin's email. */
  impersonatedBy?: string;
}

/** What the consent screen shows for an authorization request. */
export type ConsentAnswer =
  | {
      kind: "consent";
      query: string;
      clientName: string;
      email: string;
      projects: ProjectRecord[];
      orgs: OrgRecord[];
      projectBound: boolean;
      /** the scopes the request asked for, each with the page's copy (oauth-scopes.ts) */
      scopes: ConsentScope[];
      denyLocation: string;
      /** how projects are reached over HTTP (project-ingress.ts) — the page composes a project's URL */
      ingressRouting: IngressRouting;
      /** the onboarding step's first draft of an organization name, from the person's name or email */
      suggestedOrganizationName: string;
    }
  | {
      /** a client asking only who the person is (the platform's `/oauth2/userinfo` resource) */
      kind: "identify";
      clientName: string;
      clientId: string;
      email: string;
      denyLocation: string;
    }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };

/** An organization's invitation link as its owners see it (`expiresAt` ISO). */
export interface InvitationRecord {
  id: string;
  orgId: string;
  role: "owner" | "member";
  emailHint: string | null;
  expiresAt: string;
}

/** An organization as the session lists it: its minted id, its free-text name, the person's role
 *  in it, and how many projects it holds (every one of them, not only those this grant lists). */
export interface OrgRecord {
  id: string;
  name: string;
  role?: "owner" | "member";
  projects: number;
}

/** A project as the catalog lists it: addressed by `id` everywhere (`projects.get`, a grant's list,
 *  an MCP call's `project`, an app's URL); `slug` is the label of its hostnames and its name to a
 *  person, which `projects.rename` changes. The id is the one stable identifier. */
export interface ProjectRecord {
  id: string;
  slug: string;
  orgId: string;
}

/** The session `authenticate` vends: who is calling, and the contexts they reach. */
export interface IterateSessionApi {
  whoami(): Principal;
  /** Safe bootstrap data for every app, regardless of which host serves it. */
  info(): {
    principal: Principal;
    scopes: string[];
    platformOrigin: string;
    /** how projects are reached over HTTP (project-ingress.ts `projectUrlOf`); null ⇒ no ingress */
    ingressRouting: IngressRouting;
    /** the hostnames this deployment's config pins to projects, each naming its project by id or
     *  slug (project-ingress.ts `pinnedHostnameOf`): a project's primary hostname before any it
     *  claimed, which `itx.url` and the dash's buttons compose on */
    projectHostnames: { hostname: string; project: string }[];
    /** the MCP server's origin (the dash's connect page) — "" when this deployment serves none */
    mcpOrigin: string;
    /** the providers whose iterate app this deployment holds (ITERATE `integrations`): a
     *  project connects through iterate's app only there; its own app at a provider is a package
     *  it hosts (iterate/sdk `Integration`), which registers itself in `iterate/integrations` */
    iterateAppProviders: IntegrationProvider[];
    /** what iterate's app asks for there, by provider — what a project needs of your account before
     *  it uses it (`integrations.connect(provider, { account })`) */
    iterateAppScopes: Partial<Record<OAuthIntegrationProvider, string[]>>;
    /** the providers a person signs in with here: the ones a signed-in person can add to their
     *  account (the issuer's `/.auth/identity/<provider>?link=<userId>`) */
    signInProviders: SignInProvider[];
  };
  /** The grants this session may manage (a signed-in person's with the `account` scope): list and
   *  end its sessions and personal access tokens, and mint a personal access token — its bearer
   *  answered once, `expiresAt` null for a key that never expires. */
  grants: {
    list(cursor?: string): Promise<{
      items: GrantRecord[];
      cursor?: string;
      projects: ProjectRecord[];
      canMintToken: boolean;
    }>;
    end(grantId: string): Promise<unknown>;
    endCurrent(): Promise<unknown>;
    mint(input: {
      name: string;
      /** project ids, each one the person reaches */
      projects: string[];
      /** epoch ms; omitted, the key never expires */
      expiresAt?: number;
      /** a device's public client metadata document (Kit): the key is listed as that device */
      clientId?: string;
    }): Promise<{ id: string; token: string; expiresAt: number | null }>;
  };
  /** The consent screen's methods (the OAuth authorize flow): describe a request, approve it. */
  consent: {
    describe(query: string): Promise<ConsentAnswer>;
    approve(input: {
      query: string;
      projects: string[];
      /** a platform admin's "Sign in as someone else…": the person's user id */
      impersonate?: string;
    }): Promise<{ redirectTo: string } | { error: string }>;
  };
  projects: {
    /** oldest first (a grant bound to projects with no user: in the grant's order) */
    list(): Promise<ProjectRecord[]>;
    /** the project's root context, by its slug or its id */
    get(project: string): Promise<IterateContextApi>;
    /** Config repository presets available on this platform, besides the minimal config a
     *  creation that names no template gets: core/configs/default first, which the dash and the
     *  consent page start a person's project from. */
    templates(): Promise<
      [{ label: string; reference: string }, ...{ label: string; reference: string }[]]
    >;
    /** a new project: `project` is slugged into its hostname label, its id is minted — the returned
     *  context's `whoami()` says it, so does `list()` */
    create(input: {
      project: string;
      orgId?: string;
      configRepoTemplate?: string;
      /** Operator-only recovery: retain the source project identity from a project seed. */
      restoreProjectId?: string;
    }): Promise<IterateContextApi>;
    /** Rename a project, by its slug or its id — its organization's owner, or the operator; anyone
     *  else is refused (FORBIDDEN). `slug` is the new label of its hosts (`<slug>.<hostname>`,
     *  `<routingSlug>--<slug>.<hostname>`, `/projects/<slug>/…`) and the local part of its email
     *  address, given as a slug (lowercase letters and digits, words joined by single dashes:
     *  INVALID_INPUT otherwise) that no other project holds (PROJECT_NAME_TAKEN). Answers the row
     *  renamed: from then on the project answers on the new hosts and address, and the old ones
     *  name nothing (another edge isolate may serve the old ones for up to five seconds). The id
     *  stays, and so does everything keyed by it: contexts, data, custom hostnames, connections,
     *  grants. Refused while the deployment's config names the project by its slug
     *  (`urls.projectHostnames`, `urls.projectWildcard`): name it by its id there first. The same
     *  slug again changes nothing. Lands `events.iterate.com/project/renamed` on the project's root
     *  and `events.iterate.com/organization/project-renamed` on its organization. */
    rename(project: string, input: { slug: string }): Promise<ProjectRecord>;
    /** Delete a project, by its slug or its id — its organization's owner, or the operator; anyone
     *  else is refused (FORBIDDEN). Answers once nothing reaches the project any more (its row is
     *  gone, and its slug free); its contexts, hostnames and storage are destroyed after, by the
     *  deletion saga on its root. There is no undo. */
    delete(project: string): Promise<void>;
  };
  /** The organizations this session reaches — the person's memberships (a grant narrowed to
   *  projects sees only their organizations, unless it holds `organizations:write`): the rows, its
   *  members and open invitation links, the organization's context by membership, and the verbs
   *  (`organizations:write`; the person is the owner of what they create, and only an owner
   *  renames, deletes or changes members). The reads are the control plane's catalog, as it stands;
   *  each verb is a request it answers, a refusal a coded error (FORBIDDEN, INVALID_INPUT), and
   *  lands its facts on the organization's context (and a member's account) after. */
  organizations: {
    /** oldest first */
    list(): Promise<OrgRecord[]>;
    /** the organization's context — `session.user` for an organization — by membership: its
     *  activity, `events.iterate.com/organization/…` facts, and its own secrets */
    get(orgId: string): Promise<IterateContextApi>;
    /** the person is its owner; the operator names the owner (`ownerId`) */
    create(input: { name: string; ownerId?: string }): Promise<OrgRecord>;
    rename(orgId: string, input: { name: string }): Promise<OrgRecord>;
    /** only while it holds no project */
    delete(orgId: string): Promise<void>;
    addMember(orgId: string, input: { userId: string; role?: "owner" | "member" }): Promise<void>;
    removeMember(orgId: string, input: { userId: string }): Promise<void>;
    /** the members with their emails, by membership, in the order they joined: `createdAt` is
     *  when they joined (epoch ms) */
    members(
      orgId: string,
    ): Promise<{ userId: string; email: string; role: "owner" | "member"; createdAt: number }[]>;
    /** the invitation links still open (an expired one stays until revoked), oldest first — an
     *  owner's */
    invitations(orgId: string): Promise<InvitationRecord[]>;
    /** an owner's invitation link: whoever accepts it first joins in `role` (default member),
     *  until it expires (`expiresInDays`, default 7, 1–30). `token` is the link's secret, answered
     *  this once — the dash's `/invitations/<token>`. */
    createInvitation(
      orgId: string,
      input?: { role?: "owner" | "member"; emailHint?: string; expiresInDays?: number },
    ): Promise<InvitationRecord & { token: string }>;
    /** an owner withdraws an open link by its id */
    revokeInvitation(orgId: string, input: { invitationId: string }): Promise<void>;
    /** what a link opens, for the signed-in person holding it; null when it names nothing */
    invitation(token: string): Promise<
      | (InvitationRecord & {
          orgName: string;
          status: "pending" | "accepted" | "revoked" | "expired";
          /** the reader already belongs */
          member: boolean;
          /** the reader is the one who accepted it — accepting again answers the same and lands
           *  the membership's facts again */
          acceptedByYou: boolean;
        })
      | null
    >;
    /** join the organization a link opens, in its role — single use: the first person to accept
     *  consumes it (again by them answers the same; anyone after is refused INVALID_INPUT) */
    acceptInvitation(token: string): Promise<OrgRecord>;
  };
  user: IterateContextApi;
  /** The global namespace's root `/` — a platform admin's session (the `admin` scope) or the
   *  operator bearer's alone. Its `cd` reaches `/users/<id>…`, `/organizations/<id>…` and
   *  `/secrets/<name>…`, as a project root's reaches the project; its `secrets` are the deployment's
   *  own, which the operator lends to projects. */
  global: IterateContextApi;
  /** Every person on the platform — a platform admin's session (the `admin` scope) or the
   *  operator's alone. */
  users: {
    list(): Promise<{ id: string; email: string }[]>;
    /** by id or email */
    get(ref: string): Promise<{ id: string; email: string } | null>;
    /** find-or-create */
    create(input: { email: string }): Promise<{ id: string; email: string }>;
  };
  /** Every context Cloudflare lists, by id — the operator's alone (scripts/ci/context-sweep.ts):
   *  who each is, from its own birth record; its durable log a page at a time, as `readEvents`
   *  pages it, which the sweep backs an orphan up with; and an orphan's destruction (refused for a
   *  global context and for any project that still exists). Neither `identify` nor `readEvents`
   *  records a wake. */
  contexts: {
    identify(
      ids: string[],
    ): Promise<({ id: string; projectId: string; path: string } | { id: string; error: string })[]>;
    readEvents(id: string, afterOffset: number): Promise<StreamPage>;
    destroy(id: string): Promise<{ projectId: string; path: string }>;
  };
  /** One project secret's encrypted cell, as a project seed archives it — the operator's alone
   *  (scripts/os/project-seed.ts). */
  exportProjectSecretForSeed(project: string, path: string): Promise<unknown>;
  /** The version this edge runs and the one each named project's root context runs, at most eight
   *  — the operator's alone (scripts/os/preview-readiness.ts). */
  versions(projectIds: string[]): Promise<{ edge: string; contexts: string[] }>;
  logout(): unknown;
}

/** THE `/api` ROOT — the one thing a fresh capnweb connection holds. */
export interface IterateApi {
  authenticate(credentials: SessionCredentials): Promise<IterateSessionApi>;
}
