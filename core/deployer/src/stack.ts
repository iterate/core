// stack.ts — ONE ITERATE DEPLOYMENT AS AN ALCHEMY STACK: the platform Worker and the resources it
// binds. A pure function of `StackInput`: the host picks the state store, the credentials and the
// ConfigProvider, core/os/alchemy.run.ts for Alchemy's CLI, core/os/src/deployment/run.ts for a
// deployment's facet. core/os/cloudflare.config.ts is cf dev's twin of the binding table below;
// core/os/src/deployment/stack.test.ts keeps the two in step.
import * as Cloudflare from "alchemy/Cloudflare";
import { remote } from "alchemy/ProviderMode";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { type CloudflareSection, resourceNamesOf } from "./names.ts";

/** What a host hands the stack. */
export type StackInput = {
  /** The iterate config, parsed and split as the Worker reads it (core/os/src/iterate-config.ts
   *  `deploymentOf`): its `cloudflare` section, and the Worker's variables, `ITERATE` the plain
   *  config and each set secret field as a variable of its own. The stack reads which secret
   *  fields are set, never their values: each binds as `Config.Redacted` of its variable, which
   *  Alchemy resolves from the host's ConfigProvider. */
  deployment: {
    config: { cloudflare?: CloudflareSection };
    vars: { ITERATE: string; secrets: Record<string, string> };
  };
  /** `dir`, absolute: the release directory (core/os/scripts/build.ts `releaseOf`),
   *  `bundle/index.js` the Worker's entry (its sibling modules upload with it, byte for byte),
   *  `assets/`, and the D1 `migrations/`, the same path on every run (./engine.ts `stageRelease`).
   *  `version` labels the Worker version. */
  release: { dir: string; version: string | undefined };
  /** image name ⇒ digest-pinned reference in the account's registry (core/os/scripts/images.ts).
   *  None ⇒ a sandbox starts Cloudflare's managed image. */
  images: Record<string, string>;
};

/** The stack's body. Its stage must be the Worker's name: one state per deployment. It runs inside
 *  `remote()`, so `alchemy dev` keeps every resource live (a resource switched to local emulation
 *  is a replacement: alchemy's ProviderMode.ts), and every host plans the same binding data. */
