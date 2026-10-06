// fs.ts — THE FILES OF THE MACHINE IT RUNS ON, one implementation and two entry points:
//   `files`  the operations as functions, a file as a web stream. `iterate use-my-computer` lends it.
//   `runFs`  `iterate fs <op>`, one process per operation: argv in, bytes out. It only adapts `files`
//            to argv, stdin and stdout, so a file is read and written by the same code through both.
// A sandbox (`itx.sandboxes.get(path).files`) uses the second: the platform runs this file inside the
// container over `exec`, in place of the Sandbox SDK's `sandbox-shim`.
//
// STANDALONE ON PURPOSE. It imports `node:*` alone and uses only syntax Node strips (types, no enums
// or parameter properties), so the platform can write this very file into a container and run it as
// `node fs.ts <op>` with nothing installed: no npm, no build, and no CLI start-up (the CLI loads its
// whole client first, and a file operation should not pay for that).
//
// THE PROTOCOL of `runFs`, shared with core/os `sandbox/files.ts`, which runs it:
//   read <path>               the file's bytes on stdout; nothing is written before the file opened
//   write <path>              stdin into the file, created or truncated, once it opened
//   stat <path>, lstat <path> one JSON line: `FsStat`
//   ls <path>                 one JSON line: `FsEntry[]`, in the order the directory gives them
//   mkdir [--recursive] <path>
//   mv <source> <destination>
//   rm [--recursive] [--force] <path>
// An operation that fails writes one JSON line to stderr, `{"code":"ENOENT","message":"…"}`, and
// exits 1: before any byte for `read` and `write` (the file did not open), so a caller that sees
// bytes knows the file is there. An error after the bytes began errors the stream the same way, with
// the exit code as the only word.
import { mkdir, open, readdir, rename, rm, lstat, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export type FsType = "file" | "directory" | "symlink" | "other";
export type FsStat = {
  type: FsType;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
};
export type FsEntry = { name: string; type: FsType };

/** What `runFs` reads and writes: a process's own streams, or a test's. */
export type FsIo = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

const typeOf = (stats: Pick<Stats, "isFile" | "isDirectory" | "isSymbolicLink">): FsType =>
  stats.isFile()
    ? "file"
    : stats.isDirectory()
      ? "directory"
      : stats.isSymbolicLink()
        ? "symlink"
        : "other";

const statOf = (stats: Stats): FsStat => ({
  type: typeOf(stats),
  size: stats.size,
  mode: stats.mode,
  uid: stats.uid,
  gid: stats.gid,
  atimeMs: stats.atimeMs,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
});

/** What a write takes: text, bytes, or a stream of bytes. */
export type FsContent = string | Uint8Array | AsyncIterable<Uint8Array>;

/** The operations. A failure is an error whose `code` is the errno's name (`ENOENT`, `EISDIR`, …). */
export const files = {
  /** A file's bytes. Answers once the file has opened, so a missing file or a directory fails the
   *  call, never the stream half way. */
  async read(path: string): Promise<ReadableStream<Uint8Array>> {
    const file = await open(path, "r");
    // opening a directory succeeds; reading it does not, and by then the caller has been told yes
    if ((await file.stat()).isDirectory()) {
      await file.close();
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), {
        code: "EISDIR",
      });
    }
    // the stream owns the handle from here and closes it; node's web stream type is the DOM's
    return Readable.toWeb(file.createReadStream()) as unknown as ReadableStream<Uint8Array>;
  },
  /** `content` into a file, created or truncated; its directory must exist. */
  async write(path: string, content: FsContent): Promise<void> {
    const file = await open(path, "w");
    const chunks =
      typeof content === "string"
        ? [Buffer.from(content)]
        : content instanceof Uint8Array
          ? [content]
          : content;
    await pipeline(chunks, file.createWriteStream());
  },
  /** A path's metadata, a symbolic link followed. */
  async stat(path: string): Promise<FsStat> {
    return statOf(await stat(path));
  },
  /** `stat` without following a symbolic link at the end of the path. */
  async lstat(path: string): Promise<FsStat> {
    return statOf(await lstat(path));
  },
  /** A directory's immediate entries, in the order it gives them. */
  async readDirectory(path: string): Promise<FsEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, type: typeOf(entry) }));
  },
  /** A directory; with `recursive`, its missing parents too, and no error when it exists. */
  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await mkdir(path, { recursive: options.recursive });
  },
  /** A file, directory or link renamed; an existing file at the destination is replaced. */
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  },
  /** A file or link removed; a directory needs `recursive`, `force` makes a missing path no error. */
  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<void> {
    await rm(path, { recursive: options.recursive, force: options.force });
  },
};

const usage = (message: string) => Object.assign(new Error(message), { code: "EUSAGE" });

/** Split `argv` into its flags and its operands; a flag is one of `known`. */
function operands(argv: string[], known: string[]) {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--") && known.includes(arg)) flags.add(arg);
    else if (arg.startsWith("--")) throw usage(`unknown flag ${arg}`);
    else rest.push(arg);
  }
  return { flags, rest };
}

/** Run one operation. Resolves to the exit code: 0, or 1 after the one-line JSON error on stderr. */
export async function runFs(argv: string[], io: FsIo): Promise<number> {
  const [op, ...args] = argv;
  try {
    switch (op) {
      case "read": {
        const [path] = operands(args, []).rest;
        if (!path) throw usage("read <path>");
        await pipeline(await files.read(path), io.stdout, { end: false });
        return 0;
      }
      case "write": {
        const [path] = operands(args, []).rest;
        if (!path) throw usage("write <path>");
        // a process's stdin yields buffers; the interface is the DOM's `NodeJS.ReadableStream`
        await files.write(path, io.stdin as AsyncIterable<Uint8Array>);
        return 0;
      }
      case "stat":
      case "lstat": {
        const [path] = operands(args, []).rest;
        if (!path) throw usage(`${op} <path>`);
        io.stdout.write(`${JSON.stringify(await files[op](path))}\n`);
        return 0;
      }
      case "ls": {
        const [path] = operands(args, []).rest;
        if (!path) throw usage("ls <path>");
        io.stdout.write(`${JSON.stringify(await files.readDirectory(path))}\n`);
        return 0;
      }
      case "mkdir": {
        const { flags, rest } = operands(args, ["--recursive"]);
        if (!rest[0]) throw usage("mkdir [--recursive] <path>");
        await files.mkdir(rest[0], { recursive: flags.has("--recursive") });
        return 0;
      }
      case "mv": {
        const [from, to] = operands(args, []).rest;
        if (!from || !to) throw usage("mv <source> <destination>");
        await files.rename(from, to);
        return 0;
      }
      case "rm": {
        const { flags, rest } = operands(args, ["--recursive", "--force"]);
        if (!rest[0]) throw usage("rm [--recursive] [--force] <path>");
        await files.remove(rest[0], {
          recursive: flags.has("--recursive"),
          force: flags.has("--force"),
        });
        return 0;
      }
      default:
        throw usage(
          `unknown operation ${JSON.stringify(op)}: read, write, stat, lstat, ls, mkdir, mv, rm`,
        );
    }
  } catch (error) {
    // node's file system errors carry the errno's name as `code`; anything else is reported as EIO
    const { code, message } = error as { code?: string; message?: string };
    io.stderr.write(
      `${JSON.stringify({ code: code || "EIO", message: message || String(error) })}\n`,
    );
    return 1;
  }
}

// Run as a program (`node fs.ts <op>`): the file written into a container. Imported, it only exports.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runFs(process.argv.slice(2), process);
