import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import { authConfigOf, firstOwnerTicketOf } from "core-auth-worker/config";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { cloudflareTokenPoliciesOf, MIND_CLOUDFLARE_TOKEN } from "./cloudflare-token.ts";
import {
  authSettingsOf,
  deployRefusalOf,
  type MindConfig,
  resourceNamesOf,
  storedConfigOf,
} from "./config.ts";

/** A path in `core/`, from this file: a deploy from any working directory finds it. */
import { publishedSandboxImageIn } from "./sandbox-image.ts";
import { storedPathOf } from "./stored-path.ts";

const core = (path: string) => resolve(import.meta.dirname, "../..", path);
/** Without it a Worker's fetch to a hostname of its own zone skips every Worker's route there: a
 *  stack that shares its zone with another Worker (the iterate Cloud, an issuer) must reach it. */
const STRICTLY_PUBLIC = "global_fetch_strictly_public";

/** The tag that says which commit of iterate a stack runs, on its boundary Worker. Its reader is the
 *  iterate Cloud (internal-packages/installer: container/run.sh `not_unknown_stack`,
 *  worker/deployments.js `taggedCommits`): it does not put its own iterate over one that it does
 *  not have, unless the owner asks for exactly that. The 40 hex of the commit alone, never a
 *  branch's name. A deploy from another commit changes the tag, so it updates this Worker. */
const COMMIT_TAG = "iterate-commit:";
/** The commit this deploy is made from: `ITERATE_COMMIT` (a deploy from a packed tree, which has no
 *  git), else the checkout's HEAD. Unknown: the Worker gets no tag, and the deploy goes on. */
const commitOfDeploy = () => {
  const given = process.env.ITERATE_COMMIT?.trim();
  if (given) return /^[0-9a-f]{40}$/.test(given) ? given : undefined;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
};

