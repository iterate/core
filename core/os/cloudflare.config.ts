// cloudflare.config.ts — THE PLATFORM WORKER'S CLOUDFLARE CONFIG, read by `cf` and the Cloudflare
// Vite plugin: the sign-in and consent pages, the OAuth server, `/api`, `/mcp`, and the Durable
// Objects the projects live in. Modes: `development` (`cf dev`) and `test` (the suites in test/)
// bind local resources and need no config; any other (a build, `cf deploy`) deploys where the
// iterate config's `cloudflare` section says (scripts/iterate-config-file.ts), or builds locally
// when it has none.
import { bindings, defineConfig, exports, triggers } from "cf/config";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { readDeployment } from "./scripts/iterate-config-file.ts";
import { resourceNamesOf } from "./src/iterate-config.ts";
import { TEST_EMAIL_DOMAIN } from "./src/test-email-domain.ts";

/** The resources a Worker with no deployment binds: local dev's and the suites'. `cf dev` keeps
 *  D1, KV and R2 on disk under .cloudflare/state/; Artifacts, Workers AI and Browser Run have no
 *  local simulator and reach the real products on the account `cf` is signed in to, so local runs
 *  have a namespace of their own, `os-dev-repos`, and never write into a deployment's. The local
 *  D1 has a fixed id because `cf d1 migrations apply --local` takes an id, not a name: package.json
 *  `db:migrate` names the same one. */
const LOCAL_RESOURCES = {
  worker: "os",
  db: "os-dev-db",
  dbId: "00000000-0000-4000-8000-000000000000",
  files: "os-files",
  repos: "os-dev-repos",
};

/** The first-party facets' former class names (src/first-party-facets.ts). */
const RETIRED_FACET_CLASSES = [
  "AccountDurableObject",
  "EmailDurableObject",
  "InstanceDurableObject",
  "OrganizationDurableObject",
  "ProjectDurableObject",
  "RepoDurableObject",
  "SecretDurableObject",
  "WorkspaceDurableObject",
];

