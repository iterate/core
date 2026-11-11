// provide.test.ts — `iterate provide <file>` as a person runs it (the package's bin): a missing
// dependency named before any sign-in, a file with no default export, and what `rpcTargetOf`
// refuses to lend. And the loop itself (`runProvide`) over stand-in connections: the handover before a
// sign-in ends.
import { tmpdir } from "node:os";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync, mkdtempDisposableSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { rpcTargetOf, runProvide } from "./provide.ts";

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

test("before a sign-in ends the name is lent over the next connection, and only then is the old one let go", async () => {
  using quiet = quietConsole();
  const happened: string[] = [];
  const first = connectionOf("first", happened);
  const second = connectionOf("second", happened);
  const ends = [Date.now() + 60, undefined];
  const run = runProvide({
    connection: first.connection,
    reconnect: async () => second.connection,
    file: { provide: () => ({ hello: () => "hello" }) },
    name: "standIn",
    endsAt: () => ends.shift(),
    renewBeforeMs: 30,
    reconnectDelaysMs: [],
  });
  await second.lent;
  // the old connection is let go after the new one lends, and its end is no disconnection
  await first.disposed;
  expect(happened).toEqual(["first lends", "second lends", "first let go"]);
  expect(quiet.lines.join("\n")).not.toMatch(/disconnected|Reconnect/);
  // the end of the run: the second connection closes, and no reconnect is allowed here
  second.close();
  await expect(run).rejects.toThrow("itx.standIn disconnected and could not reconnect");
});

test("when the next connection cannot be made, the present one is kept until it closes", async () => {
  using quiet = quietConsole();
  const happened: string[] = [];
  const first = connectionOf("first", happened);
  let asked = 0;
  const run = runProvide({
    connection: first.connection,
    reconnect: async () => {
      asked += 1;
      throw new Error("the mind is not there");
    },
    file: { provide: () => ({ hello: () => "hello" }) },
    name: "standIn",
    endsAt: () => Date.now() + 40,
    renewBeforeMs: 30,
    reconnectDelaysMs: [],
  });
  await vi.waitFor(() => expect(asked).toBe(1));
  expect(happened).toEqual(["first lends"]);
  first.close();
  await expect(run).rejects.toThrow("itx.standIn disconnected and could not reconnect");
  // one try to renew, and none after it: the reconnect schedule here is empty
  expect({ asked, happened }).toEqual({ asked: 1, happened: ["first lends", "first let go"] });
  expect(quiet.lines.join("\n")).toContain("Could not renew itx.standIn before its sign-in ends");
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

/** A mind's connection as `runProvide` uses it, which says in `happened` when the name is lent over
 *  it and when it is let go. `close()` is the mind closing it. */
function connectionOf(name: string, happened: string[]) {
  const lent = Promise.withResolvers<void>();
  const disposed = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  let over = false;
  const connection = {
    address: "example.com",
    itx: {
      provide: async () => {
        happened.push(`${name} lends`);
        lent.resolve();
        return { lendEnded: () => new Promise<string>(() => {}), [Symbol.dispose]: () => {} };
      },
    },
    closed: closed.promise,
    [Symbol.dispose]() {
      if (over) return;
      over = true;
      happened.push(`${name} let go`);
      disposed.resolve();
    },
  } as unknown as Parameters<typeof runProvide>[0]["connection"];
  return {
    connection,
    lent: lent.promise,
    disposed: disposed.promise,
    close: () => closed.resolve({ code: 1008, reason: "the sign-in for this session ended" }),
  };
}

/** What the run prints, kept from the test's output. */
function quietConsole() {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line) => void lines.push(String(line)));
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((line) => void lines.push(String(line)));
  return {
    lines,
    [Symbol.dispose]() {
      log.mockRestore();
      error.mockRestore();
    },
  };
}
