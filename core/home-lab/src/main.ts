import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { addressOf, mindToken } from "iterate/node";
import { mindApiUrlOf, mindProvideConnectResourceOf } from "iterate/mind-api";
import { MindConfig } from "iterate/mind-config";
import { Log, LogLevel, Miniflare, Response } from "miniflare";
import { serveRepos } from "./repos/server.ts";
import { sweepSidecars } from "./sandbox-sidecars.ts";
import { seedReposEnv } from "./seed-repos.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "8789" },
    // a repo keeps its remote URL for its life
    "git-port": { type: "string", default: "8790" },
    "mind-id": { type: "string" },
    zone: { type: "string", multiple: true },
    owner: { type: "string", multiple: true },
    bundle: { type: "string" },
  },
});
if (!positionals[0])
  throw new Error(
    "Name the mind: node src/main.ts <control-plane hostname> --mind-id <id> --zone <zone> --owner <email>",
  );
// THE CONFIG THAT EVERY WORKER OF THE MIND GETS (iterate/mind-config), as the stack's deploy gives
// it to the boundary: the same mind id, control-plane hostname, zones and owners. The control-plane hostname is in the
// spelling `iterate login` stores its session under.
const config = MindConfig.parse({
  mindId: values["mind-id"],
  controlPlaneHostname: addressOf(positionals[0]),
  zones: values.zone,
  ownerEmails: values.owner,
  topology: "external-mind-connects-into-cloudflare-boundary",
});
const { controlPlaneHostname } = config;
const ITERATE = { type: "text", value: JSON.stringify(config) } as const;
const dir = path.resolve(import.meta.dirname, "../.home-lab", controlPlaneHostname);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const mindDir = path.resolve(import.meta.dirname, "../../mind-worker");
const repos = await serveRepos({
  dir: `${dir}/repos`,
  token: kept("repos-token"),
  port: Number(values["git-port"]),
});
const sandboxes = sandboxEngine();

const mf = new Miniflare({
  host: "127.0.0.1",
  port: Number(values.port),
  log: new Log(LogLevel.INFO),
  resourcePersistencePath: `${dir}/state`,
  workers: [
    // the first Worker answers the port
    {
      config: {
        name: "link",
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        manifest: moduleOf(await bundle(`${import.meta.dirname}/link/worker.ts`)),
        env: {
          ITERATE,
          REPOS_ORIGIN: { type: "text", value: repos.origin },
          // the mind's requests that name no secret, and the mind Worker's own fetches, leave
          // through this: public addresses alone
          INTERNET: {
            type: "network",
            allow: ["public"],
            // without it the binding has no TLS at all, and every https request fails
            tlsOptions: { trustBrowserCas: true },
          },
          MIND: { type: "worker", worker: "mind", exportName: "Mind" },
          LINK: { type: "durable-object", worker: "link", exportName: "Link" },
          TOKEN: {
            type: "fetcher",
            handler: async () =>
              new Response(
                await mindToken({
                  address: controlPlaneHostname,
                  resource: mindProvideConnectResourceOf(controlPlaneHostname),
                }),
              ),
          },
        },
        // never evicted: it holds the session's WebSocket
        exports: {
          Link: { type: "durable-object", storage: "sqlite", unsafePreventEviction: true },
        },
      },
    },
    {
      config: {
        name: "mind",
        compatibilityDate: COMPATIBILITY_DATE,
        // must match the mind Worker's flags in the stack (core/alchemy)
        compatibilityFlags: [
          "nodejs_compat",
          "allow_irrevocable_stub_storage",
          "webcrypto_modern_algorithms",
        ],
        manifest: moduleOf(
          values.bundle ? readFileSync(values.bundle, "utf8") : await mindBundle(),
        ),
        env: mindBindings(),
        exports: {
          IterateContextDurableObject: { type: "durable-object", storage: "sqlite" },
          SandboxContainer: {
            type: "durable-object",
            storage: "sqlite",
            ...("image" in sandboxes && {
              container: { images: [{ name: "iterate-dev-image", image: sandboxes.image }] },
            }),
          },
        },
      },
      // the mind Worker's own fetches (link/worker.ts `Outbound`): public addresses alone
      dev: { outboundService: { type: "worker", worker: "link", exportName: "Outbound" } },
    },
  ],
  ...("image" in sandboxes && {
    containerEngine: { localDocker: { socketPath: sandboxes.socket } },
  }),
});

const local = await mf.ready;
// a root is born at its first request: this one, so the config repo is published now
await (await mf.dispatchFetch("http://localhost/")).body?.cancel();
const link = (await (await mf.dispatchFetch("http://link.home-lab.invalid/")).json()) as {
  connected: boolean;
  error: string | null;
};
console.log(`
The mind ${controlPlaneHostname} runs on this machine, in local workerd.
  ${local.href}                the apex of its first zone, as https://${config.zones[0]}/
  http://<label>.localhost:${values.port}/   https://<label>.${config.zones[0]}/
  state                          ${dir}
  ${link.connected ? `handed in at ${mindApiUrlOf(controlPlaneHostname)}: the stack forwards to it` : `not handed in at ${mindApiUrlOf(controlPlaneHostname)} (${link.error}); the link dials again`}
  repos                          ${dir}/repos, served at ${repos.origin}/<name>.git
                                 (git clone with any user and the password in ${dir}/repos-token)
  telemetry                      metrics and events to the stack's telemetry Worker; no traces or Workers Logs
  sandboxes                      ${"image" in sandboxes ? `on: ${sandboxes.image} on ${sandboxes.socket}` : `off: ${sandboxes.off}`}
  not at home                    Workers AI, Browser Run, Images: see README.md
`);

