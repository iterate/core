// src/sandbox/files.ts — `itx.sandboxes.get(path).files`: the Sandbox SDK's `Files` (read, write,
// stat, lstat, readDirectory, mkdir, rename, remove), over the sandbox's container, with `iterate fs`
// (core/lib cli/fs.ts) where the SDK has `sandbox-shim`. A file is read and written as a stream; a
// failure carries the errno's name as `code` (`ENOENT`, `EISDIR`, …).
//
// An RpcTarget, so a caller's `files.read(path)` is one call whose answer, a `ReadableStream`, crosses
// the facet and the client's session as it is. Every call starts the container first, from the disk
// the log recorded, like `exec` does: `use` is the facet's.
import { RpcTarget } from "cloudflare:workers";
import type { SandboxFileStat } from "iterate/api";
import { z } from "zod";
import type { SandboxContainer } from "./container.ts";

export type SandboxDirectoryEntry = { name: string; type: SandboxFileStat["type"] };

const Path = z.string().min(1);
const Content = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer),
  // a stream's chunk type cannot be checked up front: a chunk that is not bytes fails the write
  z.custom<ReadableStream<Uint8Array>>((value) => value instanceof ReadableStream),
]);

const Flags = z.object({ recursive: z.boolean().optional(), force: z.boolean().optional() });

const textEncoder = new TextEncoder();

/** The facet's `use`: the container, started, for `work`. */
export type UseContainer = <T>(
  work: (container: DurableObjectStub<SandboxContainer>) => Promise<T>,
) => Promise<T>;

export class SandboxFiles extends RpcTarget {
  readonly #use: UseContainer;

  constructor(use: UseContainer) {
    super();
    this.#use = use;
  }

  /** A file's bytes, as a stream. A missing file, or a directory, fails the call, not the stream. */
  read(path: string): Promise<ReadableStream<Uint8Array>> {
    const file = Path.parse(path);
    return this.#use((container) => container.filesRead(file));
  }

  /** `content` into a file, created or truncated; its directory must exist. A string is UTF-8. */
  write(path: string, content: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>) {
    const file = Path.parse(path);
    const given = Content.parse(content);
    const body =
      typeof given === "string"
        ? textEncoder.encode(given)
        : given instanceof ArrayBuffer
          ? new Uint8Array(given)
          : given;
    return this.#use((container) => container.filesWrite(file, body));
  }

  /** A path's metadata; a symbolic link is followed. */
  stat(path: string): Promise<SandboxFileStat> {
    return this.#run(["stat", Path.parse(path)]);
  }

  /** `stat` without following a symbolic link at the end of the path. */
  lstat(path: string): Promise<SandboxFileStat> {
    return this.#run(["lstat", Path.parse(path)]);
  }

  /** A directory's immediate entries, in the order the directory gives them. */
  readDirectory(path: string): Promise<SandboxDirectoryEntry[]> {
    return this.#run(["ls", Path.parse(path)]);
  }

  /** A directory; with `recursive`, its missing parents too, and no error when it exists. */
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const { recursive } = Flags.parse(options || {});
    await this.#run(["mkdir", ...(recursive ? ["--recursive"] : []), Path.parse(path)]);
  }

  /** A file, directory or link renamed; an existing file at the destination is replaced. */
  async rename(source: string, destination: string): Promise<void> {
    await this.#run(["mv", Path.parse(source), Path.parse(destination)]);
  }

  /** A file or link removed; a directory needs `recursive`, and `force` makes a missing path no error. */
  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const { recursive, force } = Flags.parse(options || {});
    await this.#run([
      "rm",
      ...(recursive ? ["--recursive"] : []),
      ...(force ? ["--force"] : []),
      Path.parse(path),
    ]);
  }

  /** One `iterate fs` operation, its answer (JSON, or nothing) parsed. */
  async #run<T>(args: string[]): Promise<T> {
    const out = await this.#use((container) => container.filesRun(args));
    // `iterate fs` prints the shapes of `SandboxFileStat` and `SandboxDirectoryEntry` (cli/fs.ts)
    return (out ? JSON.parse(out) : undefined) as T;
  }
}
