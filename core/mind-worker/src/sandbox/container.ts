// A Durable Object of its own: a class linked to a container gets `ctx.container` only as one, not as
// a facet (measured). `ctx.container` cannot cross an RPC, so `invoke(steps)` replays a chain here.
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import filesTool from "../generated/sandbox-files-tool.js";
import { SANDBOX_BASE_IMAGE, SANDBOX_IMAGE, SANDBOX_MAX_BUSY_MS } from "./contract.ts";

const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** A command does not inherit the container's own `env` on Cloudflare (measured:
 *  SELF_SIGNED_CERT_IN_CHAIN), so every command is run with these. */
const TRUST_INTERCEPT_CA = {
  SSL_CERT_FILE: INTERCEPT_CA,
  NODE_EXTRA_CA_CERTS: INTERCEPT_CA,
  REQUESTS_CA_BUNDLE: INTERCEPT_CA,
  CURL_CA_BUNDLE: INTERCEPT_CA,
  GIT_SSL_CAINFO: INTERCEPT_CA,
};
/** Chromium's own trust store. The CA is new at every start, so a start replaces the entry. */
const NSS_DATABASE = "sql:/root/.pki/nssdb";
/** The image's own command is a Node REPL, which ends at once and the container with it. */
const SANDBOX_ENTRYPOINT = [
  "sh",
  "-c",
  `if [ -f ${INTERCEPT_CA} ] && command -v update-ca-certificates >/dev/null 2>&1; then cp ${INTERCEPT_CA} /usr/local/share/ca-certificates/ && update-ca-certificates >/dev/null 2>&1; fi; if [ -f ${INTERCEPT_CA} ] && command -v certutil >/dev/null 2>&1; then mkdir -p /root/.pki/nssdb && { [ -f /root/.pki/nssdb/cert9.db ] || certutil -d ${NSS_DATABASE} -N --empty-password; } && { certutil -d ${NSS_DATABASE} -D -n iterate-egress || true; } && certutil -d ${NSS_DATABASE} -A -t "C,," -n iterate-egress -i ${INTERCEPT_CA}; fi >/dev/null 2>&1; exec sleep infinity`,
];
/** More fails: half an answer is worse than none. */
const SANDBOX_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SANDBOX_EXEC_TIMEOUT_MS = 10 * 60_000;
/** Cloudflare stops a container nothing has talked to for this long: what a failing park would leave billing. */
const INACTIVITY_BACKSTOP_MS = 2 * 60 * 60_000;
/** 1/2 vCPU, 4 GiB. `lite` (1/16 vCPU) takes a minute to parse apt's index. */
const SANDBOX_INSTANCE = "standard-1";
/** Well under the shortest idle period a sandbox may be given (one second, contract.ts). */
const STAMP_EVERY_MS = 500;

/** The hash in the name gives a disk that holds an older tool this one. */
const toolHash = [...filesTool].reduce(
  (hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0,
  2166136261,
);
const TOOL_PATH = `/usr/local/lib/iterate/fs-${toolHash.toString(16)}.ts`;
const TOOL = ["node", "--no-warnings", TOOL_PATH];

/** A native object's prototype chain would otherwise reach `Function`. */
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

/** Where a sandbox keeps its secret list, for every later start (an idle sandbox restarts). */
const EGRESS_SECRETS = "egressSecrets";

/** NEVER `enableInternet`: a sandbox's only way out is the mind's egress. */
export type SandboxStartOptions = {
  image?: string;
  containerSnapshot?: { id: string };
  entrypoint?: string[];
  env?: Record<string, string>;
  instance?: ContainerStartupOptions["instance"];
  labels?: Record<string, string>;
  /** The secrets the sandbox's requests may name (secret-list.ts), kept until a start names others. */
  secrets?: string[];
};

/** `timeoutMs` stands for the `signal` that cannot cross an RPC. */
type SandboxExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  stdin?: Uint8Array;
  timeoutMs?: number;
};
type SandboxExecResult = { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };

type Steps = (string | [string, ...unknown[]])[];