export const mindStack = (config: MindConfig) =>
  Effect.gen(function* () {
    const names = resourceNamesOf(config.name);
    const domain = config.domain;
    const provided = config.mind?.provided === true;
    const stage = yield* Stage;
    if (stage !== config.name)
      return yield* refuse(
        `the stage is ${stage}, but it must be the mind's name: --stage ${config.name}`,
      );

    // The config decides, never the variable's presence: a deploy from a shell without it would put a
    // generated key in the vault, and no stored value would open.
    const givenAtRestKey = Option.getOrUndefined(
      yield* Config.option(Config.Redacted("ITERATE_SECRETS_AT_REST_KEY")),
    );
    // An empty value counts as none: a shell that expands a missing variable sets one.
    if (config.atRestKey === "environment" && !(givenAtRestKey && Redacted.value(givenAtRestKey)))
      return yield* refuse(
        'atRestKey is "environment", but ITERATE_SECRETS_AT_REST_KEY is not set: the vault keeps its key',
      );
    if (config.atRestKey !== "environment" && givenAtRestKey)
      return yield* refuse(
        'ITERATE_SECRETS_AT_REST_KEY is set, but the config does not say atRestKey: "environment"',
      );
    const atRestKey =
      givenAtRestKey || (yield* Alchemy.Random("SecretsAtRestKey", { bytes: 32 })).text;
    const signingKey = yield* Alchemy.Random("AuthSigningKey", { bytes: 32 });

    const prototypeToken = Option.getOrUndefined(
      yield* Config.option(Config.Redacted("ITERATE_PROTOTYPE_TOKEN")),
    );

    // SIGN IN WITH CLOUDFLARE (core/auth-worker/src/cloudflare-sign-in.ts): the client's secret is
    // the deploy's alone (./config.ts `deployRefusalOf`, `storedConfigOf`).
    const deployRefusal = deployRefusalOf(config);
    if (deployRefusal) return yield* refuse(deployRefusal);
    const cloudflareSecret = config.auth.login.methods.cloudflare?.clientSecret;

    // An empty value counts as none, as above. Never in the config: the stored config would keep it.
    const givenFirstOwnerTicket = Option.getOrUndefined(
      yield* Config.option(Config.String("ITERATE_FIRST_OWNER_TICKET")),
    );
    const firstOwnerTicket =
      givenFirstOwnerTicket && firstOwnerTicketOf(givenFirstOwnerTicket, config.auth);
    if (firstOwnerTicket && "refused" in firstOwnerTicket)
      return yield* refuse(`ITERATE_FIRST_OWNER_TICKET: ${firstOwnerTicket.refused}`);

    // The telemetry part first: every other Worker exports its logs and traces to its destinations.
    const telemetry = config.telemetry && (yield* telemetryPart(names));
    const observability = observabilityOf(telemetry?.destinations);
    const cloudflareToken = config.cloudflareToken && (yield* cloudflareTokenPart(names));

    const authSettings = authSettingsOf(config);
    // Parsed here, so a config auth would refuse fails the deploy, not the first request.
    authConfigOf(domain, authSettings);
    const db = yield* Cloudflare.D1.Database("AuthDb", {
      name: names.authDb,
      migrations: storedPathOf(core("auth-worker/migrations")),
    });
    const kv = yield* Cloudflare.KV.Namespace("AuthKv", { title: names.authKv });
    const authSendEmail = yield* Cloudflare.Email.SendEmail("AUTH_SEND_EMAIL");
    const auth = yield* Cloudflare.Worker("Auth", {
      name: names.auth,
      main: core("auth-worker/src/worker.ts"),
      // A client metadata document is fetched from the public internet alone, which the OAuth library
      // requires before it offers such clients at all.
      compatibility: { date: COMPATIBILITY_DATE, flags: [STRICTLY_PUBLIC] },
      observability,
      workersDev: { enabled: false, previewsEnabled: false },
      env: {
        DOMAIN: domain,
        ...(config.cloud && { CLOUD_ORIGIN: config.cloud.origin }),
        AUTH_SETTINGS: JSON.stringify(authSettings),
        AUTH_SIGNING_KEY: signingKey.text,
        DB: db,
        OAUTH_KV: kv,
        SEND_EMAIL: authSendEmail,
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an absent token is no binding: Alchemy's env takes a value for every key it is given, and `undefined` is none it can bind
        ...(prototypeToken && { ITERATE_PROTOTYPE_TOKEN: prototypeToken }),
        ...(firstOwnerTicket && { FIRST_OWNER_TICKET: JSON.stringify(firstOwnerTicket) }),
        ...(cloudflareSecret && {
          CLOUDFLARE_SIGN_IN_CLIENT_SECRET: Redacted.make(cloudflareSecret),
        }),
      },
    });

    const secrets = yield* Cloudflare.Worker("Secrets", {
      name: names.secrets,
      main: core("secrets-worker/src/worker.ts"),
      // nodejs_compat: `node:crypto` and `Buffer`; Alchemy adds it by default only before 2026-08-04.
      compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat", STRICTLY_PUBLIC] },
      observability,
      codeUpdateStrategy: { mode: "immediate" },
      workersDev: { enabled: false, previewsEnabled: false },
      env: {
        DOMAIN: domain,
        ...(config.cloud && { CLOUD_ORIGIN: config.cloud.origin }),
        SECRETS_AT_REST_KEY: atRestKey,
        AUTH: Cloudflare.WorkerEntrypoint(auth, { entrypoint: "Auth" }),
        SECRET: Cloudflare.DurableObject("SECRET", { className: "SecretDurableObject" }),
        LOADER: Cloudflare.Workers.WorkerLoader("LOADER"),
        APPROVALS: Cloudflare.DurableObject("APPROVALS", { className: "ApprovalsIndex" }),
        ACTS: Cloudflare.DurableObject("ACTS", { className: "ActsGate" }),
      },
    });

    const mindSigningKey =
      !provided && (yield* Alchemy.Random("MindSigningKey", { bytes: 32 })).text;
    // The boundary and the mind bind each other: each binding is the Effect that declares the other
    // Worker, which Alchemy resolves once both are registered, so both are declared before either is yielded.
    const declaredMind =
      mindSigningKey &&
      Effect.gen(function* () {
        const mindKv = yield* Cloudflare.KV.Namespace("MindKv", {
          title: `${names.mind}-kv`,
        });
        const artifacts = yield* Cloudflare.Artifacts.Namespace("ARTIFACTS", {
          namespace: names.repos,
        });
        // A destroy empties the bucket first: R2 refuses to delete one that holds objects.
        const bucket = yield* Cloudflare.R2.Bucket("FILES", {
          name: names.files,
          forceDestroy: true,
        });
        return yield* Cloudflare.Worker("Mind", {
          name: names.mind,
          main: core("mind-worker/src/worker.ts"),
          // allow_irrevocable_stub_storage (experimental): loaded code stores its env.ITX stub and
          // replays it; every worker in the chain needs it.
          compatibility: {
            date: COMPATIBILITY_DATE,
            flags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
          },
          // One capnweb session or MCP run is one long invocation, and a cold load is CPU-bound.
          limits: { subrequests: 1_000_000, cpuMs: 300_000 },
          observability,
          // Cloudflare defers moving Durable Objects onto new code for up to five minutes, while the
          // Worker in front of them already runs the new.
          codeUpdateStrategy: { mode: "immediate" },
          workersDev: { enabled: false, previewsEnabled: false },
          env: {
            DOMAIN: domain,
            MIND_NAME: config.mind?.name || config.name,
            MIND_TEMPLATE: config.mind?.template || "default",
            DOOR: Effect.map(
              Effect.suspend(
                (): Effect.Effect<Cloudflare.Worker, unknown, unknown> => declaredBoundary,
              ),
              (boundary) => Cloudflare.WorkerEntrypoint(boundary, { entrypoint: "Door" }),
            ),
            CONTEXTS: Cloudflare.DurableObject("MIND_CONTEXT", {
              className: "IterateContextDurableObject",
            }),
            CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
            LOADER: Cloudflare.Workers.WorkerLoader("LOADER"),
            MIND_KV: mindKv,
            ARTIFACTS: artifacts,
            FILES: bucket,
            MIND_SIGNING_KEY: mindSigningKey,
            AI: Cloudflare.Workers.AI(),
            // An imageless Container gives the class its `ctx.container`; the image is a Container of
            // its own, which `ctx.container.images` holds under its name.
            SANDBOX_CONTAINER: Cloudflare.DurableObject("SandboxContainer", {
              containers: [
                Cloudflare.Container("SandboxContainer", { schedulingPolicy: "durable_object" }),
                ...(config.mind?.sandboxImage === "managed"
                  ? []
                  : [
                      Cloudflare.Container("iterate-dev-image", {
                        schedulingPolicy: "durable_object",
                        // already in the account's registry (scripts/sandbox-image.ts): no Docker
                        ...(config.mind?.sandboxImage === "published"
                          ? { image: publishedSandboxImageIn(config.accountId) }
                          : { context: core("mind-worker/images/iterate-dev-image") }),
                      }),
                    ]),
              ],
            }),
            BROWSER: Cloudflare.Workers.Browser(),
            IMAGES: Cloudflare.Images.Images(),
            ...(telemetry && { TELEMETRY_METRICS: telemetry.metrics }),
            // the mind's vault keeps it (core/mind-worker/src/context/cloudflare-token.ts)
            ...(cloudflareToken && {
              CLOUDFLARE_TOKEN: cloudflareToken.value,
              CLOUDFLARE_TOKEN_ID: cloudflareToken.tokenId,
            }),
          },
        });
      });

    const declaredBoundary = Effect.gen(function* () {
      const boundarySendEmail = yield* Cloudflare.Email.SendEmail("SEND_EMAIL");
      const commit = commitOfDeploy();
      const shared = {
        name: names.boundary,
        ...(commit && { tags: [`${COMMIT_TAG}${commit}`] }),
        observability,
        codeUpdateStrategy: { mode: "immediate" } satisfies Cloudflare.WorkerCodeUpdateStrategy,
        workersDev: { enabled: false, previewsEnabled: false },
        routes: [
          { pattern: `${domain}/*`, zoneName: domain },
          { pattern: `*.${domain}/*`, zoneName: domain },
        ],
      };
      const bindings = {
        DOMAIN: domain,
        AUTH: Cloudflare.WorkerEntrypoint(auth, { entrypoint: "Auth" }),
        SECRETS: Cloudflare.WorkerEntrypoint(secrets, { entrypoint: "Secrets" }),
        SECRET_USE: Cloudflare.WorkerEntrypoint(secrets, { entrypoint: "SecretUse" }),
        SEND_EMAIL: boundarySendEmail,
        ...(config.mail instanceof Object && { MAIL_FORWARD_TO: config.mail.forwardTo }),
        ...(telemetry && {
          TELEMETRY: Cloudflare.WorkerEntrypoint(telemetry.worker, { entrypoint: "Telemetry" }),
        }),
      };
      // One logical id and Worker name for both modes: the stack's routes are attached to it.
      if (declaredMind)
        return yield* Cloudflare.Worker("Boundary", {
          ...shared,
          main: core("boundary-worker/src/worker.ts"),
          compatibility: { date: COMPATIBILITY_DATE, flags: [STRICTLY_PUBLIC] },
          env: {
            ...bindings,
            REPOS_NAMESPACE: names.repos,
            MIND: Effect.map(declaredMind, (mind) =>
              Cloudflare.WorkerEntrypoint(mind, { entrypoint: "Mind" }),
            ),
          },
        });
      return yield* Cloudflare.Worker("Boundary", {
        ...shared,
        main: core("boundary-worker/src/worker.provided.ts"),
        compatibility: { date: COMPATIBILITY_DATE, flags: ["nodejs_compat", STRICTLY_PUBLIC] },
        // One `/provide` session is one long invocation: every call through it counts against its limits.
        limits: { subrequests: 1_000_000, cpuMs: 300_000 },
        env: {
          ...bindings,
          CONTEXTS: Cloudflare.DurableObject("BOUNDARY_CONTEXT", {
            className: "IterateContextDurableObject",
          }),
          CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
        },
      });
    });
    if (declaredMind) yield* declaredMind;
    const boundary = yield* declaredBoundary;

    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    // A failed lookup is a defect: the body's error channel is ConfigError, and a rerun retries it.
    const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name: domain }).pipe(
      Effect.orDie,
    );
    if (!zone) return yield* refuse(`the account ${accountId} has no zone ${domain}`);
    const records = { ApexRecord: domain, WildcardRecord: `*.${domain}` };
    // A route fires only on a proxied hostname; with the Worker as the only origin, `AAAA 100::` is the
    // placeholder Alchemy's docs give.
    for (const [id, name] of Object.entries(records))
      yield* Cloudflare.DNS.Record(id, {
        zoneId: zone.id,
        name,
        type: "AAAA",
        content: "100::",
        proxied: true,
      });

    if (config.mail) {
      const routing = yield* Cloudflare.Email.Routing("EmailRouting", { zone: zone.id });
      yield* Cloudflare.Email.CatchAll("EmailCatchAll", {
        zone: routing.zoneId,
        actions: [{ type: "worker", value: [boundary.workerName] }],
      });
      // Email Sending on the apex adds the bounce and DKIM records the boundary's `send_email` needs.
      yield* Cloudflare.Email.SendingSubdomain("EmailSending", { zoneId: zone.id, name: domain });
    }
    // THE STACK'S ONE QUEUE OF CLOUDFLARE EVENTS, with the boundary as its one consumer
    // (core/boundary-worker/src/cloudflare-events.ts): each event subscription of the stack feeds
    // it, and a table there says what each message becomes on the mind. A stack has it when it
    // has mail or a mind Worker of its own.
    //
    // The config repo's subscription is made by ../scripts/artifacts-subscriptions.ts after the
    // deploy: Alchemy's subscriptions do not know Artifacts as a source.
    if (config.mail || declaredMind) {
      const cloudflareEvents = yield* Cloudflare.Queues.Queue("CloudflareEvents", {
        name: names.cloudflareEvents,
      });
      // What became of each sent mail. Each failure becomes a fact on the mind's email log
      // (core/boundary-worker/src/mail-outcomes.ts). Delivered and deferred mail is not asked for.
      if (config.mail)
        yield* Cloudflare.Queues.Subscription("MailEventsSubscription", {
          name: `${names.cloudflareEvents}-mail`,
          source: { type: "email.sending", zoneId: zone.id, domain },
          events: ["message.bounced", "message.failed", "message.rejected", "message.complained"],
          queueId: cloudflareEvents.queueId,
        });
      // Bounded: an event the mind does not take (a provided mind that is not connected) is retried
      // a minute apart, ten times, then dropped; the boundary logs each failure.
      yield* Cloudflare.Queues.Consumer("CloudflareEventsConsumer", {
        queueId: cloudflareEvents.queueId,
        scriptName: boundary.workerName,
        settings: { maxRetries: 10, retryDelay: 60 },
      });
    }
    // Alchemy keeps the output in the state store once a deploy succeeded: a deploy with no config file
    // reads the config back from it (./config.ts `storedMindConfig`). No secret: `storedConfigOf`.
    return { domain, boundary: boundary.workerName, config: storedConfigOf(config) };
  });

