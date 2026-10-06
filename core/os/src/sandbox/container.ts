// src/sandbox/container.ts — THE SANDBOX'S CONTAINER: one Durable Object per sandbox, named by the
// sandbox's context, which owns the Linux container through `ctx.container` directly (no Sandbox SDK,
// no `@cloudflare/containers`: SDK 1.0 removed its `Sandbox` class, and `Container` cannot restore a
// snapshot). It is a Durable Object of its own because a class linked to a container gets
// `ctx.container` only as one, not as a facet (measured).
//
// THE API IS REPLAYED. `ctx.container` and the `ExecProcess` it hands out cannot cross an RPC, so
// `invoke(steps)` walks a caller's chain HERE, where they live, over the API's own members only
// (`REACHABLE`: a native object's prototype chain would otherwise reach `Function`). A
// `ReadableStream` result crosses as it is; `.output()` becomes plain data.
//
// THE FILES are the `iterate fs` tool (core/lib cli/fs.ts) run in the container per operation, in
// place of the Sandbox SDK's `sandbox-shim`: it needs only the Node the managed image has.
//
// COMPUTE ONLY: what the sandbox is lives on the facet's log (durable-object.ts). This class keeps
// the clock of the last use, which the processor's check asks for.
/// <reference path="./raw.d.ts" />
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
// the tool as text; `node` strips its types
import filesTool from "../../../lib/src/cli/fs.ts?raw";
import { SANDBOX_IMAGE, SANDBOX_MAX_BUSY_MS } from "./contract.ts";

/** The CA the container's HTTPS interception signs with: what a TLS client must trust for a request
 *  to reach the project's egress. */
const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** What every command is run with, so its TLS clients trust the interception CA (OpenSSL tools,
 *  Node, `requests`). A container's own `env` is not enough: on Cloudflare a command does not
 *  inherit it (measured: SELF_SIGNED_CERT_IN_CHAIN). */
const TRUST_INTERCEPT_CA = {
  SSL_CERT_FILE: INTERCEPT_CA,
  NODE_EXTRA_CA_CERTS: INTERCEPT_CA,
  REQUESTS_CA_BUNDLE: INTERCEPT_CA,
  CURL_CA_BUNDLE: INTERCEPT_CA,
  GIT_SSL_CAINFO: INTERCEPT_CA,
};
/** What the container runs: a process that stays (the image's own command is a Node REPL, which
 *  ends at once and the container with it), once the system's store trusts the interception CA. */
const SANDBOX_ENTRYPOINT = [
  "sh",
  "-c",
  `if [ -f ${INTERCEPT_CA} ] && command -v update-ca-certificates >/dev/null 2>&1; then cp ${INTERCEPT_CA} /usr/local/share/ca-certificates/ && update-ca-certificates >/dev/null 2>&1; fi; exec sleep infinity`,
];
/** How long a start may take before it counts as failed. */
const START_TIMEOUT_MS = 90_000;
/** How often a start asks whether the container answers yet. */
const START_POLL_MS = 250;
/** The most one command may print on each stream: more fails, since half an answer is worse than none. */
const SANDBOX_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** How long a command runs when its caller names no bound. */
const SANDBOX_EXEC_TIMEOUT_MS = 10 * 60_000;
/** Cloudflare stops a container nothing has talked to for this long. The processor's check parks
 *  the sandbox (disk saved) well before; this ends what a failing park would leave billing. */
const INACTIVITY_BACKSTOP_MS = 2 * 60 * 60_000;
/** The default instance: 1/2 vCPU, 4 GiB. `lite` (1/16 vCPU) takes a minute to parse apt's index. */
const SANDBOX_INSTANCE = "standard-1";
/** A stream being read stamps the clock this often, no more: well under the shortest idle period
 *  a sandbox may be given (one second, contract.ts). */
const STAMP_EVERY_MS = 500;

