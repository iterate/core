// stack.ts — A MIND AS ONE PLAIN ALCHEMY STACK: five Workers in the owner's own Cloudflare account,
// and what they bind. One input (./config.ts), one deploy that makes everything, and no step
// before or after `alchemy deploy` but the mind Worker's build.
//
//   telemetry  takes the other Workers' logs and spans, and the mind's events and metrics
//   auth       the mind's own sign-in: people, passkeys, the OAuth issuer at the control-plane hostname
//   secrets    the mind's secrets, and the approvals of what leaves the mind
//   mind       the one Worker that hosts the mind's contexts, its repos, files and sandboxes
//   boundary   the only Worker on the mind's zones: every request and every mail comes in here
//
// One more address is public: the telemetry Worker's, on workers.dev, where Cloudflare posts the
// other Workers' logs and spans with a bearer secret. It answers nothing else.
//
// `config.topology` says where the mind runs. "full-cloudflare": the mind Worker is in this stack.
// "external-mind-connects-into-cloudflare-boundary": it runs on a machine of the owner's and
// connects in. The stack then has no mind Worker and nothing that only a mind Worker binds, and
// the boundary, the same build, holds the connection in a Durable Object of its own.
//
// The stack generates four keys (three with an external mind) and keeps one owner-created
// telemetry API token in state, when it is given one. With a token it makes the telemetry
// tables; with none it makes their bucket and streams and no tables, and the mind reads
// Cloudflare's own datasets and `metrics` through `itx.telemetry.query`. It makes no OAuth client: a
// member connects the mind to the account through Cloudflare's MCP server, for which the mind is
// its own client (core/configs/default/cloudflare.ts).
// An owner signs in first with a code mailed to their address, by the mind or by Cloudflare
// Access, and adds a passkey.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { domainOfOwnerEmailPattern } from "iterate/mind-config";
import { z } from "zod";
import { AccessTeam } from "./access-team.ts";
import { ArtifactsNamespace } from "./artifacts-namespace.ts";
import { ArtifactsRepoSubscription } from "./artifacts-repo-subscription.ts";
import { CatalogTablesOfSinks } from "./catalog-tables-of-sinks.ts";
import { type MindConfig, namesOf } from "./config.ts";
import { bindAnalyticsSql } from "./analytics-sql-binding.ts";
import { MindMadeTelemetryTables, telemetryTableNames } from "./mind-made-telemetry-tables.ts";
import { REALTIME_SFU, realtimeConfigOf, TURN_KEY } from "./realtime.ts";
import { type TelemetryMode, TelemetryToken } from "./telemetry-token.ts";

const core = (path: string) => resolve(import.meta.dirname, "../..", path);
/** A Worker's fetch to a hostname of its own zone reaches the Worker routed there. */
const STRICTLY_PUBLIC = "global_fetch_strictly_public";
/** WebCrypto's ML-DSA-65, which a record of a mind's identity is signed with
 *  (iterate/mind-identity): the auth Worker checks each record that is posted to it, and the mind
 *  Worker checks another mind's log. Without the flag the runtime has no such key. */
const ML_DSA = "webcrypto_modern_algorithms";
/** A generated key's props: 32 random bytes, as hex. Alchemy keeps a key's value in the state
 *  whatever its props say, but plans an update for a change of them; the live minds' keys were
 *  made with these props written out. */
const KEY = { bytes: 32 };
/** Every log line and every span, kept in Cloudflare's own Workers Logs. A stack's traces take
 *  their share from its config (`telemetry.traceSampling`, ./config.ts); its log lines are kept
 *  whole. */
const KEEP_ALL = { enabled: true, headSamplingRate: 1, persist: true };
/** What every Worker of the mind gets as its variable `ITERATE` (iterate/mind-config
 *  `MindConfig`): the same object for each, since they have the same trust level. */