// workerd leaves a sandbox's sidecar container running when the sandbox ends
// (sandbox-sidecars.ts): those left by an earlier run go now, and those of this run every five
// minutes and at the end.
const sidecarsSwept = "image" in sandboxes && sweepSidecars();
if (sidecarsSwept)
  console.log(`Sandbox sidecar containers left by an earlier run, removed: ${sidecarsSwept}.`);
if ("image" in sandboxes) setInterval(sweepSidecars, 5 * 60_000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(
    signal,
    () =>
      void mf.dispose().then(() => {
        repos.close();
        if ("image" in sandboxes) sweepSidecars();
        process.exit(0);
      }),
  );

/** One per binding of core/mind-worker/src/env.ts. No Cloudflare credential is put on this machine. */
function mindBindings() {
  const standIn = (binding: string, why: string) =>
    ({ type: "worker", worker: "link", exportName: "StandIn", props: { binding, why } }) as const;
  return {
    ITERATE,
    ITERATE__SIGNING_KEY: { type: "text", value: kept("mind-signing-key") },
    DOOR: { type: "worker", worker: "link", exportName: "Door" },
    CONTEXTS: {
      type: "durable-object",
      worker: "mind",
      exportName: "IterateContextDurableObject",
    },
    CF_VERSION_METADATA: { type: "version-metadata" },
    LOADER: { type: "worker-loader" },
    MIND_KV: { type: "kv" },
    FILES: { type: "r2" },
    AI: standIn(
      "AI",
      "Workers AI has no local simulator. Give the agents a model key as a secret instead; it leaves through the door.",
    ),
    ARTIFACTS: {
      type: "worker",
      worker: "link",
      exportName: "HomeArtifacts",
      props: { origin: repos.origin, token: kept("repos-token") },
    },
    SANDBOX_CONTAINER: {
      type: "durable-object",
      worker: "mind",
      exportName: "SandboxContainer",
    },
    BROWSER: standIn("BROWSER", "Browser Run has no local simulator."),
    IMAGES: standIn("IMAGES", "Cloudflare Images is not simulated at home."),
    // the mind's metrics go to the stack's telemetry Worker, through the link
    TELEMETRY_METRICS: { type: "worker", worker: "link", exportName: "HomeMetrics" },
  } as const;
}

/** A random key made once and kept in `.home-lab/<control-plane hostname>/<name>`, mode 600. */
function kept(name: string) {
  const file = `${dir}/${name}`;
  if (!existsSync(file))
    writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
  return readFileSync(file, "utf8");
}

function sandboxEngine(): { socket: string; image: string } | { off: string } {
  const docker = (args: string[], stdio: "pipe" | "inherit" = "pipe") =>
    spawnSync("docker", args, { encoding: "utf8", stdio });
  const info = docker(["info", "--format", "{{.ServerVersion}}"]);
  if (info.error || info.status !== 0)
    return {
      off: `Docker does not answer (${(info.error?.message || info.stderr).trim().split("\n")[0]}); start it and restart the home lab`,
    };
  const host = docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  const socket = host.status === 0 ? host.stdout.trim() : "unix:///var/run/docker.sock";
  const folder = `${mindDir}/images/iterate-dev-image`;
  const hash = createHash("sha256");
  for (const file of readdirSync(folder).sort())
    hash
      .update(`${file}\0`)
      .update(readFileSync(`${folder}/${file}`))
      .update("\0");
  const image = `iterate-dev-image:${hash.digest("hex").slice(0, 12)}`;
  if (docker(["image", "inspect", image]).status !== 0) {
    console.log(
      `Building the sandbox image ${image} with the local Docker, once per change of it.`,
    );
    const built = docker(["build", "--quiet", "--tag", image, folder], "inherit");
    if (built.status !== 0) return { off: `the build of ${image} failed (above)` };
  }
  return { socket, image };
}

async function mindBundle() {
  const coreDir = path.resolve(import.meta.dirname, "../..");
  const built = spawnSync("node", ["scripts/build.ts"], {
    cwd: mindDir,
    stdio: "inherit",
    env: { ...process.env, ...seedReposEnv(coreDir) },
  });
  if (built.status !== 0) throw new Error("core/mind-worker's build failed");
  return bundle(`${mindDir}/src/worker.ts`);
}

async function bundle(entryPoint: string) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    write: false,
    logLevel: "warning",
  });
  return result.outputFiles[0]!.text;
}

function moduleOf(source: string) {
  return {
    mainModule: "worker.js",
    modules: { "worker.js": { type: "esm", contents: source } },
  } as const;
}