/** The tool's file name carries a hash of its text, so a disk holding an older tool gets this one. */
const toolHash = [...filesTool].reduce(
  (hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0,
  2166136261,
);
const TOOL_PATH = `/usr/local/lib/iterate/fs-${toolHash.toString(16)}.ts`;
const TOOL = ["node", "--no-warnings", TOOL_PATH];

/** What a replay may name: the container API's members and its `ExecProcess`'s (`workers-types`'
 *  `Container` and `ExecProcess`). */
const REACHABLE: ReadonlySet<string> = new Set([
  // Container
  "running",
  "images",
  "start",
  "monitor",
  "destroy",
  "signal",
  "getTcpPort",
  "setInactivityTimeout",
  "snapshotContainer",
  "exec",
  "inspect",
  // Fetcher, what `getTcpPort` answers: a request to a port of the container
  "fetch",
  // ExecProcess
  "stdin",
  "stdout",
  "stderr",
  "pid",
  "isPty",
  "exitCode",
  "output",
  "kill",
  "resize",
]);

/** `ctx.container.start`'s options, as an RPC carries them: a start from a snapshot or from an
 *  image (never both), and what the container is started with. Defaults: the managed image, a
 *  process that stays. NEVER `enableInternet`: a sandbox's only way out is the project's egress
 *  (egress.ts). */
export type SandboxStartOptions = {
  image?: string;
  containerSnapshot?: { id: string };
  entrypoint?: string[];
  env?: Record<string, string>;
  instance?: ContainerStartupOptions["instance"];
  labels?: Record<string, string>;
};

/** `ctx.container.exec`'s options that an RPC carries; `stdin` is the bytes the command reads, and
 *  `timeoutMs` stands for the `signal` that cannot cross. */
export type SandboxExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  stdin?: Uint8Array;
  timeoutMs?: number;
};
export type SandboxExecResult = { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };

type Steps = (string | [string, ...unknown[]])[];

