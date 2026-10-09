// THE VITE BUILD OF ONE APP, and the command runner it streams through: the platform's build
// (./build.ts), and iterate's deploy tooling outside core (scripts/lib/{deploy-app,deploy-helpers,
// start-app}.ts). Imports nothing but Node's, as everything in core/ imports nothing outside it.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const CAPTURED_COMMAND_OUTPUT_LIMIT = 64 * 1024;

/**
 * `vite build` of one app for one environment, into a fresh output folder. The apps on top build
 * into dist/ (`CLOUDFLARE_ENV` selects the environment), and the Worker config the Cloudflare Vite
 * plugin snapshots beside the code is what deploys. core/os builds into .cloudflare/output/ (./build.ts
 * `releaseOf`), and Alchemy uploads that code with the bindings ../alchemy/stack.ts declares, not
 * the snapshot's. Its output streams as it runs; a failure's error carries the last 40 lines, so a
 * report of it (the PR preview's `deploy failed`) says why.
 */
export async function viteBuild(appRoot: string, env: Record<string, string>) {
  for (const output of ["dist", ".cloudflare/output"])
    rmSync(join(appRoot, output), { recursive: true, force: true });
  const result = await runStreamingCaptured("pnpm", ["exec", "vite", "build"], {
    cwd: appRoot,
    env,
  });
  if (result.code === 0) return;
  throw new Error(
    `pnpm exec vite build exited with ${result.code ?? `signal ${result.signal || "unknown"}`}\n${result.output.trimEnd().split("\n").slice(-40).join("\n")}`,
  );
}

export async function runStreamingCaptured(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  console.log(`$ ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    let output = "";
    const relay = (destination: NodeJS.WriteStream) => (chunk: Uint8Array) => {
      destination.write(chunk);
      output = `${output}${Buffer.from(chunk).toString("utf8")}`.slice(
        -CAPTURED_COMMAND_OUTPUT_LIMIT,
      );
    };
    child.stdout.on("data", relay(process.stdout));
    child.stderr.on("data", relay(process.stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
}
