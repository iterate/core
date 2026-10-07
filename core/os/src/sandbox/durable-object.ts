// src/sandbox/durable-object.ts — THE SANDBOX'S FACET: turns a verb into the facts of contract.ts and
// drives the container (container.ts). What each verb does is documented as `SandboxHandle` in
// core/lib api.ts. Every verb refuses until the sandbox is created and once its deletion is asked.
import { z } from "zod";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import { DurableObjectNameCodec } from "../context/paths.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { assertCreated } from "../project/entity-lifecycle.ts";
import type { SandboxContainer, SandboxStartOptions } from "./container.ts";
import {
  SANDBOX_IMAGE,
  SANDBOX_MAX_BUSY_MS,
  SandboxConfigured,
  SandboxInstance,
  SandboxContract,
  SandboxSnapshot,
  type SandboxState,
} from "./contract.ts";
import { SandboxFiles } from "./files.ts";
import { outputForLog } from "./exec-record.ts";
import { SandboxProcessor } from "./processor.ts";

/** How often the project's connections are read again for a sandbox's environment. */
const PLANT_EVERY_MS = 60_000;
/** The most of a command line the log keeps. */
const COMMAND_LOG_CHARS = 500;

/** The sandbox's own verbs: its public methods beyond the processor's reads, and the handle type
 *  `itx.sandboxes.get(path)` answers (library.ts). `replay` is `container`'s: library.ts calls it. */
export const sandboxVerbs = ["start", "exec", "configure", "files", "replay"] as const;

const StartOptions = z
  .object({
    image: z.string().min(1).optional(),
    containerSnapshot: z.object({ id: z.string().min(1) }).optional(),
    entrypoint: z.array(z.string()).min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    instance: SandboxInstance.optional(),
    labels: z.record(z.string(), z.string()).optional(),
    /** The path of another sandbox of this project whose snapshot this one starts from. */
    from: z.string().min(1).optional(),
    // strict: `enableInternet` is refused, not ignored: a sandbox's only way out is the project's egress
  })
  .strict();
