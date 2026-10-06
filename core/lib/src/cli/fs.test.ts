// fs.test.ts — `iterate fs`: each operation against a temporary directory, through `runFs` with
// streams of the test's own, and once as the program the platform writes into a container.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { expect, test } from "vitest";
import { runFs, type FsEntry, type FsStat } from "./fs.ts";

test("read streams a file's bytes, all of them, and writes nothing else", async () => {
  await using dir = await scratch();
  const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
  await writeFile(join(dir.path, "big.bin"), bytes);
  const run = await fs(["read", join(dir.path, "big.bin")]);
  expect(run).toMatchObject({ code: 0, stderr: "" });
  expect(Buffer.concat(run.stdout).equals(bytes)).toBe(true);
});

test("read of a missing file or a directory fails before any byte, with the code as JSON on stderr", async () => {
  await using dir = await scratch();
  const missing = await fs(["read", join(dir.path, "nope")]);
  expect(missing).toMatchObject({
    code: 1,
    error: { code: "ENOENT", message: expect.stringContaining("nope") },
  });
  expect(Buffer.concat(missing.stdout)).toHaveLength(0);
  expect(await fs(["read", dir.path])).toMatchObject({ code: 1, error: { code: "EISDIR" } });
});

test("write creates or truncates a file from stdin; a missing parent fails ENOENT and a directory EISDIR", async () => {
  await using dir = await scratch();
  const file = join(dir.path, "out.txt");
  await writeFile(file, "a much longer earlier content");
  expect(await fs(["write", file], "short")).toMatchObject({ code: 0 });
  expect(await readFile(file, "utf8")).toBe("short");
  expect(await fs(["write", join(dir.path, "no", "such", "out.txt")], "x")).toMatchObject({
    code: 1,
    error: { code: "ENOENT" },
  });
  expect(await fs(["write", dir.path], "x")).toMatchObject({ code: 1, error: { code: "EISDIR" } });
});

test("stat follows a symlink and lstat does not; ls lists names with their types", async () => {
  await using dir = await scratch();
  await writeFile(join(dir.path, "a.txt"), "12345");
  await mkdir(join(dir.path, "sub"));
  await symlink("a.txt", join(dir.path, "link"));
  const stat = JSON.parse((await fs(["stat", join(dir.path, "link")])).stdout.join("")) as FsStat;
  const lstat = JSON.parse((await fs(["lstat", join(dir.path, "link")])).stdout.join("")) as FsStat;
  expect([stat.type, stat.size, lstat.type]).toEqual(["file", 5, "symlink"]);
  const listing = JSON.parse((await fs(["ls", dir.path])).stdout.join("")) as FsEntry[];
  expect(listing.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: "a.txt", type: "file" },
    { name: "link", type: "symlink" },
    { name: "sub", type: "directory" },
  ]);
  expect(await fs(["ls", join(dir.path, "a.txt")])).toMatchObject({ error: { code: "ENOTDIR" } });
});

test("mkdir, mv and rm: recursive and force are flags, and their absence is an error", async () => {
  await using dir = await scratch();
  const deep = join(dir.path, "x", "y", "z");
  expect(await fs(["mkdir", deep])).toMatchObject({ error: { code: "ENOENT" } });
  expect(await fs(["mkdir", "--recursive", deep])).toMatchObject({ code: 0 });
  await writeFile(join(deep, "f"), "1");
  expect(await fs(["mv", join(deep, "f"), join(dir.path, "moved")])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir.path, "moved"), "utf8")).toBe("1");
  expect(await fs(["rm", join(dir.path, "x")])).toMatchObject({
    code: 1,
    error: { code: expect.stringMatching(/EISDIR|EPERM/) },
  });
  expect(await fs(["rm", "--recursive", join(dir.path, "x")])).toMatchObject({ code: 0 });
  expect(await fs(["rm", join(dir.path, "x")])).toMatchObject({ error: { code: "ENOENT" } });
  expect(await fs(["rm", "--force", join(dir.path, "x")])).toMatchObject({ code: 0 });
});

test("a bad operation or flag is EUSAGE", async () => {
  expect(await fs(["bogus"])).toMatchObject({ error: { code: "EUSAGE" } });
  expect(await fs(["read"])).toMatchObject({ error: { code: "EUSAGE" } });
  expect(await fs(["rm", "--nope", "x"])).toMatchObject({ error: { code: "EUSAGE" } });
});

test("as a program, `node fs.ts` is what the platform writes into a container", async () => {
  await using dir = await scratch();
  const file = join(dir.path, "program.txt");
  expect(await program(["write", file], "through a process")).toMatchObject({ code: 0 });
  expect(await program(["read", file])).toEqual({
    code: 0,
    stdout: "through a process",
    stderr: "",
  });
  const missing = await program(["read", join(dir.path, "nope")]);
  expect([missing.code, JSON.parse(missing.stderr)]).toMatchObject([1, { code: "ENOENT" }]);
});

/** `runFs` with the streams of the test: what it wrote, and how it ended. */
async function fs(argv: string[], stdin = "") {
  const out = new PassThrough();
  const stdout: Buffer[] = [];
  out.on("data", (chunk: Buffer) => stdout.push(chunk));
  const err = new PassThrough();
  let stderr = "";
  err.on("data", (chunk: Buffer) => (stderr += chunk));
  const code = await runFs(argv, {
    stdin: Readable.from([Buffer.from(stdin)]),
    stdout: out,
    stderr: err,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    code,
    stdout,
    stderr,
    error: stderr ? (JSON.parse(stderr) as { code: string }) : undefined,
  };
}

/** The same file as a process, as a container runs it. */
function program(args: string[], stdin?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [
      "--no-warnings",
      join(import.meta.dirname, "fs.ts"),
      ...args,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function scratch() {
  const path = await mkdtemp(join(tmpdir(), "iterate-fs-"));
  return { path, [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }) };
}
