import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { addressOf, mindToken } from "iterate/node";
import { mindProvideUrlOf } from "iterate/mind-api";
import { Log, LogLevel, Miniflare, Response } from "miniflare";
import { serveRepos } from "./repos/server.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "8789" },
    // a repo keeps its remote URL for its life
    "git-port": { type: "string", default: "8790" },
    name: { type: "string" },
    template: { type: "string", default: "default" },
    bundle: { type: "string" },
    telemetry: { type: "boolean", default: false },
  },
});
if (!positionals[0]) throw new Error("Name the mind's domain: node src/main.ts <domain>");
// the spelling `iterate login` stores its session under
const domain = addressOf(positionals[0]);
const dir = path.resolve(import.meta.dirname, "../.home-lab", domain);
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
          DOMAIN: { type: "text", value: domain },
          MIND: { type: "worker", worker: "mind", exportName: "Mind" },
          LINK: { type: "durable-object", worker: "link", exportName: "Link" },
          TOKEN: {
            type: "fetcher",
            handler: async () =>
              new Response(
                await mindToken({ address: domain, resource: mindProvideUrlOf(domain) }),
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
        // must match core/alchemy/src/stack.ts
        compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
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
The mind ${domain} runs on this machine, in local workerd.
  ${local.href}                the apex, as https://${domain}/
  http://<label>.localhost:${values.port}/   https://<label>.${domain}/
  http://iterate.localhost:${values.port}/api   the mind's API, nobody stamped as the caller
  state                          ${dir}
  ${link.connected ? `connected to https://iterate.${domain}/provide: the stack forwards to it` : `not connected to https://iterate.${domain}/provide (${link.error}); the link dials again`}
  repos                          ${dir}/repos, served at ${repos.origin}/<name>.git
                                 (git clone with any user and the password in ${dir}/repos-token)
  sandboxes                      ${"image" in sandboxes ? `on: ${sandboxes.image} on ${sandboxes.socket}` : `off: ${sandboxes.off}`}
  telemetry                      ${values.telemetry ? "metrics and events to the stack's telemetry Worker; no traces or Workers Logs" : "off (--telemetry with a stack that has the part)"}
  not at home                    Workers AI, Browser Run, Images: see README.md
`);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(
    signal,
    () =>
      void mf.dispose().then(() => {
        repos.close();
        process.exit(0);
      }),
  );

/** One per binding of core/mind-worker/src/env.ts. No Cloudflare credential is put on this machine. */
function mindBindings() {
  const standIn = (binding: string, why: string) =>
    ({ type: "worker", worker: "link", exportName: "StandIn", props: { binding, why } }) as const;
  return {
    DOMAIN: { type: "text", value: domain },
    MIND_NAME: { type: "text", value: values.name || domain.split(".")[0] },
    MIND_TEMPLATE: { type: "text", value: values.template },
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
    MIND_SIGNING_KEY: { type: "text", value: kept("mind-signing-key") },
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
    // its presence also gives the mind `itx.telemetry` (core/mind-worker src/context/telemetry.ts)
    ...(values.telemetry && {
      TELEMETRY_METRICS: { type: "worker", worker: "link", exportName: "HomeMetrics" } as const,
    }),
  } as const;
}

/** A random key made once and kept in `.home-lab/<domain>/<name>`, mode 600. */
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
  const built = spawnSync("node", ["scripts/build.ts"], { cwd: mindDir, stdio: "inherit" });
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
