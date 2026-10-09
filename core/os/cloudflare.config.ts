// cloudflare.config.ts — THE PLATFORM WORKER ON THIS MACHINE, read by `cf` and the Cloudflare Vite
// plugin: the sign-in and consent pages, the OAuth server, `/api`, `/mcp`, and the Durable Objects
// the projects live in. Every mode binds the same local resources: `development` (`vite dev`,
// which `pnpm dev` runs) with its own iterate config, `test` (the suites in test/) with none,
// because each suite sets its own, and `production` (`vite build`). A deployment takes only the
// build from here: Alchemy uploads it with the bindings and settings core/deployer/src/stack.ts declares, and
// src/deployment/stack.test.ts holds this binding table to that one.
import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { TEST_EMAIL_DOMAIN } from "./src/test-email-domain.ts";

export default defineConfig(({ mode }) => {
  // `cf dev` keeps each Durable Object class on disk under this name (.cloudflare/state/v3/do/)
  const worker = "os";
  // The sandboxes' containers (src/sandbox/container.ts). The `durable-object` scheduling policy
  // lets the class pick image and size at each start, and is the only one that takes disk
  // snapshots.
  const sandboxContainer = defineContainer({
    name: `${worker}-sandbox`,
    schedulingPolicy: "durable-object",
  });
  return {
    containers: [sandboxContainer],
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
      // The Durable Object namespaces, SQLite-backed. The first-party facets
      // (src/first-party-facets.ts) are exported classes too, but each lives inside a context's
      // storage and is minted through `ctx.exports`: they need none.
      exports: {
        IterateContextDurableObject: exports.durableObject({ storage: "sqlite" }),
        BrowserSession: exports.durableObject({ storage: "sqlite" }),
        SandboxContainer: exports.durableObject({
          storage: "sqlite",
          container: sandboxContainer,
        }),
      },
      env: {
        // THE context DO: one per {projectId, path} — the stream, the routing table, and every
        // hibernatable socket in one addressable parent.
        ITERATE_CONTEXT: bindings.durableObject({
          worker,
          exportName: "IterateContextDurableObject",
        }),
        BROWSER_SESSION: bindings.durableObject({ worker, exportName: "BrowserSession" }),
        // THE CONTROL PLANE: the users, identities, organizations, memberships, projects,
        // invitations, custom hostnames and OAuth grants (src/control-plane/db/). Its id is fixed
        // because `cf d1 migrations apply --local` takes an id, not a name: package.json
        // `db:migrate` names the same one.
        DB: bindings.d1({ name: "os-dev-db", id: "00000000-0000-4000-8000-000000000000" }),
        // The OAuth provider's tokens and DCR clients, the sign-in challenges and the personal
        // access tokens' index; and `itx.kv`, project-prefixed.
        OAUTH_KV: bindings.kv(),
        ITX_KV: bindings.kv(),
        // `itx.r2`, and `itx.files` on top.
        FILES: bindings.r2({ name: "os-files" }),
        // Cloudflare Artifacts, the ONE namespace every project's repos live in, project-scoped as
        // `itx.cfArtifacts` (context/built-ins.ts puts every repo name under `${projectId}.`).
        // Workers AI, `itx.ai` (src/itx-ai.ts); Browser Run, `itx.browser`. None of the three has a
        // local simulator: `cf dev` reaches the real product on the account it is signed in to, so
        // local runs have a namespace of their own and never write into a deployment's.
        ARTIFACTS: bindings.artifacts({ namespace: "os-dev-repos", dev: { remote: true } }),
        AI: bindings.ai({ dev: { remote: true } }),
        BROWSER: bindings.browser({ dev: { remote: true } }),
        // Images, `itx.images` (context/images.ts). `cf dev` runs a low-fidelity offline version
        // (width, height, rotate, format); the deployed binding is the real one.
        IMAGES: bindings.images(),
        // Email Sending: the sign-in code's way out (src/password-and-code-sign-in.ts), from
        // `login.methods.emailCode.from`.
        EMAIL: bindings.sendEmail(),
        // The device login's rate limits (src/device-login/). A namespace is the account's, so
        // deployments on one account share its counters. https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
        DEVICE_LOGIN_START_LIMIT: bindings.rateLimit({
          namespace: "8628001",
          simple: { limit: 10, period: 60 },
        }),
        DEVICE_LOGIN_POLL_LIMIT: bindings.rateLimit({
          namespace: "8628002",
          simple: { limit: 3, period: 10 },
        }),
        DEVICE_LOGIN_LOOKUP_LIMIT: bindings.rateLimit({
          namespace: "8628003",
          simple: { limit: 20, period: 60 },
        }),
        // The Worker Loader that runs each project's confined config worker and agents.
        LOADER: bindings.workerLoader(),
        // Deploy identity. Loader isolates are cached ACROSS deployments, but a DO survives
        // redeploys, so a facet built from an isolate a PRIOR deployment minted cannot be called from
        // the new parent. The loader cache key carries this version's id (context/worker-loader.ts).
        CF_VERSION_METADATA: bindings.versionMetadata(),
        // The Start client and the consent page (issuer-pages.ts).
        ASSETS: bindings.assets(),
        // The Worker's own name, which its custom metrics and `events` rows say wrote them. Neither
        // has a local destination: the telemetry bindings are a deployment's alone.
        WORKER_NAME: bindings.text(worker),
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
        methods: {
          password: { password: "dev" },
          emailCode: { from: "iterate <login@localhost>" },
        },
        // a laptop's platform: anyone with the password
        allow: [{ everyone: {} }],
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