/** The mind's own API token of its account, bound to the mind Worker. Its value stays in the
 *  stack's state, as the telemetry tokens' do: a deploy that changes nothing about it asks
 *  Cloudflare nothing, and a destroy, or a deploy whose config no longer asks for it, deletes it. */
const cloudflareTokenPart = (names: ReturnType<typeof resourceNamesOf>) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    return yield* Cloudflare.ApiToken.AccountApiToken(MIND_CLOUDFLARE_TOKEN, {
      name: names.cloudflareToken,
      policies: cloudflareTokenPoliciesOf(accountId),
    });
  });

const telemetryPart = (names: ReturnType<typeof resourceNamesOf>) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const bucket = yield* Cloudflare.R2.Bucket("TelemetryBucket", {
      name: names.telemetryBucket,
      forceDestroy: true,
    });
    // a Basin Catalog sink refuses a token whose Data Catalog Write is the bucket's alone
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
            [`com.cloudflare.edge.r2.bucket.${accountId}_default_${names.telemetryBucket}`]: "*",
          },
        },
      ],
    });
    const analyticsToken = yield* Cloudflare.ApiToken.AccountApiToken("TelemetryAnalyticsToken", {
      name: `${names.telemetryBucket}-analytics`,
      policies: [
        {
          effect: "allow",
          permissionGroups: ["Account Analytics Read"],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });
    const catalog = yield* Cloudflare.Basin.Catalog("TelemetryCatalog", {
      bucket,
      token: catalogToken.value,
      compaction: { state: "enabled" },
      snapshotExpiration: { state: "enabled", maxSnapshotAge: "1d", minSnapshotsToKeep: 5 },
    });
    const streams = {} as Record<"events" | "logs" | "spans", Cloudflare.Basin.Stream>;
    for (const table of ["events", "logs", "spans"] as const) {
      const prefix = `${names.telemetryTables}_${table}`;
      // a stream's schema never changes: a column change is a new table
      const stream = yield* Cloudflare.Basin.Stream(`Telemetry_${table}_stream`, {
        name: `${prefix}_stream`,
        format: { type: "json" },
        http: false,
        workerBinding: { enabled: true },
        schema: JSON.parse(
          readFileSync(core(`telemetry-worker/schemas/${table}.json`), "utf8"),
        ) as Cloudflare.Basin.StreamFieldsSchema,
      });
      const sink = yield* Cloudflare.Basin.Sink(`Telemetry_${table}_sink`, {
        name: `${prefix}_sink`,
        type: "basin_catalog",
        catalog,
        table: { namespace: "telemetry", name: table },
        token: catalogToken.value,
        format: { type: "parquet", compression: "zstd", rowGroupBytes: 32 * 1024 * 1024 },
        rollingPolicy: { intervalSeconds: 60 },
      });
      yield* Cloudflare.Basin.Pipeline(`Telemetry_${table}_pipeline`, {
        name: prefix,
        sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}`,
      });
      streams[table] = stream;
    }
    const metrics = yield* Cloudflare.AnalyticsEngine.Dataset("TELEMETRY_METRICS", {
      dataset: names.telemetryDataset,
    });
    const otlpSecret = yield* Alchemy.Random("TelemetryOtlpSecret", { bytes: 32 });
    const worker = yield* Cloudflare.Worker("Telemetry", {
      name: names.telemetry,
      main: core("telemetry-worker/src/worker.ts"),
      compatibility: { date: COMPATIBILITY_DATE },
      // never exported to itself: a failure to land would make more of what failed to land
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, headSamplingRate: 1, persist: true, invocationLogs: true },
        traces: { enabled: true, headSamplingRate: 1, persist: true },
      },
      // Cloudflare refuses to change a destination's URL once it is made, and tests it on every
      // other update: the export's intake stays on this workers.dev address and never moves.
      workersDev: { enabled: true, previewsEnabled: false },
      env: {
        ACCOUNT_ID: accountId,
        TELEMETRY_BUCKET: names.telemetryBucket,
        METRICS_DATASET: names.telemetryDataset,
        OWN_WORKERS: [names.mind, names.boundary].join(","),
        MIND_WORKER: names.mind,
        TELEMETRY_OTLP_SECRET: otlpSecret.text,
        TELEMETRY_CATALOG_TOKEN: catalogToken.value,
        TELEMETRY_ANALYTICS_TOKEN: analyticsToken.value,
        LOGS: streams.logs,
        SPANS: streams.spans,
        EVENTS: streams.events,
        METRICS: metrics,
      },
    });
    const authorization = Output.map(otlpSecret.text, (secret) =>
      Redacted.make(`Bearer ${Redacted.value(secret)}`),
    );
    const destination = (dataset: "traces" | "logs") =>
      Cloudflare.Workers.ObservabilityDestination(`Telemetry_${dataset}`, {
        name: `${names.telemetry}-${dataset}`,
        url: Output.interpolate`${worker.url}/v1/${dataset}`,
        headers: { authorization },
        logpushDataset: `opentelemetry-${dataset}`,
        enabled: true,
        // a fresh workers.dev hostname is not routed everywhere yet (1042)
        skipPreflightCheck: true,
      });
    const traces = yield* destination("traces");
    const logs = yield* destination("logs");
    return { worker, metrics, destinations: { traces: [traces.slug], logs: [logs.slug] } };
  });

const observabilityOf = (destinations?: {
  traces: Output.Output<string>[];
  logs: Output.Output<string>[];
}) => ({
  enabled: true,
  headSamplingRate: 1,
  logs: {
    enabled: true,
    headSamplingRate: 1,
    persist: true,
    invocationLogs: true,
    destinations: destinations?.logs,
  },
  traces: { enabled: true, headSamplingRate: 1, persist: true, destinations: destinations?.traces },
});

const refuse = (message: string) =>
  Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message })));
