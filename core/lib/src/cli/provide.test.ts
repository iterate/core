// provide.test.ts — `iterate provide <file>` as a person runs it (the package's bin): a missing
// dependency named before any sign-in, a file with no default export, and what `rpcTargetOf`
// refuses to lend.
import { tmpdir } from "node:os";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync, mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { rpcTargetOf } from "./provide.ts";

const bin = fileURLToPath(new URL("../../bin/iterate.js", import.meta.url));

test("a file whose dependency is not installed names the folder to install in, before any sign-in; a file with no default export says what to export", async () => {
  using temporary = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  // Node names the file by its real path (macOS's temp dir is a symlink into /private)
  const folder = { path: realpathSync(temporary.path) };
  writeFileSync(join(folder.path, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(folder.path, "whatsapp.ts"),
    `import "baileys-not-installed"; export default () => ({});`,
  );
  writeFileSync(join(folder.path, "nothing.mjs"), `export const x = 1;`);
  // nothing listens here: the file's refusal must come first
  using cli = cliConfig("http://127.0.0.1:1");

  const missing = cli.provide([join(folder.path, "whatsapp.ts"), "--mind", "demo"]);
  expect(await missing.exited).not.toBe(0);
  expect(missing.stderr()).toContain(
    `Cannot find package 'baileys-not-installed' imported from ${join(folder.path, "whatsapp.ts")}. Install whatsapp.ts's dependencies first: npm install (or pnpm install) in ${folder.path}.`,
  );

  const empty = cli.provide([join(folder.path, "nothing.mjs"), "--mind", "demo"]);
  expect(await empty.exited).not.toBe(0);
  expect(empty.stderr()).toContain("nothing.mjs has no default export to provide");
  // two starts of the CLI: how long a process takes to start is the machine's, not this test's
}, 60_000);

test("rpcTargetOf: nothing to lend is refused, saying why", () => {
  expect(() => rpcTargetOf(undefined)).toThrow(
    "The default export answered undefined: it must answer an object of functions.",
  );
  expect(() => rpcTargetOf({ answer: 42 })).toThrow(
    "The default export answered an object with no functions: nothing to lend.",
  );
});

/** A config naming `baseUrl` with a stored token, and `provide` run as a child process: `live`
 *  answers the line it prints once lent, `stop` sends Ctrl-C and answers the exit code. */
function cliConfig(baseUrl: string) {
  const config = mkdtempDisposableSync(join(tmpdir(), "iterate-test-"));
  mkdirSync(join(config.path, "iterate"));
  writeFileSync(
    join(config.path, "iterate/config.json"),
    JSON.stringify({
      default: "test",
      configs: { test: { osBaseUrl: baseUrl, session: { token: "test-token" } } },
    }),
  );
  const children: ChildProcess[] = [];
  return {
    provide(args: string[]) {
      const child = execFile(process.execPath, [bin, "provide", ...args], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: config.path,
          NO_COLOR: "1",
          ITERATE_ADMIN_BEARER: "",
          ITERATE_BEARER_TOKEN: "",
        },
      });
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      const live = new Promise<string>((resolve, reject) => {
        createInterface({ input: child.stdout! }).once("line", resolve);
        void exited.then((code) =>
          reject(new Error(`iterate provide exited ${code} before it was live: ${stderr}`)),
        );
      });
      live.catch(() => {}); // a file refused before it was live is read through `exited`
      return {
        live,
        exited,
        stderr: () => stderr,
        stop: () => {
          child.kill("SIGINT");
          return exited;
        },
      };
    },
    [Symbol.dispose]: () => {
      for (const child of children) child.kill("SIGKILL");
      config[Symbol.dispose]();
    },
  };
}
