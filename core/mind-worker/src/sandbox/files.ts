import { RpcTarget } from "cloudflare:workers";
import type { SandboxFileStat } from "iterate/api";
import { z } from "zod";
import type { SandboxContainer } from "./container.ts";

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

type UseContainer = <T>(
  work: (container: DurableObjectStub<SandboxContainer>) => Promise<T>,
) => Promise<T>;

export class SandboxFiles extends RpcTarget {
  readonly #use: UseContainer;

  constructor(use: UseContainer) {
    super();
    this.#use = use;
  }

  read(path: string): Promise<ReadableStream<Uint8Array>> {
    const file = Path.parse(path);
    return this.#use((container) => container.filesRead(file));
  }

  /** A string is UTF-8; the file's directory must exist. */
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

  stat(path: string): Promise<SandboxFileStat> {
    return this.#run(["stat", Path.parse(path)]);
  }

  lstat(path: string): Promise<SandboxFileStat> {
    return this.#run(["lstat", Path.parse(path)]);
  }

  readDirectory(path: string): Promise<{ name: string; type: SandboxFileStat["type"] }[]> {
    return this.#run(["ls", Path.parse(path)]);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const { recursive } = Flags.parse(options || {});
    await this.#run(["mkdir", ...(recursive ? ["--recursive"] : []), Path.parse(path)]);
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.#run(["mv", Path.parse(source), Path.parse(destination)]);
  }

  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const { recursive, force } = Flags.parse(options || {});
    await this.#run([
      "rm",
      ...(recursive ? ["--recursive"] : []),
      ...(force ? ["--force"] : []),
      Path.parse(path),
    ]);
  }

  async #run<T>(args: string[]): Promise<T> {
    const out = await this.#use((container) => container.filesRun(args));
    // `iterate fs` prints these shapes (core/lib cli/fs.ts)
    return (out ? JSON.parse(out) : undefined) as T;
  }
}