export const iterateStack = ({ deployment: { config, vars }, release, images }: StackInput) =>
  Effect.gen(function* () {
    const cloudflare = config.cloudflare;
    if (!cloudflare) return yield* refuse("the iterate config has no `cloudflare` section");
    const names = resourceNamesOf(cloudflare);
    const stage = yield* Stage;
    if (stage !== names.worker)
      return yield* refuse(
        `the stage is ${stage}, but it must be the Worker's name: --stage ${names.worker}`,
      );
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    if (accountId !== cloudflare.accountId)
      return yield* refuse(
        `cloudflare.accountId is ${cloudflare.accountId}, but the credentials reach ${accountId}`,
      );
    // protectData's retention, piped onto each resource (core/os/src/iterate-config.ts says which
    // and why).
    const protect = RemovalPolicy.retain(cloudflare.protectData === true);
    // The warehouse (docs/telemetry.md), which internal-packages/telemetry deploys: no resource
    // here owns it.
    const telemetry = cloudflare.telemetry;
    const warehouse = telemetry && { logs: ["telemetry-logs"], traces: ["telemetry-traces"] };

    // The control plane, migrated before the Worker that binds it uploads. Its history is
    // __alchemy_migrations; wrangler's d1_migrations converts once (alchemy's D1/Database.ts).
    const db = yield* Cloudflare.D1.Database("DB", {
      name: names.db,
      migrations: `${release.dir}/migrations`,
      primaryLocationHint: cloudflare.d1Location,
    }).pipe(protect);
    const oauthKv = yield* Cloudflare.KV.Namespace("OAUTH_KV", { title: names.oauthKv }).pipe(
      protect,
    );
    const itxKv = yield* Cloudflare.KV.Namespace("ITX_KV", { title: names.itxKv }).pipe(protect);
    // A destroy empties the bucket first, where R2 refuses to delete one that holds objects.
    const files = yield* Cloudflare.R2.Bucket("FILES", {
      name: names.files,
      forceDestroy: true,
    }).pipe(protect);
    // A binding only: Alchemy makes no namespace, and a repo create fails until it exists. iterate's
    // deploy tooling makes it; a self-host makes it once (SELF-HOSTING.md).
    const repos = yield* Cloudflare.Artifacts.Namespace("ARTIFACTS", { namespace: names.repos });

    const worker = yield* Cloudflare.Worker("Worker", {
      name: names.worker,
      main: `${release.dir}/bundle/index.js`,
      bundle: false,
      assets: { directory: `${release.dir}/assets`, runWorkerFirst: true },
      // With `bundle: false` Alchemy uploads these flags as written, adding none.
      // ../cloudflare.config.ts says why each is there.
      compatibility: {
        date: COMPATIBILITY_DATE,
        flags: ["nodejs_compat", "allow_irrevocable_stub_storage", "global_fetch_strictly_public"],
      },
      // subrequests: one capnweb session is one long invocation, and each of its edge→DO calls
      // counts against it. cpuMs: a cold re-reduce of a long log is CPU-bound. Neither bills unused.
      limits: { subrequests: 1_000_000, cpuMs: 300_000 },
      // Every log line and trace, kept. With a warehouse, both go to it too, and the traces stay
      // there alone: its `spans` table holds each one, and Cloudflare bills stored traces by the GB
      // from 2026-12-01.
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: {
          enabled: true,
          headSamplingRate: 1,
          persist: true,
          invocationLogs: true,
          destinations: warehouse?.logs,
        },
        traces: {
          enabled: true,
          headSamplingRate: 1,
          persist: !warehouse,
          destinations: warehouse?.traces,
        },
      },
      // No per-version preview URLs: each version would answer on its own origin, against the
      // deployment's data.
      workersDev: { enabled: cloudflare.workersDev, previewsEnabled: false },
      routes: cloudflare.workerRoutes,
      ...(release.version && { version: { message: `iterate core/os ${release.version}` } }),
      env: {
        ITERATE_CONTEXT: Cloudflare.DurableObject("ITERATE_CONTEXT", {
          className: "IterateContextDurableObject",
        }),
        BROWSER_SESSION: Cloudflare.DurableObject("BROWSER_SESSION", {
          className: "BrowserSession",
        }),
        // The sandboxes' containers: an application named after the Worker, with no image of its
        // own and the pinned images in the Worker version (the patch's `images`). The Worker never
        // reads the binding: the sandbox facet mints from `ctx.exports.SandboxContainer`.
        SANDBOX_CONTAINER: Cloudflare.Container("SandboxContainer", {
          className: "SandboxContainer",
          name: `${names.worker}-sandbox`,
          schedulingPolicy: "durable_object",
          images: Object.fromEntries(
            Object.entries(images).map(([name, reference]) => [name, { reference }]),
          ),
        }),
        DB: db,
        OAUTH_KV: oauthKv,
        ITX_KV: itxKv,
        FILES: files,
        ARTIFACTS: repos,
        AI: Cloudflare.Workers.AI(),
        BROWSER: Cloudflare.Workers.Browser(),
        IMAGES: Cloudflare.Images.Images(),
        EMAIL: Cloudflare.Email.SendEmail("EMAIL"),
        // The device login's rate limits (src/device-login/), as ../cloudflare.config.ts declares
        // them.
        DEVICE_LOGIN_START_LIMIT: Cloudflare.Workers.RateLimit("DEVICE_LOGIN_START_LIMIT", {
          namespaceId: "8628001",
          simple: { limit: 10, period: 60 },
        }),
        DEVICE_LOGIN_POLL_LIMIT: Cloudflare.Workers.RateLimit("DEVICE_LOGIN_POLL_LIMIT", {
          namespaceId: "8628002",
          simple: { limit: 3, period: 10 },
        }),
        DEVICE_LOGIN_LOOKUP_LIMIT: Cloudflare.Workers.RateLimit("DEVICE_LOGIN_LOOKUP_LIMIT", {
          namespaceId: "8628003",
          simple: { limit: 20, period: 60 },
        }),
        LOADER: Cloudflare.Workers.WorkerLoader("LOADER"),
        CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
        WORKER_NAME: names.worker,
        TELEMETRY_METRICS: Cloudflare.AnalyticsEngine.Dataset("TELEMETRY_METRICS", {
          dataset: "iterate_metrics",
        }),
        // The config's plain part, and each set secret field as a Worker secret (`secret_text`),
        // its value the host's variable of the same name.
        ITERATE: vars.ITERATE,
        ...Object.fromEntries(
          Object.keys(vars.secrets).map((name) => [name, Config.Redacted(name)]),
        ),
      },
    }).pipe(protect);
    // The warehouse's events stream and its Worker's TelemetryQuery entrypoint, as Cloudflare's own
    // binding descriptors: Alchemy's bindings name a stream or a Worker of its own, and these are
    // neither.
    if (telemetry)
      yield* worker.bind("telemetry", {
        bindings: [
          { type: "pipelines", name: "TELEMETRY_EVENTS", pipeline: telemetry.eventsStream },
          {
            type: "service",
            name: "TELEMETRY",
            service: telemetry.workerName,
            entrypoint: "TelemetryQuery",
          },
        ],
      });
    return { url: worker.url };
  }).pipe(remote());

/** A refusal is a ConfigError, the body's error channel (alchemy's Stack.ts), whose message the CLI
 *  prints. Alchemy refuses its own configuration the same way. */
const refuse = (message: string) =>
  Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message })));