export default defineConfig(async ({ mode }) => {
  const local = mode === "development" || mode === "test";
  const deployment = local ? undefined : await readDeployment();
  const cloudflare = deployment?.config.cloudflare;
  const telemetry = cloudflare?.telemetry;
  const names = cloudflare ? resourceNamesOf(cloudflare) : LOCAL_RESOURCES;
  const worker = cloudflare
    ? names.worker
    : mode === "development"
      ? LOCAL_RESOURCES.worker
      : "os-local-build";
  return {
    accountId: cloudflare?.accountId,
    worker: {
      name: worker,
      // Vite builds the Worker from this entry; scripts/build.ts first writes the generated source
      // it imports. Start renders the landing and sign-in pages; consent and the shared static files
      // are public/, Vite's public directory.
      entrypoint: "./src/worker.ts",
      compatibilityDate: COMPATIBILITY_DATE,
      // nodejs_compat: the DO's AsyncLocalStorage (node:async_hooks). Loaded userspace isolates are
      // the pure-play half: context/worker-loader.ts mints them with no_nodejs_compat, so what runs
      // inside a context stays portable across workerd builds.
      // allow_irrevocable_stub_storage (experimental, undocumented): loaded code STORES its env.ITX
      // stub in its own durable storage and replays it (test/vitest/os/workers-and-facets.e2e.test.ts
      // pins it); every worker in the chain needs it, so the loaded isolates carry it too.
      // global_fetch_strictly_public: the OAuth provider's Client ID Metadata Documents (oauth.ts
      // `clientIdMetadataDocumentEnabled`) — its fetch of a client's metadata URL must reach the
      // public internet only, never same-zone routing; without it the provider offers no CIMD.
      compatibilityFlags: [
        "nodejs_compat",
        "allow_irrevocable_stub_storage",
        "global_fetch_strictly_public",
      ],
      // Worker-first: assets stay off project hosts, and the Worker gates consent.
      assets: { runWorkerFirst: true },
      // subrequests: a capnweb WebSocket session is pumped by ONE long-lived invocation, and every
      // edge->DO `invoke` it makes counts against that invocation for the session's whole life — the
      // 10,000 default is hit by an ordinary long-lived client (3 appends/s for ~1 h). cpuMs: a cold
      // re-reduce over a long log, or a large per-commit fan-out, is CPU-bound on the DO's one
      // thread; 5 min (the paid maximum) gives 10x the 30 s default. Neither is billed until used.
      limits: { subrequests: 1_000_000, cpuMs: 300_000 },
      // Every log line and trace, kept; with a telemetry warehouse, exported to it too
      // (docs/telemetry.md), and the traces kept there alone: its `spans` table holds each one, and
      // from 2026-12-01 Cloudflare bills stored traces by the GB.
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: {
          enabled: true,
          headSamplingRate: 1,
          persist: true,
          invocationLogs: true,
          ...(telemetry && { destinations: ["telemetry-logs"] }),
        },
        traces: {
          enabled: true,
          headSamplingRate: 1,
          persist: !telemetry,
          ...(telemetry && { destinations: ["telemetry-traces"] }),
        },
      },
      // both always said: with a route and no `workersDev`, Cloudflare turns workers.dev off
      workersDev: cloudflare?.workersDev ?? true,
      // Never per-version preview URLs: unset, cf turns them on with workers.dev, and each version
      // would answer on its own origin against the deployment's data
      previewUrls: false,
      triggers: (cloudflare?.workerRoutes || []).map((route) => triggers.fetch(route)),
      // The Durable Object namespaces, SQLite-backed. The first-party facets
      // (src/first-party-facets.ts) are exported classes too, but each lives inside a context's
      // storage and is minted through `ctx.exports`: they need none.
      exports: {
        IterateContextDurableObject: exports.durableObject({ storage: "sqlite" }),
        BrowserSession: exports.durableObject({ storage: "sqlite" }),
        // TRANSITION: the facets' former class names, which had empty namespaces of their own. A
        // deploy refuses to drop a namespace that is not declared, so each is retired here. Remove
        // these lines once a deploy reports them as stale tombstones.
        ...Object.fromEntries(
          RETIRED_FACET_CLASSES.map((className) => [
            className,
            exports.durableObject({ state: "deleted" }),
          ]),
        ),
      },
      env: {
        // THE context DO: one per {projectId, path} — the stream, the routing table, and every
        // hibernatable socket in one addressable parent.
        ITERATE_CONTEXT: bindings.durableObject({
          worker,
          exportName: "IterateContextDurableObject",
        }),
        BROWSER_SESSION: bindings.durableObject({ worker, exportName: "BrowserSession" }),
        // THE CONTROL PLANE: the deployment's users, identities, organizations, memberships,
        // projects, invitations, custom hostnames and OAuth grants (src/control-plane/db/). Bound by
        // name; scripts/deploy.ts migrates it from src/control-plane/db/migrations.
        DB: bindings.d1({ name: names.db, ...(!cloudflare && { id: LOCAL_RESOURCES.dbId }) }),
        // The OAuth provider's tokens and DCR clients, the sign-in challenges and the personal
        // access tokens' index; and `itx.kv`, project-prefixed. Cloudflare makes each on the first
        // deploy.
        OAUTH_KV: bindings.kv(),
        ITX_KV: bindings.kv(),
        // `itx.r2`, and `itx.files` on top.
        FILES: bindings.r2({ name: names.files }),
        // Cloudflare Artifacts, the ONE namespace every project's repos live in, project-scoped as
        // `itx.cfArtifacts` (context/built-ins.ts puts every repo name under `${projectId}.`).
        // Workers AI, `itx.ai` (src/itx-ai.ts); Browser Run, `itx.browser`. None of the three has a
        // local simulator: `cf dev` reaches the real product on its account.
        ARTIFACTS: bindings.artifacts({ namespace: names.repos, dev: { remote: true } }),
        AI: bindings.ai({ dev: { remote: true } }),
        BROWSER: bindings.browser({ dev: { remote: true } }),
        // Email Sending: the sign-in code's way out (src/password-and-code-sign-in.ts), from
        // `login.emailCode.from`.
        EMAIL: bindings.sendEmail(),
        // The Worker Loader that runs each project's confined config worker and agents.
        LOADER: bindings.workerLoader(),
        // Deploy identity. Loader isolates are cached ACROSS deployments, but a DO survives
        // redeploys, so a facet built from an isolate a PRIOR deployment minted cannot be called from
        // the new parent. The loader cache key carries this version's id (context/worker-loader.ts).
        CF_VERSION_METADATA: bindings.versionMetadata(),
        // The Start client and the consent page (issuer-pages.ts).
        ASSETS: bindings.assets(),
        // The Worker's own name, which its custom metrics and `events` rows say wrote them.
        WORKER_NAME: bindings.text(worker),
        // TELEMETRY (docs/telemetry.md). Custom metrics (src/metrics.ts) need no warehouse: Workers
        // Analytics Engine makes the dataset on its first write, so every deployment writes them.
        // With a warehouse, the platform hook sends each durable event to its `events` stream, and
        // `itx.telemetry` runs a project's SQL through its Worker's `TelemetryQuery`.
        ...(deployment && {
          TELEMETRY_METRICS: bindings.analyticsEngineDataset({ name: "iterate_metrics" }),
        }),
        ...(telemetry && {
          TELEMETRY_EVENTS: bindings.pipeline({ name: telemetry.eventsStream }),
          TELEMETRY: bindings.worker({
            worker: telemetry.workerName,
            exportName: "TelemetryQuery",
          }),
        }),
        // THE ITERATE CONFIG: a deployment's plain var (`cf deploy` uploads its secrets), `cf dev`'s
        // own; a suite sets its own
        ...(deployment && { ITERATE: bindings.text(deployment.vars.ITERATE) }),
        ...(mode === "development" && { ITERATE: localDevConfig() }),
      },
    },
  };
});

/** `cf dev`'s iterate config: projects under `<project>.localhost`, signed in with the password
 *  `dev` or `pnpm getin`'s one click. */
function localDevConfig() {
  // scripts/dev.ts passes the port it serves on; `cf dev` serves on vite.config.ts's
  const port = process.env.OS_DEV_PORT || "8788";
  return bindings.text(
    JSON.stringify({
      urls: {
        os: `http://localhost:${port}`,
        ingressRouting: { type: "subdomains", hostname: "localhost" },
        // a laptop's platform names no dash: a local one is wired to it by its own .dev.vars
        dash: "",
      },
      login: {
        password: "dev",
        emailCode: { from: "iterate <login@localhost>" },
        // the test people's (getin's, the specs'): a sign-in link naming one pre-fills an admin's
        // "Sign in as someone else" (consent.ts), and it opens `pnpm getin`'s one-click
        // `/.auth/local-sign-in` (src/local-sign-in.ts)
        testEmailDomain: TEST_EMAIL_DOMAIN,
      },
      // `pnpm getin`'s person, so the admin app and "view as" work locally, and the admin the
      // specs sign in as
      admins: [`test@${TEST_EMAIL_DOMAIN}`, `admin@${TEST_EMAIL_DOMAIN}`],
      adminBearer: "dev-admin-api-secret",
      secretsEncryption: { key: "dev-secrets-key" },
    }),
  );
}