/** The options of a replayed `exec` and `start` that the platform reads; the rest goes to Cloudflare. */
const ExecStepOptions = z.looseObject({
  stdin: z.unknown().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const StartStepOptions = z.looseObject({});
/** `iterate fs`'s one-line JSON error (cli/fs.ts). */
const FsError = z.object({ code: z.string(), message: z.string() });

/** `iterate fs`'s one-line JSON error as a thrown error: `code` is the errno's name. */
function fileError(stderr: string, exitCode: number): Error {
  try {
    const { code, message } = FsError.parse(JSON.parse(stderr.trim().split("\n").at(-1) || ""));
    return Object.assign(new Error(`${code}: ${message}`), { code });
  } catch {
    return Object.assign(new Error(`iterate fs failed (${exitCode}): ${stderr.trim()}`), {
      code: "EIO",
    });
  }
}

/** A tool process whose stderr is being read from the moment it started: the container carries
 *  stdout and stderr over one connection, so a stdout that is read to its end while stderr is not
 *  read at all may never end (the shim's protocol notes say the same). */
type Tool = { process: ExecProcess; stderr: Promise<string> };

const drained = (process: ExecProcess): Tool => ({
  process: watched(process),
  stderr: new Response(process.stderr!).text(),
});

/** How a tool process ended: the error it reported, or none. */
async function ended({ process, stderr }: Tool): Promise<Error | undefined> {
  const [text, exitCode] = await Promise.all([stderr, process.exitCode]);
  return exitCode === 0 ? undefined : fileError(text, exitCode);
}

/** `source` into the process's stdin, closed at its end, by a loop: `pipeTo` into a container's stdin
 *  loses the connection after the last byte. A write that fails because the command ended without
 *  reading is the command's to explain: its exit says. */
async function feed(process: ExecProcess, source: ReadableStream<Uint8Array>): Promise<void> {
  watched(process);
  const writer = process.stdin!.getWriter();
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.close();
  } catch {
    await reader.cancel().catch(() => undefined);
    // a command left waiting for input that will not come would run until its call ceiling
    kill(process);
  }
}

/** Processes that have ended: Cloudflare raises an error inside the object when a signal reaches
 *  a process that has exited, so `kill` is never sent to one. */
const exited = new WeakSet<ExecProcess>();
const watched = (process: ExecProcess): ExecProcess => {
  void process.exitCode.then(
    () => exited.add(process),
    () => exited.add(process),
  );
  return process;
};
const kill = (process: ExecProcess) => {
  if (!exited.has(process)) process.kill();
};

/** `stream`'s bytes, refusing to hold more than `limit`: a command's output is held in this
 *  object's memory, which is shared with every other object in its isolate. */
async function readUpTo(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`a command printed more than ${limit} bytes: write it to a file`);
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

export class SandboxContainer extends DurableObject {
  /** The calls running now, by when each began: a container with one is in use, however long ago
   *  its last began, but for no longer than SANDBOX_MAX_BUSY_MS (a call that never ends is not use).
   *  Kept here as well as on the facet, so a facet replaced mid-call does not make a call idle. */
  #calls = new Map<number, number>();
  #nextCall = 0;
  #stampedAt = 0;
  /** This container's disk holds the tool: set once it has been checked or written, and unset
   *  whenever a container starts or stops (a new disk). */
  #toolReady = false;

  /** An object that restarts (it is evicted a few seconds after its last call) starts with no
   *  inactivity timeout, and Cloudflare then stops its container shortly after: so a restart that
   *  finds the container running sets the timeout again, before anything else runs. */
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running)
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS));
  }

  /** The container, which this class's configuration makes `ctx.container` present. */
  get #container(): Container {
    if (!this.ctx.container) throw new Error("SandboxContainer: this class has no container");
    return this.ctx.container;
  }

  /** Epoch ms of the last call to start or end. Kept in storage: this object is evicted while the
   *  container goes on, and the check must not read a fresh object's clock as a fresh use. */
  async #touch(): Promise<void> {
    this.#stampedAt = Date.now();
    await this.ctx.storage.put("usedAt", this.#stampedAt);
  }

  /** A stream being read stamps the clock, at most every STAMP_EVERY_MS. */
  async #touchSometimes(): Promise<void> {
    if (Date.now() - this.#stampedAt > STAMP_EVERY_MS) await this.#touch();
  }

  /** Run `work` as a use of the container: counted while it runs, and stamped at both ends. */
  async #use<T>(work: () => Promise<T>): Promise<T> {
    const call = this.#nextCall++;
    this.#calls.set(call, Date.now());
    await this.#touch();
    try {
      return await work();
    } finally {
      this.#calls.delete(call);
      await this.#touch();
    }
  }

  /** When the running container was last used (epoch ms), or null when none runs. A checkpoint is no
   *  use: only a start, a command and a file are. */
  async usedAt(): Promise<number | null> {
    if (!this.#container.running) return null;
    const since = Date.now() - SANDBOX_MAX_BUSY_MS;
    if ([...this.#calls.values()].some((began) => began > since)) return Date.now();
    return (await this.ctx.storage.get<number>("usedAt")) ?? 0;
  }

  /** Make a container run; false when one did already. A snapshot that Cloudflare will not restore
   *  FAILS the start, leaving the container stopped: falling back to the image would lose the disk
   *  without a word. The facet's start; the raw `start` goes through `invoke`. */
  async begin(options: SandboxStartOptions = {}): Promise<boolean> {
    await this.#touch();
    const container = this.#container;
    if (container.running) {
      await container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS);
      return false;
    }
    this.#toolReady = false;
    const { image, containerSnapshot, ...rest } = options;
    // the egress is registered first: a name looked up before it is would time out
    await this.#intercept();
    container.start({
      entrypoint: SANDBOX_ENTRYPOINT,
      instance: SANDBOX_INSTANCE,
      ...rest,
      env: { ...TRUST_INTERCEPT_CA, ...rest.env },
      enableInternet: false,
      ...(containerSnapshot ? { containerSnapshot } : { image: image || SANDBOX_IMAGE }),
    });
    try {
      await container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS);
      await this.#untilAnswering();
    } catch (error) {
      await container.destroy("start failed").catch(() => undefined);
      throw error;
    }
    return true;
  }

  /** Every HTTP and HTTPS request of the container is answered by the project's egress
   *  (`SandboxEgress`, egress.ts): all of port 80, and every host on 443. With the internet off,
   *  nothing else resolves or connects. */
  async #intercept(): Promise<void> {
    if (!this.ctx.id.name) throw new Error("SandboxContainer: its name is the sandbox's context");
    // the generated `Env` types do not name this entrypoint, whose `props` are the sandbox's context
    const { SandboxEgress } = this.ctx.exports as unknown as {
      SandboxEgress: (options: { props: { iterateContextName: string } }) => Fetcher;
    };
    const egress = SandboxEgress({ props: { iterateContextName: this.ctx.id.name } });
    await this.#container.interceptAllOutboundHttp(egress);
    await this.#container.interceptOutboundHttps("*", egress);
  }

  /** `start` returns before the container can run a command: a trivial one is the readiness probe. */
  async #untilAnswering(): Promise<void> {
    const container = this.#container;
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (let lastError: unknown; ;) {
      try {
        if ((await (await container.exec(["true"])).exitCode) === 0) return;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() > deadline || !container.running)
        throw new Error(
          `the container did not come up: ${lastError instanceof Error ? lastError.message : "no answer"}`,
        );
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }
  }

  // ── the container API, replayed ──

  /** `steps` walked on `ctx.container`: a string is a member, `[name, ...args]` a call (the shape of
   *  an itx expression's steps). Answers the last value, which must cross an RPC. */
  invoke(steps: Steps): Promise<unknown> | Fetcher {
    const [first] = steps;
    const name = typeof first === "string" ? first : first?.[0];
    // a Fetcher is no value to return from a promise (its `then` is a call): answered as it is
    if (steps.length === 1 && name === "getTcpPort" && Array.isArray(first))
      return this.#container.getTcpPort(Number(first[1]));
    // a pending `monitor` is a wait, not a use: it must not hold the sandbox from being parked
    return name === "monitor" ? this.#replay(steps) : this.#use(() => this.#replay(steps));
  }

  async #replay(steps: Steps): Promise<unknown> {
    let value: unknown = this.#container;
    let pump: Promise<void> | undefined;
    let source: ReadableStream<Uint8Array> | undefined;
    for (const [index, step] of steps.entries()) {
      const [member, ...rawArgs] = typeof step === "string" ? [step] : step;
      const reachable =
        REACHABLE.has(member) ||
        // data a step answered: its own members
        (value instanceof Object &&
          [Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)) &&
          Object.hasOwn(value, member));
      if (!reachable) throw new Error(`${member} is not part of the container API`);
      const fixed = this.#fixed(index === 0, member, rawArgs);
      source ||= fixed.source;
      if (index === 0 && (member === "start" || member === "destroy")) this.#toolReady = false;
      if (index === 0 && member === "start") await this.#intercept();
      // the walk is dynamic by design: `REACHABLE` has vetted `member` as one of the native object's
      const target = value as Record<string, unknown>;
      const next =
        typeof step === "string"
          ? target[member]
          : (target[member] as (...args: unknown[]) => unknown)(...fixed.args);
      value = next instanceof Promise ? await next : next;
      // an `exec` given a stream on stdin answers a process
      if (source && !pump) pump = feed(value as ExecProcess, source);
    }
    if (pump) this.ctx.waitUntil(pump);
    return this.#plain(value);
  }

  /** A first step's arguments as the platform lets them reach Cloudflare. An `exec` trusts the
   *  interception CA unless it says otherwise, and a stream on its stdin is fed by a loop (`feed`):
   *  handed over as it is, an RPC stream never ends. A raw `start` is Cloudflare's own with one rule,
   *  the internet stays off, so the project's egress is the only way out. */
  #fixed(
    first: boolean,
    member: string,
    args: unknown[],
  ): { args: unknown[]; source?: ReadableStream<Uint8Array> } {
    if (first && member === "exec") {
      const { stdin, ...options } = ExecStepOptions.parse(args[1] ?? {});
      const given = { ...options, env: { ...TRUST_INTERCEPT_CA, ...options.env } };
      return stdin instanceof ReadableStream
        ? { args: [args[0], { ...given, stdin: "pipe" }], source: stdin }
        : { args: [args[0], stdin === undefined ? given : { ...given, stdin }] };
    }
    if (first && member === "start")
      return {
        args: [
          {
            instance: SANDBOX_INSTANCE,
            ...StartStepOptions.parse(args[0] ?? {}),
            enableInternet: false,
          },
        ],
      };
    return { args };
  }

  /** What an RPC can carry of a replay's answer: `.output()`'s native result as plain data, a
   *  process, which cannot cross, as an error that says what to chain, and a stream as one that
   *  stamps the clock as it is read (a `tail -f` being read is use; one nobody reads is not). */
  #plain(value: unknown): unknown {
    const named = (type: string) => value instanceof Object && value.constructor?.name === type;
    if (named("ExecProcess"))
      throw new Error("exec(…) answers a process: chain .output(), .stdout, .stderr or .exitCode");
    if (named("ExecOutput")) {
      // checked by its class name: the runtime does not export the class to test against
      const { exitCode, stdout, stderr } = value as ExecOutput;
      return { exitCode, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) };
    }
    if (value instanceof ReadableStream)
      return value.pipeThrough(
        new TransformStream({
          transform: async (chunk, controller) => {
            await this.#touchSometimes();
            controller.enqueue(chunk);
          },
        }),
      );
    return value;
  }

  // ── commands and files, over `exec` ──

  /** `ctx.container.exec(command, options)` and `process.output()`: run `command` (argv, never a
   *  shell line) and wait for it. The caller decides whether a nonzero exit is an error. */
  exec(command: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    return this.#use(async () => {
      // not `AbortSignal.timeout`: it can fire after the process has exited, which Cloudflare
      // raises as an error inside this object
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? SANDBOX_EXEC_TIMEOUT_MS);
      const process = watched(
        await this.#container.exec(command, {
          cwd: options.cwd,
          env: { ...TRUST_INTERCEPT_CA, ...options.env },
          user: options.user,
          stdin: options.stdin ? new Blob([options.stdin]).stream() : undefined,
          stdout: "pipe",
          stderr: "pipe",
          signal: timeout.signal,
        }),
      );
      try {
        // both streams at once, as Cloudflare advises: one that is not read can stall the other
        const [stdout, stderr, exitCode] = await Promise.all([
          readUpTo(process.stdout!, SANDBOX_MAX_OUTPUT_BYTES),
          readUpTo(process.stderr!, SANDBOX_MAX_OUTPUT_BYTES),
          process.exitCode,
        ]);
        return { exitCode, stdout, stderr };
      } catch (error) {
        kill(process);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** The tool's command, once its file is on this container's disk. */
  async #tool(): Promise<string[]> {
    if (this.#toolReady) return TOOL;
    const container = this.#container;
    const there = await container.exec(["test", "-f", TOOL_PATH]);
    if ((await there.exitCode) !== 0) {
      const write = await container.exec(
        ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", TOOL_PATH],
        { stdin: new Blob([filesTool]).stream(), stdout: "ignore", stderr: "pipe" },
      );
      const failure = await ended(drained(write));
      if (failure)
        throw new Error(`iterate fs could not be put into the container: ${failure.message}`);
    }
    this.#toolReady = true;
    return TOOL;
  }

  /** One tool process, started, its stderr already being read; `iterate fs` needs Node, which the
   *  managed image has. */
  async #fs(
    args: string[],
    options: { stdin?: "pipe"; stdout?: "pipe" | "ignore" } = {},
  ): Promise<Tool> {
    return drained(
      await this.#container.exec([...(await this.#tool()), ...args], {
        stdin: options.stdin,
        stdout: options.stdout || "pipe",
        stderr: "pipe",
      }),
    );
  }

  /** A tool process run to its end: its stdout, or the error it reported. */
  async #fsRun(args: string[]): Promise<string> {
    const tool = await this.#fs(args);
    const [stdout, failure] = await Promise.all([
      new Response(tool.process.stdout!).text(),
      ended(tool),
    ]);
    if (failure) throw failure;
    return stdout;
  }

  /** A file's bytes as a stream, answered once the file has opened (a missing file, or a directory,
   *  fails here and not mid-stream); a failure after bytes began errors the stream. The call is a use
   *  until it answers, and a stream is used as it is read: each chunk read stamps the clock, so one a
   *  client abandons stops being use and the sandbox can be parked. */
  filesRead(path: string): Promise<ReadableStream<Uint8Array>> {
    return this.#use(async () => {
      const tool = await this.#fs(["read", path]);
      const reader = tool.process.stdout!.getReader();
      const first = await reader.read();
      if (first.done) {
        const failure = await ended(tool);
        if (failure) throw failure;
        return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
      }
      return new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(first.value),
        pull: async (controller) => {
          const { done, value } = await reader.read();
          if (!done) {
            await this.#touchSometimes();
            return controller.enqueue(value);
          }
          const failure = await ended(tool);
          if (failure) controller.error(failure);
          else controller.close();
        },
        cancel: async () => {
          kill(tool.process);
          await reader.cancel().catch(() => undefined);
        },
      });
    });
  }

  /** `content` into a file, created or truncated. */
  filesWrite(path: string, content: ReadableStream<Uint8Array> | Uint8Array): Promise<void> {
    return this.#use(async () => {
      const tool = await this.#fs(["write", path], { stdin: "pipe", stdout: "ignore" });
      await feed(
        tool.process,
        content instanceof ReadableStream ? content : new Blob([content]).stream(),
      );
      const failure = await ended(tool);
      if (failure) throw failure;
    });
  }

  /** One `iterate fs` operation that answers text (stat, lstat, ls: JSON) or nothing (mkdir, mv, rm). */
  filesRun(args: string[]): Promise<string> {
    return this.#use(() => this.#fsRun(args));
  }

  // ── what the facet's own policy needs (the idle stop, the checkpoint, a deletion) ──

  /** `ctx.container.snapshotContainer(options)`: save the disk of the running container. The
   *  container keeps running. */
  snapshotContainer(options: ContainerSnapshotOptions = {}): Promise<ContainerSnapshot> {
    return this.#container.snapshotContainer(options);
  }

  /** `ctx.container.destroy(reason)`: stop the container at once. What was not snapshotted is gone. */
  async destroy(reason?: string): Promise<void> {
    this.#toolReady = false;
    if (this.#container.running) await this.#container.destroy(reason);
  }

  /** The sandbox's deletion: stop the container and drop the clock. */
  async erase(): Promise<void> {
    await this.destroy("sandbox deleted");
    await this.ctx.storage.deleteAll();
  }
}