const ExecStepOptions = z.looseObject({
  stdin: z.unknown().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const StartStepOptions = z.looseObject({});
const FsError = z.object({ code: z.string(), message: z.string() });

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

/** The container carries stdout and stderr over one connection, so a stdout read to its end while
 *  stderr is not read may never end. */
type Tool = { process: ExecProcess; stderr: Promise<string> };

const drained = (process: ExecProcess): Tool => ({
  process: watched(process),
  stderr: new Response(process.stderr!).text(),
});

async function ended({ process, stderr }: Tool): Promise<Error | undefined> {
  const [text, exitCode] = await Promise.all([stderr, process.exitCode]);
  return exitCode === 0 ? undefined : fileError(text, exitCode);
}

/** By a loop: `pipeTo` into a container's stdin loses the connection after the last byte. */
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

/** Cloudflare raises an error inside the object when a signal reaches an exited process. */
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

/** A command's output is held in memory shared with every other object in the isolate. */
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
  /** Kept here as well as on the facet, so a facet replaced mid-call does not make a call idle. */
  #calls = new Map<number, number>();
  #nextCall = 0;
  #stampedAt = 0;
  /** Unset whenever a container starts or stops (a new disk). */
  #toolReady = false;

  /** A restarted object has no inactivity timeout, and Cloudflare then stops its container shortly
   *  after: so a restart that finds it running sets the timeout again first. */
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running)
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS));
    void ctx.blockConcurrencyWhile(async () => {
      this.#defaults = (await ctx.storage.get<Record<string, string>>("env")) || {};
    });
  }

  /** A command's own env wins. */
  #defaults: Record<string, string> = {};
  async defaults(env: Record<string, string>): Promise<void> {
    this.#defaults = env;
    await this.ctx.storage.put("env", env);
  }
  #envOf(given?: Record<string, string>): Record<string, string> {
    return { ...TRUST_INTERCEPT_CA, ...this.#defaults, ...given };
  }

  get #container(): Container {
    if (!this.ctx.container) throw new Error("SandboxContainer: this class has no container");
    return this.ctx.container;
  }

  /** In storage: this object is evicted while the container goes on, and a fresh object's clock
   *  must not read as a fresh use. */
  async #touch(): Promise<void> {
    this.#stampedAt = Date.now();
    await this.ctx.storage.put("usedAt", this.#stampedAt);
  }

  async #touchSometimes(): Promise<void> {
    if (Date.now() - this.#stampedAt > STAMP_EVERY_MS) await this.#touch();
  }

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

  /** A checkpoint is no use: only a start, a command and a file are. */
  async usedAt(): Promise<number | null> {
    if (!this.#container.running) return null;
    const since = Date.now() - SANDBOX_MAX_BUSY_MS;
    if ([...this.#calls.values()].some((began) => began > since)) return Date.now();
    return (await this.ctx.storage.get<number>("usedAt")) ?? 0;
  }

  #imageNamed(name: string): string {
    return name === SANDBOX_IMAGE
      ? this.#container.images[SANDBOX_IMAGE] || SANDBOX_BASE_IMAGE
      : name;
  }

  /** A snapshot that Cloudflare will not restore fails the start: falling back to the image would
   *  lose the disk without a word. */
  async begin(options: SandboxStartOptions = {}): Promise<boolean> {
    await this.#touch();
    const container = this.#container;
    if (container.running) {
      await container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS);
      return false;
    }
    this.#toolReady = false;
    const began = Date.now();
    const { image, containerSnapshot, secrets, ...rest } = options;
    if (secrets) await this.ctx.storage.put(EGRESS_SECRETS, secrets);
    // the egress is registered first: a name looked up before it is would time out
    await this.#intercept();
    container.start({
      entrypoint: SANDBOX_ENTRYPOINT,
      ...rest,
      // after `rest`: an `instance` key present and undefined would take Cloudflare's `lite`
      instance: rest.instance || SANDBOX_INSTANCE,
      env: { ...TRUST_INTERCEPT_CA, ...rest.env },
      enableInternet: false,
      ...(containerSnapshot
        ? { containerSnapshot }
        : { image: this.#imageNamed(image || SANDBOX_IMAGE) }),
    });
    try {
      await container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS);
      await this.#untilAnswering();
    } catch (error) {
      const why = await this.#whyStopped();
      await container.destroy("start failed").catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} (${Date.now() - began} ms after the start began; the container: ${why})`,
        { cause: error },
      );
    }
    return true;
  }

  /** A start's failure is otherwise only "the container has not been started". */
  async #whyStopped(): Promise<string> {
    const answer = await Promise.race([
      this.#container.monitor().then(
        () => "exited",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("no word in 3 s"), 3_000)),
    ]);
    return answer;
  }

  /** With the internet off, nothing else resolves or connects. */
  async #intercept(): Promise<void> {
    if (!this.ctx.id.name) throw new Error("SandboxContainer: its name is the sandbox's context");
    const { SandboxEgress } = this.ctx.exports as unknown as {
      SandboxEgress: (options: {
        props: { iterateContextName: string; secrets?: string[] };
      }) => Fetcher;
    };
    const secrets = await this.ctx.storage.get<string[]>(EGRESS_SECRETS);
    const egress = SandboxEgress({
      props: { iterateContextName: this.ctx.id.name, secrets },
    });
    await this.#container.interceptAllOutboundHttp(egress);
    await this.#container.interceptOutboundHttps("*", egress);
  }

  /** `start` returns before the container can run a command. */
  async #untilAnswering(): Promise<void> {
    const container = this.#container;
    const deadline = Date.now() + 90_000;
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
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  invoke(steps: Steps): Promise<unknown> | Fetcher {
    const [first] = steps;
    const name = typeof first === "string" ? first : first?.[0];
    // a Fetcher is no value to return from a promise (its `then` is a call)
    if (steps.length === 1 && name === "getTcpPort" && Array.isArray(first))
      return this.#container.getTcpPort(Number(first[1]));
    // a pending `monitor` is a wait, not a use: it must not hold off a park
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
        (value instanceof Object &&
          [Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)) &&
          Object.hasOwn(value, member));
      if (!reachable) throw new Error(`${member} is not part of the container API`);
      const fixed = this.#fixed(index === 0, member, rawArgs);
      source ||= fixed.source;
      if (index === 0 && (member === "start" || member === "destroy")) this.#toolReady = false;
      if (index === 0 && member === "start") await this.#intercept();
      const target = value as Record<string, unknown>;
      const next =
        typeof step === "string"
          ? target[member]
          : (target[member] as (...args: unknown[]) => unknown)(...fixed.args);
      value = next instanceof Promise ? await next : next;
      if (source && !pump) pump = feed(value as ExecProcess, source);
    }
    if (pump) this.ctx.waitUntil(pump);
    return this.#plain(value);
  }

  /** Handed over as it is, an RPC stream on stdin never ends. A raw `start` keeps the internet off. */
  #fixed(
    first: boolean,
    member: string,
    args: unknown[],
  ): { args: unknown[]; source?: ReadableStream<Uint8Array> } {
    if (first && member === "exec") {
      const { stdin, ...options } = ExecStepOptions.parse(args[1] ?? {});
      const given = { ...options, env: this.#envOf(options.env) };
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

  /** A stream stamps the clock as it is read: a `tail -f` being read is use; one nobody reads is not. */
  #plain(value: unknown): unknown {
    const named = (type: string) => value instanceof Object && value.constructor?.name === type;
    if (named("ExecProcess"))
      throw new Error("exec(…) answers a process: chain .output(), .stdout, .stderr or .exitCode");
    if (named("ExecOutput")) {
      // checked by name: the runtime does not export the class
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

  exec(command: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    return this.#use(async () => {
      // not `AbortSignal.timeout`: it can fire after the process has exited, which Cloudflare
      // raises as an error inside this object
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? SANDBOX_EXEC_TIMEOUT_MS);
      const process = watched(
        await this.#container.exec(command, {
          cwd: options.cwd,
          env: this.#envOf(options.env),
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

  async #fsRun(args: string[]): Promise<string> {
    const tool = await this.#fs(args);
    const [stdout, failure] = await Promise.all([
      new Response(tool.process.stdout!).text(),
      ended(tool),
    ]);
    if (failure) throw failure;
    return stdout;
  }

  /** A missing file fails the call, not the stream. Each chunk read stamps the clock, so a stream a
   *  client abandons stops being use. */
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

  filesRun(args: string[]): Promise<string> {
    return this.#use(() => this.#fsRun(args));
  }

  snapshotContainer(options: ContainerSnapshotOptions = {}): Promise<ContainerSnapshot> {
    return this.#container.snapshotContainer(options);
  }

  async destroy(reason?: string): Promise<void> {
    this.#toolReady = false;
    if (this.#container.running) await this.#container.destroy(reason);
  }

  async erase(): Promise<void> {
    await this.destroy("sandbox deleted");
    await this.ctx.storage.deleteAll();
  }
}