const sharedConfigOf = (config: MindConfig) => ({
  mindId: config.mindId,
  controlPlaneHostname: config.controlPlaneHostname,
  zones: config.cloudflare.zones,
  ownerEmails: config.ownerEmails,
  // absent with no pattern: JSON leaves it out, so such a mind's variable is as it was
  ownerEmailPatterns: config.ownerEmailPatterns?.length ? config.ownerEmailPatterns : undefined,
  topology: config.topology,
});
/** A stream's fields, as a file of core/telemetry-worker/schemas lists them. */
const TelemetryStreamFields = z.strictObject({
  fields: z.array(
    z.strictObject({
      name: z.string(),
      type: z.enum(["string", "int32", "int64", "float64", "timestamp"]),
      required: z.boolean(),
    }),
  ),
});

export const mindStack = (config: MindConfig, options: { telemetryMode?: TelemetryMode } = {}) =>
  Effect.gen(function* () {
    const names = namesOf(config);
    const { accountId, zones } = config.cloudflare;
    const mindIsInTheStack = config.topology === "full-cloudflare";
    const telemetryMode = options.telemetryMode || "given";
    // the share of requests whose trace Cloudflare keeps: every one unless the config says less
    const traces = { ...KEEP_ALL, headSamplingRate: config.telemetry?.traceSampling ?? 1 };

    // ── keys, generated once and kept in the stack's state: each is a secret of its Worker ──
    const atRestKey = yield* Alchemy.makeRandom("SecretsAtRestKey", KEY);
    const authSigningKey = yield* Alchemy.makeRandom("AuthSigningKey", KEY);
    const otlpSecret = yield* Alchemy.makeRandom("TelemetryOtlpSecret", KEY);

    // ── telemetry: first, because every other Worker exports its logs and spans to it ──
    // Three modes (./telemetry-token.ts `telemetryModeOf`):
    //   - "minted": two stack-managed AccountApiToken resources.
    //   - "given": one owner-created TelemetryToken kept in state.
    //   A deploy takes no new token, so a stack's mode never changes from "off".
    //   - "off": no token. The bucket, the streams and the OTLP destinations are made, and no
    //     catalog, sink or pipeline. A destroy removes the ones that the mind's own code made
    //     (./mind-made-telemetry-tables.ts). A stream with no pipeline keeps what it is sent,
    //     and a pipeline made later writes it into the table (measured on 20 Nov 2026).
    const telemetryBucket = yield* Cloudflare.R2.Bucket("TelemetryBucket", {
      name: names.telemetryBucket,
      forceDestroy: true,
      // A sink leaves multipart uploads open, and a destroy can abort them only with a token
      // that it can read. With this rule R2 aborts them itself after a day.
      lifecycleRules: [
        {
          id: "abort-stale-uploads",
          abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86_400 } },
        },
      ],
    });
    /** The stream that a Worker writes, one for each table. A changed schema replaces the stream,
     *  and what the old one still held is lost: a column change is a new table. */
    const streamOf = (table: "events" | "logs" | "spans") =>
      Cloudflare.Pipelines.Stream(`Telemetry_${table}_stream`, {
        name: telemetryTableNames(names.telemetryTables, table).stream,
        format: { type: "json" },
        http: false,
        workerBinding: { enabled: true },
        schema: TelemetryStreamFields.parse(
          JSON.parse(readFileSync(core(`telemetry-worker/schemas/${table}.json`), "utf8")),
        ),
      });
    const streams = {
      EVENTS: yield* streamOf("events"),
      LOGS: yield* streamOf("logs"),
      SPANS: yield* streamOf("spans"),
    };
    // The tables that the mind made itself, which a destroy removes before the bucket and the
    // streams go. A stack's mode never changes, so a live stack never loses this resource.
    if (telemetryMode === "off")
      yield* MindMadeTelemetryTables("TelemetryTablesOfTheMind", {
        accountId,
        bucket: telemetryBucket.bucketName,
        streams: [streams.EVENTS.name, streams.LOGS.name, streams.SPANS.name],
        tables: names.telemetryTables,
      });
    let telemetryTokenBindings:
      | { ITERATE__CATALOG_TOKEN: Output.Output<Redacted.Redacted<string>> }
      | undefined;
    if (telemetryMode !== "off") {
      let catalogTokenValue: Output.Output<Redacted.Redacted<string>>;
      if (telemetryMode === "minted") {
        // The stack-managed catalog token keeps existing sinks bound to the credential they were
        // created with; removing or replacing it stops catalog sink writes. (A stack minted an
        // analytics token beside it until 22 Nov 2026; nothing reads it now, since `metrics` is
        // read on the Analytics SQL binding, so a deploy deletes it.)
        const catalogToken = yield* Cloudflare.ApiToken.AccountApiToken("TelemetryCatalogToken", {
          name: `${names.telemetryBucket}-catalog`,
          policies: [
            {
              effect: "allow",
              permissionGroups: ["Workers R2 Data Catalog Write"],
              resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            },
            {
              effect: "allow",
              permissionGroups: ["Workers R2 Storage Bucket Item Write", "Workers R2 SQL Read"],
              resources: {
                [`com.cloudflare.edge.r2.bucket.${accountId}_default_${names.telemetryBucket}`]:
                  "*",
              },
            },
          ],
        });
        catalogTokenValue = catalogToken.value;
      } else {
        // One API token of the account, created by the owner in Cloudflare's dashboard and kept in
        // Alchemy's state (./telemetry-token.ts). It holds Workers R2 Data Catalog Write, Workers R2
        // Storage Bucket Item Write and Workers R2 SQL Read, and the telemetry Worker alone
        // receives it, for the catalog, the sinks and the tables' queries.
        const telemetryToken = yield* TelemetryToken("TelemetryToken", {
          name: names.telemetryBucket,
        });
        catalogTokenValue = telemetryToken.value;
      }
      const telemetryCatalog = yield* Cloudflare.R2.DataCatalog("TelemetryCatalog", {
        bucket: telemetryBucket,
        token: catalogTokenValue,
        compaction: { state: "enabled" },
        snapshotExpiration: { state: "enabled", maxSnapshotAge: "1d", minSnapshotsToKeep: 5 },
      });
      // The sinks' tables, which a destroy drops after the sinks and before the catalog: R2 keeps
      // a catalog's tables, and Cloudflare makes no sink for a table that exists.
      const sinkTables = yield* CatalogTablesOfSinks("TelemetrySinkTables", {
        catalogUri: telemetryCatalog.catalogUri,
        catalogId: telemetryCatalog.catalogId,
        token: catalogTokenValue,
        namespace: "telemetry",
        tables: ["events", "logs", "spans"],
      });
      // Each table's sink, which writes its stream's rows into the table as Parquet, and the
      // pipeline between the two.
      for (const [table, stream] of [
        ["events", streams.EVENTS],
        ["logs", streams.LOGS],
        ["spans", streams.SPANS],
      ] as const) {
        const sink = yield* Cloudflare.Pipelines.Sink(`Telemetry_${table}_sink`, {
          name: telemetryTableNames(names.telemetryTables, table).sink,
          type: "basin_catalog",
          catalog: telemetryCatalog,
          table: { namespace: sinkTables.namespace, name: table },
          token: catalogTokenValue,
          format: { type: "parquet", compression: "zstd", rowGroupBytes: 32 * 1024 * 1024 },
          rollingPolicy: { intervalSeconds: 60 },
        });
        yield* Cloudflare.Pipelines.Pipeline(`Telemetry_${table}_pipeline`, {
          name: telemetryTableNames(names.telemetryTables, table).pipeline,
          sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}`,
        });
      }
      telemetryTokenBindings = { ITERATE__CATALOG_TOKEN: catalogTokenValue };
    }
    const telemetryMetrics = yield* Cloudflare.AnalyticsEngine.Dataset("TELEMETRY_METRICS", {
      dataset: names.telemetryMetrics,
    });
    const telemetry = yield* Cloudflare.Worker("Telemetry", {
      name: names.telemetry,
      main: core("telemetry-worker/src/worker.ts"),
      compatibility: { date: COMPATIBILITY_DATE },
      // never exported to itself: a failure to land would make more of what failed to land
      observability: { ...KEEP_ALL, logs: { ...KEEP_ALL, invocationLogs: true }, traces },
      // Cloudflare's export posts to this workers.dev address. The other Workers name the
      // export's destinations, so the intake cannot be behind one of them.
      workersDev: { enabled: true, previewsEnabled: false },
      env: {
        ITERATE: JSON.stringify({
          ...sharedConfigOf(config),
          accountId,
          telemetryBucketName: names.telemetryBucket,
          metricsDatasetName: names.telemetryMetrics,
          // an external mind writes no log to Cloudflare, and no Worker writes its events
          workerNamesThatQueriesReadWhole: mindIsInTheStack
            ? [names.mind, names.boundary]
            : [names.boundary],
          // Every Worker of the stack: the mind reads the log lines of them all, so its crash job
          // sees a crash of any (core/configs/default/apps/telemetry/crashes.ts). Their spans
          // stay out: a span of the vault's outbound fetch can hold what the vault put in.
          workerNamesWhoseLogsQueriesRead: [
            ...(mindIsInTheStack ? [names.mind] : []),
            names.boundary,
            names.auth,
            names.secrets,
            names.telemetry,
          ],
          eventsWriterName: mindIsInTheStack ? names.mind : "external-mind",
        }),
        ITERATE__OTLP_SECRET: otlpSecret,
        ...telemetryTokenBindings,
        ...streams,
        METRICS: telemetryMetrics,
      },
    });
    // `ANALYTICS`: Cloudflare's own datasets, read with no token and cut to the mind's rows
    // (core/telemetry-worker/src/store-query.ts)
    yield* bindAnalyticsSql(telemetry, "ANALYTICS");
    const telemetryDestination = (dataset: "logs" | "traces") =>
      Cloudflare.Workers.ObservabilityDestination(`Telemetry_${dataset}`, {
        name: `${names.telemetry}-${dataset}`,
        url: Output.interpolate`${telemetry.url}/v1/${dataset}`,
        headers: {
          authorization: Output.map(otlpSecret, (secret) =>
            Redacted.make(`Bearer ${Redacted.value(secret)}`),
          ),
        },
        logpushDataset: `opentelemetry-${dataset}`,
        enabled: true,
        // a fresh workers.dev hostname is not routed everywhere yet (1042)
        skipPreflightCheck: true,
      });
    const logsDestination = yield* telemetryDestination("logs");
    const tracesDestination = yield* telemetryDestination("traces");

    // ── the settings that the four Workers below share ──
    const sharedWorkerProps = {
      observability: {
        ...KEEP_ALL,
        logs: {
          ...KEEP_ALL,
          invocationLogs: true,
          destinations: [logsDestination.slug],
        },
        traces: {
          ...traces,
          destinations: [tracesDestination.slug],
        },
      },
      // a Durable Object runs a deploy's code at once, as the Worker in front of it does
      codeUpdateStrategy: { mode: "immediate" } satisfies Cloudflare.WorkerCodeUpdateStrategy,
      workersDev: { enabled: false, previewsEnabled: false },
    };

    // ── Cloudflare Access proves an owner's address: one application, at one path ──
    // An owner with no passkey yet opens that path. Cloudflare mails a code to the address, from
    // its own domain, and then signs a token that names the address. The auth Worker checks the
    // token itself (core/auth-worker/src/access-sign-in.ts). The policy names the owners alone,
    // each by address, and every address at the domain of an owner email pattern: nobody else
    // gets a code, so no other person ever takes a seat of the account's team.
    // Its name is the control plane's hostname: Cloudflare's code page says "Log in to <name>"
    // to the owner. A new name changes the application in place, and its `aud` stays.
    const accessTeam = yield* AccessTeam("AccessTeam");
    const ownerEmailProof = yield* Cloudflare.Access.Application("OwnerEmailProof", {
      type: "self_hosted",
      name: config.controlPlaneHostname,
      domain: `${config.controlPlaneHostname}/sign-in/access`,
      // the token's cookie goes to that path alone, and to no other page of the control plane
      pathCookieAttribute: true,
      // the PIN login alone, and no page that offers the account's other logins
      allowedIdps: [accessTeam.pinLoginId],
      autoRedirectToIdentity: true,
      appLauncherVisible: false,
      // how long a token proves the address: the time to add the passkey, and little more
      sessionDuration: "15m",
      policies: [
        {
          name: "owners",
          decision: "allow",
          include: [
            ...config.ownerEmails.map((email) => ({ email })),
            ...(config.ownerEmailPatterns || []).map((pattern) => ({
              emailDomain: { domain: domainOfOwnerEmailPattern(pattern) },
            })),
          ],
          require: [{ loginMethod: accessTeam.pinLoginId }],
        },
      ],
    });

    // ── auth ──
    const auth = yield* Cloudflare.Worker("Auth", {
      ...sharedWorkerProps,
      name: names.auth,
      main: core("auth-worker/src/worker.ts"),
      compatibility: { date: COMPATIBILITY_DATE, flags: [STRICTLY_PUBLIC, ML_DSA] },
      env: {
        // the shared config, and whose tokens prove an owner's address: the team's, for the
        // application above
        ITERATE: Output.all(accessTeam.teamDomain, ownerEmailProof.aud).pipe(
          Output.map(([cloudflareAccessTeamDomain, cloudflareAccessAudienceTag]) =>
            JSON.stringify({
              ...sharedConfigOf(config),
              cloudflareAccessTeamDomain,
              cloudflareAccessAudienceTag,
            }),
          ),
        ),
        ITERATE__SIGNING_KEY: authSigningKey,
        DB: yield* Cloudflare.D1.Database("AuthDb", {
          name: names.authDb,
          // from the working directory, never absolute: the path is kept in the stack's state,
          // and an absolute one differs between the machines that deploy
          migrations: relative(process.cwd(), core("auth-worker/migrations")),
        }),
        OAUTH_KV: yield* Cloudflare.KV.Namespace("AuthKv", { title: names.authKv }),
        // The auth Worker mails a sign-in code from the zone of the app that a person signs in
        // to, and its own self-test: from these addresses alone.
        SEND_EMAIL: yield* Cloudflare.Email.SendEmail("AUTH_SEND_EMAIL", {
          allowedSenderAddresses: [
            ...zones.map((zone) => `sign-in@${zone}`),
            `self-test@${zones[0]}`,
          ],
        }),
      },
    });

    // ── the stack's Realtime SFU app and TURN key at Cloudflare: calls work from the first deploy ──
    // Neither costs anything until a call uses it. Cloudflare shows each one's secret only when
    // it makes it: the stack's state keeps it. A deploy whose credential may not make Realtime
    // (Calls) resources makes neither, and says so in one line (./realtime.ts).
    const realtimeSfu = yield* Cloudflare.Calls.App(REALTIME_SFU, { name: names.realtimeSfu });
    const turnKey = yield* Cloudflare.Calls.TurnKey(TURN_KEY, { name: names.turnKey });

    // ── the egress gateway that this deploy names: a Worker of the owner's, in the account ──
    // The stack does not make it: `lookup` finds it by its name, the deploy fails when no Worker
    // has that name, and Alchemy never updates or deletes it. The vault and the boundary get it
    // as a service binding and send what leaves the stack through its fetch (iterate/lib
    // `fetchLeavingTheStack`). A deploy that names none binds nothing, and the platform's fetch
    // sends.
    const egressGatewayName = config.cloudflare.egressGatewayWorker;
    const egressGateway = egressGatewayName
      ? Cloudflare.Worker.lookup({ name: egressGatewayName })
      : undefined;
    const egressGatewayBindings: Record<string, Cloudflare.Worker> = egressGateway
      ? { EGRESS_GATEWAY: egressGateway }
      : {};

    // ── secrets ──
    const secrets = yield* Cloudflare.Worker("Secrets", {
      ...sharedWorkerProps,
      name: names.secrets,
      main: core("secrets-worker/src/worker.ts"),
      compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat", STRICTLY_PUBLIC] },
      env: {
        ITERATE: JSON.stringify(sharedConfigOf(config)),
        ITERATE__AT_REST_KEY: atRestKey,
        // The SFU app and TURN key above, for this Worker alone, which serves them as two secrets
        // that the stack made: each one's id and secret, or why it was not made. One secret
        // variable, as JSON (core/secrets-worker/src/config.ts `cloudflareRealtime`).
        ITERATE__CLOUDFLARE_REALTIME: Output.all(
          realtimeSfu.appId,
          realtimeSfu.secret,
          turnKey.keyId,
          turnKey.key,
        ).pipe(
          Output.map(([appId, appSecret, keyId, key]) =>
            Redacted.make(JSON.stringify(realtimeConfigOf({ appId, appSecret, keyId, key }))),
          ),
        ),
        AUTH: Cloudflare.WorkerEntrypoint(auth, { entrypoint: "Auth" }),
        SECRET: Cloudflare.DurableObject("SECRET", { className: "SecretDurableObject" }),
        APPROVALS: Cloudflare.DurableObject("APPROVALS", { className: "ApprovalsIndex" }),
        ACTS: Cloudflare.DurableObject("ACTS", { className: "ActsGate" }),
        LOADER: Cloudflare.Workers.WorkerLoader("LOADER"),
        ...egressGatewayBindings,
      },
    });

    // ── the stack's one queue of Cloudflare events: the subscriptions below feed it ──
    const cloudflareEvents = yield* Cloudflare.Queues.Queue("CloudflareEvents", {
      name: names.cloudflareEvents,
    });

    // ── the boundary: one build, and one binding to the mind by the topology ──
    const declaredBoundary = Cloudflare.Worker("Boundary", {
      ...sharedWorkerProps,
      name: names.boundary,
      main: core("boundary-worker/src/worker.ts"),
      compatibility: { date: COMPATIBILITY_DATE, flags: [STRICTLY_PUBLIC] },
      // One session of the API is one long invocation here, as it is one in the mind Worker: every
      // call of the session passes through it. The mind's own limits.
      limits: { subrequests: 1_000_000, cpuMs: 300_000 },
      env: {
        ITERATE: JSON.stringify(sharedConfigOf(config)),
        // This deploy's whole config, which no Worker reads: `iterate deploy` over the mind
        // starts from it (core/lib/src/cli/deploy.ts `mindConfigIn`), so a field that no Worker
        // holds, such as the sandboxes' image, stays at the next deploy.
        DEPLOY_CONFIG: JSON.stringify(config),
        AUTH: Cloudflare.WorkerEntrypoint(auth, { entrypoint: "Auth" }),
        SECRETS: Cloudflare.WorkerEntrypoint(secrets, { entrypoint: "Secrets" }),
        SECRET_USE: Cloudflare.WorkerEntrypoint(secrets, { entrypoint: "SecretUse" }),
        SEND_EMAIL: yield* Cloudflare.Email.SendEmail("SEND_EMAIL"),
        // absent without `mail`: such a mind's boundary has no binding more
        ...(config.mail && { MAIL_FORWARD_TO: config.mail.forwardTo }),
        TELEMETRY: Cloudflare.WorkerEntrypoint(telemetry, { entrypoint: "Telemetry" }),
        ...egressGatewayBindings,
        // the boundary alone: the gateway's entrypoint for the computers that provide its way out
        ...(egressGateway && {
          EGRESS_GATEWAY_PROVIDERS: Cloudflare.WorkerEntrypoint(egressGateway, {
            entrypoint: "EgressGatewayProviders",
          }),
        }),
        ...(mindIsInTheStack
          ? {
              // The mind and the boundary bind each other. Each binding is the other Worker's
              // declaration, and Alchemy makes both Workers before it gives each its binding. A
              // reference (`Cloudflare.Worker.ref`) in place of the declaration makes the plan
              // of a first deploy wait forever (Alchemy 2.0.0-beta.85).
              MIND: Effect.map(
                // the type is written out: each declaration's type would else depend on the other's
                Effect.suspend(
                  (): Effect.Effect<Cloudflare.Worker, unknown, unknown> => mindInTheStack,
                ),
                (mind) => Cloudflare.WorkerEntrypoint(mind, { entrypoint: "Mind" }),
              ),
            }
          : {
              // the boundary's own object, which holds the mind that connects in from elsewhere
              PROVIDED_MIND: Cloudflare.DurableObject("PROVIDED_MIND", {
                className: "ProvidedMind",
              }),
            }),
      },
    });

    // ── the mind Worker, and what only it needs: with "full-cloudflare" alone ──
    const mindInTheStack = Effect.gen(function* () {
      const repos = yield* ArtifactsNamespace("Repos", { namespace: names.repos });
      // A push to the mind's config repo publishes the mind, and a write token of that repo is a
      // right to publish it: each becomes an event on the mind's `/repos/config`.
      yield* ArtifactsRepoSubscription("ConfigRepoEvents", {
        name: `${names.cloudflareEvents}-config-repo`,
        namespace: repos.namespace,
        // the Artifacts name of the mind's `/repos/config`
        repo: "repos--config",
        events: ["pushed", "token.created"],
        queueId: cloudflareEvents.queueId,
      });
      return yield* Cloudflare.Worker("Mind", {
        ...sharedWorkerProps,
        name: names.mind,
        main: core("mind-worker/src/worker.ts"),
        // allow_irrevocable_stub_storage: loaded code stores its ITX stub and replays it
        compatibility: {
          date: COMPATIBILITY_DATE,
          flags: ["nodejs_compat", "allow_irrevocable_stub_storage", ML_DSA],
        },
        // one capnweb session or MCP run is one long invocation
        limits: { subrequests: 1_000_000, cpuMs: 300_000 },
        env: {
          ITERATE: JSON.stringify(sharedConfigOf(config)),
          ITERATE__SIGNING_KEY: yield* Alchemy.makeRandom("MindSigningKey", KEY),
          DOOR: Effect.map(declaredBoundary, (boundary) =>
            Cloudflare.WorkerEntrypoint(boundary, { entrypoint: "Door" }),
          ),
          CONTEXTS: Cloudflare.DurableObject("MIND_CONTEXT", {
            className: "IterateContextDurableObject",
          }),
          CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
          LOADER: Cloudflare.Workers.WorkerLoader("LOADER"),
          MIND_KV: yield* Cloudflare.KV.Namespace("MindKv", { title: names.mindKv }),
          // the name is the resource's output, so the mind is uploaded after its namespace is made
          ARTIFACTS: {
            kind: "Cloudflare.Artifacts.Namespace",
            name: "ARTIFACTS",
            namespace: repos.namespace,
          },
          // a destroy erases the mind's files: it empties the bucket, then deletes it
          FILES: yield* Cloudflare.R2.Bucket("FILES", { name: names.files, forceDestroy: true }),
          AI: Cloudflare.Workers.AI(),
          BROWSER: Cloudflare.Workers.Browser(),
          IMAGES: Cloudflare.Images.Images(),
          TELEMETRY_METRICS: telemetryMetrics,
          // The sandboxes. One Durable Object class owns one container application. With no
          // image it starts Cloudflare's own small one; the config's image is a second image
          // that this class may start.
          SANDBOX_CONTAINER: Cloudflare.DurableObject("SandboxContainer", {
            containers: [
              Cloudflare.Container("SandboxContainer", { schedulingPolicy: "durable_object" }),
              ...(config.cloudflare.containerImage
                ? [
                    Cloudflare.Container("iterate-dev-image", {
                      schedulingPolicy: "durable_object",
                      image: config.cloudflare.containerImage,
                    }),
                  ]
                : []),
            ],
          }),
        },
      });
    });
    if (mindIsInTheStack) yield* mindInTheStack;
    const boundary = yield* declaredBoundary;
    // The boundary is the queue's one consumer. An event that the mind does not take is tried
    // again a minute later, ten times, then dropped.
    yield* Cloudflare.Queues.Consumer("CloudflareEventsConsumer", {
      queueId: cloudflareEvents.queueId,
      scriptName: boundary.workerName,
      settings: { maxRetries: 10, retryDelay: 60 },
    });

    // ── each zone: its hostnames reach the boundary, and its mail goes in and out ──
    for (const zoneName of zones) {
      const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name: zoneName }).pipe(
        Effect.orDie,
      );
      if (!zone) return yield* refuseDeploy(`the account ${accountId} has no zone ${zoneName}`);
      // A route fires only on a proxied hostname; with a Worker as the only origin, `AAAA 100::`
      // is the placeholder.
      for (const [id, hostname] of [
        ["Apex", zoneName],
        ["Wildcard", `*.${zoneName}`],
      ] as const) {
        yield* Cloudflare.DNS.Record(`${id}Record-${zoneName}`, {
          zoneId: zone.id,
          name: hostname,
          type: "AAAA",
          content: "100::",
          proxied: true,
        });
        yield* Cloudflare.Workers.WorkerRoute(`${id}Route-${zoneName}`, {
          zoneId: zone.id,
          pattern: `${hostname}/*`,
          script: boundary.workerName,
        });
      }
      const routing = yield* Cloudflare.Email.Routing(`EmailRouting-${zoneName}`, {
        zone: zone.id,
      });
      yield* Cloudflare.Email.CatchAll(`EmailCatchAll-${zoneName}`, {
        zone: routing.zoneId,
        actions: [{ type: "worker", value: [boundary.workerName] }],
      });
      const sending = yield* Cloudflare.Email.SendingSubdomain(`EmailSending-${zoneName}`, {
        zoneId: zone.id,
        name: zoneName,
      });
      // What became of a sent mail that did not arrive. Cloudflare refuses the subscription
      // until the zone is a sending domain, so its source waits for Email Sending, and a zone
      // whose DNS checks did not pass in time stops the deploy here, by its name.
      yield* Cloudflare.Queues.Subscription(`MailEvents-${zoneName}`, {
        source: {
          type: "email.sending",
          zoneId: sending.zoneId,
          domain: sending.enabled.pipe(
            Output.mapEffect((enabled) =>
              enabled
                ? Effect.succeed(zoneName)
                : Effect.die(
                    `Email Sending is not enabled on ${zoneName} yet: Cloudflare has not validated the zone's DKIM, SPF and return-path records. Deploy again when the zone's Email Sending page shows them as valid.`,
                  ),
            ),
          ),
        },
        events: ["message.bounced", "message.failed", "message.rejected", "message.complained"],
        queueId: cloudflareEvents.queueId,
      });
    }
    return { controlPlaneHostname: config.controlPlaneHostname };
  });

/** Ends a deploy or a destroy before it changes anything, with one line that Alchemy prints as
 *  it is. */
export const refuseDeploy = (message: string) =>
  Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message })));