/** `start` of the container API itself: Cloudflare's options, which have no `from`. */
const ContainerStartOptions = StartOptions.omit({ from: true });
/** What `exec` takes beside the command (`ctx.container.exec`'s options an RPC carries). */
const ExecOptions = z.object({
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  user: z.string().min(1).optional(),
  stdin: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
const Command = z.array(z.string()).min(1);
const Steps = z.array(z.union([z.string(), z.tuple([z.string()]).rest(z.unknown())]));

const textEncoder = new TextEncoder();

/** A snapshot id restores in any object of the container class, so one of another sandbox (another
 *  project's) would copy its disk here: only the snapshot this sandbox's log recorded is restorable. */
function assertOwnSnapshot(path: string, state: SandboxState, snapshot?: { id: string }): void {
  if (snapshot && snapshot.id !== state.snapshot?.id)
    throw new Error(
      `sandbox ${path}: it restores only a snapshot of its own, the one its log records`,
    );
}

export class SandboxFacet extends StreamProcessorDurableObject<
  SandboxState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  /** The processor's reads, and the sandbox's own verbs — what `itx.sandboxes.get(path)` reaches
   *  (library.ts). */
  static override publicMethods = [...super.publicMethods, ...sandboxVerbs];

  /** The entity lifecycle, and the check saga (processor.ts). Nothing to provision: the container
   *  starts on first use. Deletion stops it and drops its clock. */
  processor = new SandboxProcessor(
    SandboxContract,
    () => this.getItx(),
    () => this.#path,
    { teardown: () => this.#container.erase() },
    {
      usedAt: async () => (this.#busy() ? Date.now() : this.#container.usedAt()),
      park: () => this.#park(),
      // a file written while the disk is saved can be saved half written: not while a verb runs
      checkpoint: async () => {
        if (!this.#busy()) await this.#checkpoint();
      },
    },
  );

  /** The sandbox's path: the context's name in this facet's props, so no call reads it. */
  get #path(): string {
    return DurableObjectNameCodec.parse(this.ctx.props.iterateContextName).path;
  }

  /** The container: one object per context, so one per sandbox and never shared between projects.
   *  Minted from `ctx.exports`, not a binding: a container class cannot be bound with the
   *  `script_name` the config always writes for a Durable Object binding (even to its own Worker),
   *  and deploy refuses it. */
  get #container() {
    // the generated `Env` types do not name container classes
    const { SandboxContainer } = this.ctx.exports as unknown as {
      SandboxContainer: DurableObjectNamespace<SandboxContainer>;
    };
    return SandboxContainer.getByName(this.ctx.props.iterateContextName);
  }

  // ── the one container, shared by every verb ──

  /** Verbs running now, by when each began. A park refuses while one runs, but one that has run for
   *  SANDBOX_MAX_BUSY_MS and not ended is no longer a reason to keep a container billing. */
  #calls = new Map<number, number>();
  #nextCall = 0;
  #enter(): () => void {
    const call = this.#nextCall++;
    this.#calls.set(call, Date.now());
    return () => void this.#calls.delete(call);
  }
  #busy(): boolean {
    const since = Date.now() - SANDBOX_MAX_BUSY_MS;
    return [...this.#calls.values()].some((began) => began > since);
  }
  /** The stop in progress (a park, or a requested `destroy`): a verb that arrives waits for it, then
   *  starts the container again from the disk the log recorded. */
  #stopping?: Promise<unknown>;
  /** The start in progress, so verbs that arrive together start the container once. */
  #starting?: Promise<void>;

  /** Run `work` on a running container, starting it first (from the log's latest snapshot) when
   *  none runs. */
  async #use<T>(work: (container: DurableObjectStub<SandboxContainer>) => Promise<T>): Promise<T> {
    while (this.#stopping) await this.#stopping;
    // no await between the loop and the count: a stop cannot begin in between
    const leave = this.#enter();
    try {
      await this.#up({});
      await this.#plant();
      return await work(this.#container);
    } finally {
      leave();
    }
  }

  /** What the project's GitHub connection makes of a command's environment: `gh` reads `GH_TOKEN`,
   *  and git asks for a password through a credential helper that answers with it, so cloning,
   *  pushing and opening pull requests with `gh` work with nothing set up. A command sees only the
   *  placeholder: the platform's egress puts the token into the request, for github.com alone (the
   *  secret is pinned to it). A project without a connection gets nothing planted. */
  async #githubEnv(): Promise<Record<string, string>> {
    using itx = this.getItx();
    // `secrets.list` answers each secret's path, pins and refresh kind, never its value
    // the itx surface types a secret's listing loosely; these are the fields read here, and a secret without them is skipped
    const secrets = (await itx.secrets.list()) as {
      path: string;
      urls: string[];
      refresh?: string;
    }[];
    const github = secrets.filter((secret) => secret.urls.includes("https://github.com"));
    const secret =
      github.find((candidate) => candidate.refresh === "github-app-installation") || github[0];
    if (!secret) return {};
    // an App installation's secret holds the minted token as a field of its material
    const field = secret.refresh === "github-app-installation" ? ', { field: "accessToken" }' : "";
    return {
      GH_TOKEN: `getSecret("${secret.path}"${field})`,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0:
        '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f',
    };
  }

  /** Give the container the environment its project's connections make (at most once a minute: a
   *  connection made meanwhile reaches a running sandbox within it). A failure to read them is
   *  logged and the command runs without. */
  #plantedAt = 0;
  async #plant(): Promise<void> {
    if (Date.now() - this.#plantedAt < PLANT_EVERY_MS) return;
    this.#plantedAt = Date.now();
    try {
      await this.#container.defaults(await this.#githubEnv());
    } catch (error) {
      console.warn({
        event: "sandbox.environment-unavailable",
        path: this.#path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Start the container, once for every caller that asks while it starts. A caller waits at most 50
   *  seconds: the platform ends a call at a minute without an answer, and a start that pulls a new
   *  image onto a host can take longer. A start still going then ends the call with a retryable
   *  error, and goes on: the next call finds the container up. */
  async #up(options: z.input<typeof StartOptions>): Promise<void> {
    this.#starting ??= this.#start(options).finally(() => (this.#starting = undefined));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((resolve) => {
      timer = setTimeout(() => resolve("slow"), 50_000);
    });
    try {
      if ((await Promise.race([this.#starting.then(() => "up" as const), slow])) === "slow")
        throw new Error(
          `sandbox ${this.#path} is still starting (the first start of an image on a host pulls it): the start goes on, so try again`,
        );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Start the container from what `options` name, else from the disk the log recorded, else from
   *  the managed image; and record where it came from. Running already: nothing to record. A
   *  recorded disk Cloudflare will not restore fails the start, naming the way out. */
  async #start(options: z.input<typeof StartOptions>): Promise<void> {
    const state = await this.#state();
    assertCreated("sandbox", this.#path, state);
    const { image, containerSnapshot, from, ...rest } = StartOptions.parse(options);
    assertOwnSnapshot(this.#path, state, containerSnapshot);
    if ([image, containerSnapshot, from].filter(Boolean).length > 1)
      throw new Error(`sandbox ${this.#path}: start takes one of image, containerSnapshot or from`);
    const source = from ? await this.#snapshotOf(from) : undefined;
    // `image` and `from` are requests to leave the recorded disk behind
    const snapshotId = image
      ? undefined
      : source?.id || containerSnapshot?.id || state.snapshot?.id;
    const instance = rest.instance || source?.instance || state.instance || undefined;
    const startOptions: SandboxStartOptions = {
      ...rest,
      // the size this start names, else the one the disk came from (a disk does not run on a smaller
      // size than it was saved on), else this sandbox's own
      instance,
      ...(snapshotId
        ? { containerSnapshot: { id: snapshotId } }
        : { image: image || SANDBOX_IMAGE }),
    };
    let started: boolean;
    try {
      started = await this.#container.begin(startOptions);
    } catch (error) {
      if (!snapshotId) throw error;
      throw new Error(
        `sandbox ${this.#path}: cannot restore snapshot ${snapshotId} (${error instanceof Error ? error.message : String(error)}). A snapshot works only for the image it was taken from, for 30 days after its last restore. start({ image: "${SANDBOX_IMAGE}" }) starts from the image and discards it.`,
      );
    }
    if (!started) return;
    // a fresh container reads the project's connections again before its first command
    this.#plantedAt = 0;
    await this.#append("started", {
      from: snapshotId ? "snapshot" : "image",
      snapshotId,
      fromSandbox: from,
      snapshotSize: source?.size,
      discardedSnapshotId: image || from ? state.snapshot?.id : undefined,
      instance: startOptions.instance,
    });
  }

  /** The snapshot of another sandbox of this project, which `start({ from })` restores. It is read
   *  through this sandbox's own itx, so a path in another project is never reachable (a snapshot id
   *  restores in any object of the container class: ids are never taken from a caller). */
  async #snapshotOf(path: string): Promise<SandboxSnapshot & { instance?: SandboxInstance }> {
    if (path === this.#path)
      throw new Error(`sandbox ${path}: start({ from }) names another sandbox`);
    using itx = this.getItx();
    // two reads of plain values: an object answered over RPC is a stub that cannot outlive this scope
    const sibling = itx.sandboxes.get(path);
    const none = (cause?: unknown) =>
      new Error(
        `sandbox ${path} has no snapshot to start from: it does not exist, or has not saved its disk yet (a stop saves it, or snapshotContainer)`,
        { cause },
      );
    // a sandbox with no snapshot has nothing to walk into: that is this answer, and nothing else
    // `invoke` answers `unknown`: the path walks to the snapshot's `id` (a string) or null when none is saved
    const id = await (
      sibling.invoke([["snapshot"], "state", "snapshot", "id"]) as Promise<string | null>
    ).catch((error: unknown) => {
      throw none(error);
    });
    if (!id) throw none();
    // the same path, ending at `size`: a number whenever an id exists
    const size = (await sibling.invoke([["snapshot"], "state", "snapshot", "size"])) as number;
    // the size the sibling last ran on: its disk comes back on that one
    const instance = SandboxInstance.optional().parse(
      (await sibling.invoke([["snapshot"], "state", "instance"])) ?? undefined,
    );
    return { id, size, instance };
  }

  /** Where the sandbox stands, read through the head of the log: a snapshot a park recorded a
   *  moment ago must be the one the next start restores. */
  async #state(): Promise<SandboxState> {
    await this.catchUpFromLog();
    return (await this.snapshot()).state;
  }

  async #append(fact: string, payload: Record<string, unknown>): Promise<number> {
    using itx = this.getItx();
    // the RPC type of an append's answer is `never` (its events hold `unknown`); each one has its `offset`
    const [event] = (await itx.append({
      type: `events.iterate.com/sandbox/${fact}`,
      payload,
    })) as { offset: number }[];
    return event!.offset;
  }

  /** Save the disk and record it; the container goes on. */
  async #checkpoint(): Promise<SandboxSnapshot> {
    const snapshot = SandboxSnapshot.parse(await this.#container.snapshotContainer());
    await this.#append("snapshotted", snapshot);
    return snapshot;
  }

  /** An idle stop: the disk saved, the container stopped, both on the log. It yields to a verb
   *  running, and answers whether it stopped. A container found gone is recorded as stopped for a
   *  reason no verb saw. Verbs that arrive meanwhile wait for it (`#stopping`). */
  async #park(): Promise<boolean> {
    while (this.#stopping) await this.#stopping;
    if (this.#busy()) return false;
    await this.#exclusively(async () => {
      // a requested stop that got here first has recorded its own `stopped`: nothing is left to say,
      // and a stopped container the log still calls running is the only one that "stopped unknown"
      if (!(await this.#state()).running) return;
      const running = (await this.#container.usedAt()) !== null;
      if (running) {
        await this.#checkpoint();
        await this.#container.destroy("idle");
      }
      await this.#append("stopped", { reason: running ? "idle" : "unknown" });
    });
    return true;
  }

  /** Run `stop` as THE stop: a verb that arrives meanwhile waits for it, then starts the container
   *  again from the disk the log recorded, so `started` never lands before the `stopped` of a stop
   *  still under way. */
  async #exclusively<T>(stop: () => Promise<T>): Promise<T> {
    const stopping = stop();
    const done = () => (this.#stopping = undefined);
    this.#stopping = stopping.then(done, done);
    return stopping;
  }

  // ── the verbs ──

  /** `ctx.container.start(options)`, with the sandbox's disk: make the container run, from the disk
   *  the log recorded unless `options.image` asks for a fresh one (which leaves that disk behind).
   *  Running already: nothing happens. Every other verb that needs a container does this itself. */
  async start(options?: z.input<typeof StartOptions>): Promise<void> {
    while (this.#stopping) await this.#stopping;
    await this.#up(options || {});
  }

  /** `ctx.container.exec(command, options)` and `process.output()`: run an argv (a shell is
   *  `["bash", "-c", "…"]`) and wait for it. A nonzero exit is an answer, not a failure. */
  async exec(
    command: string[],
    options?: z.input<typeof ExecOptions>,
  ): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
    const argv = Command.parse(command);
    const { stdin, ...rest } = ExecOptions.parse(options || {});
    const logged = argv.join(" ").slice(0, COMMAND_LOG_CHARS);
    const startedOffset = await this.#append("exec-started", {
      command: logged,
      cwd: rest.cwd,
      timeoutMs: rest.timeoutMs,
    });
    const startedAt = Date.now();
    let result: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };
    try {
      result = await this.#use((container) =>
        container.exec(argv, {
          ...rest,
          stdin: stdin
            ? typeof stdin === "string"
              ? textEncoder.encode(stdin)
              : stdin
            : undefined,
        }),
      );
    } catch (error) {
      // no exit came: the call settles all the same, so a started command is never left open
      await this.#append("exec-finished", {
        startedOffset,
        command: logged,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      });
      throw error;
    }
    const stdout = outputForLog(result.stdout);
    const stderr = outputForLog(result.stderr);
    await this.#append("exec-finished", {
      startedOffset,
      command: logged,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdoutBytes: result.stdout.byteLength,
      stderrBytes: result.stderr.byteLength,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.omitted + stderr.omitted > 0,
    });
    return result;
  }

  /** `handle.files`: the Sandbox SDK's `Files` over this container (files.ts). A getter, so
   *  `files.read(path)` is a call on it, not a method of the facet. */
  get files(): SandboxFiles {
    return new SandboxFiles((work) => this.#use(work));
  }

  /** `handle.container.<steps>`: the container API replayed on the container (container.ts
   *  `invoke`). What it did to the disk or the run is recorded, whoever asked: a `start` (where the
   *  disk came from), a `snapshotContainer` (the disk, which the next start restores), a `destroy`
   *  (the stop). The raw verbs are Cloudflare's: a `start` restores nothing by itself (`start({
   *  containerSnapshot })` does), and a `destroy` saves nothing. */
  async replay(steps: z.input<typeof Steps>): Promise<unknown> {
    const parsed = Steps.parse(steps);
    const state = await this.#state();
    assertCreated("sandbox", this.#path, state);
    const [first] = parsed;
    const verb = typeof first === "string" ? first : first?.[0];
    if (verb === "start" && Array.isArray(first))
      assertOwnSnapshot(
        this.#path,
        state,
        ContainerStartOptions.parse(first[1] ?? {}).containerSnapshot,
      );
    // `invoke` answers a `Fetcher` for `getTcpPort`, which the stub's type (a promise) cannot say
    const stub = this.#container as unknown as { invoke(steps: unknown): Promise<unknown> };
    // a raw `start` that names no size starts on the one this sandbox last asked for
    const toInvoke =
      verb === "start" &&
      Array.isArray(first) &&
      state.instance &&
      !ContainerStartOptions.parse(first[1] ?? {}).instance
        ? // the `ContainerStartOptions.parse` in the condition proved `first[1]` is an options object or absent
          [["start", { ...(first[1] as object), instance: state.instance }], ...parsed.slice(1)]
        : parsed;
    // a `monitor` is a wait: not a use, and a stop does not hold it off
    if (verb === "monitor") return stub.invoke(parsed);
    while (this.#stopping) await this.#stopping;
    // a requested stop is a stop like a park's: nothing starts the container between its `destroy`
    // and its `stopped`
    if (verb === "destroy" && parsed.length === 1)
      return this.#exclusively(async () => {
        const answer = await stub.invoke(parsed);
        await this.#append("stopped", { reason: "requested" });
        return answer;
      });
    const leave = this.#enter();
    try {
      await this.#plant();
      const answer = await stub.invoke(toInvoke);
      if (Array.isArray(first)) {
        if (verb === "start") {
          const { image, containerSnapshot, instance } = ContainerStartOptions.parse(
            first[1] ?? {},
          );
          await this.#append("started", {
            from: containerSnapshot ? "snapshot" : "image",
            snapshotId: containerSnapshot?.id,
            discardedSnapshotId: image ? state.snapshot?.id : undefined,
            instance,
          });
        }
        if (verb === "snapshotContainer")
          await this.#append("snapshotted", SandboxSnapshot.parse(answer));
      }
      return answer;
    } finally {
      leave();
    }
  }

  /** Set a knob: how long the sandbox may sit unused (1 second to 1 hour) before its disk is saved
   *  and its container stopped. Answers the sandbox's settings. */
  async configure(settings: z.input<typeof SandboxConfigured>): Promise<{ idleAfterMs: number }> {
    assertCreated("sandbox", this.#path, await this.#state());
    await this.#append("configured", SandboxConfigured.parse(settings));
    return { idleAfterMs: (await this.#state()).idleAfterMs };
  }
}
