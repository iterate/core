import { z } from "zod";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { IterateContextApi } from "iterate/api";
import { DurableObjectNameCodec, type ItxEntrypointScope } from "core-itx";
import { assertCreated } from "../mind/entity-lifecycle.ts";
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

/** `replay` is `container`'s: library.ts calls it. */
export const sandboxVerbs = ["start", "exec", "configure", "files", "replay"] as const;

const StartOptions = z
  .object({
    image: z.string().min(1).optional(),
    containerSnapshot: z.object({ id: z.string().min(1) }).optional(),
    entrypoint: z.array(z.string()).min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    instance: SandboxInstance.optional(),
    labels: z.record(z.string(), z.string()).optional(),
    from: z.string().min(1).optional(),
    // strict: `enableInternet` is refused, not ignored: a sandbox's only way out is the mind's egress
  })
  .strict();
const ContainerStartOptions = StartOptions.omit({ from: true });
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

/** A snapshot id restores in any object of the container class, so one of another mind's would
 *  copy its disk here. */
function assertOwnSnapshot(path: string, state: SandboxState, snapshot?: { id: string }): void {
  if (snapshot && snapshot.id !== state.snapshot?.id)
    throw new Error(
      `sandbox ${path}: it restores only a snapshot of its own, the one its log records`,
    );
}

/** The mind host's `itx.secrets` and the library's `itx.sandboxes`, which the kernel's type does not name. */
type SandboxScope = ItxEntrypointScope & Pick<IterateContextApi, "secrets" | "sandboxes">;

export class SandboxFacet extends StreamProcessorDurableObject<
  SandboxState,
  { ITX?: ItxEntrypointService },
  SandboxScope
> {
  static override publicMethods = [...super.publicMethods, ...sandboxVerbs];

  processor = new SandboxProcessor(
    SandboxContract,
    () => this.getItx(),
    () => this.#path,
    { teardown: () => this.#container.erase() },
    {
      usedAt: async () => (this.#busy() ? Date.now() : this.#container.usedAt()),
      park: () => this.#park(),
      // a file written while the disk is saved can be saved half written
      checkpoint: async () => {
        if (!this.#busy()) await this.#checkpoint();
      },
    },
  );

  get #path(): string {
    return DurableObjectNameCodec.parse(this.ctx.props.iterateContextName).path;
  }

  /** Minted from `ctx.exports`: a container class cannot be bound with the `script_name` a Durable
   *  Object binding always carries, and deploy refuses it. */
  get #container() {
    const { SandboxContainer } = this.ctx.exports as unknown as {
      SandboxContainer: DurableObjectNamespace<SandboxContainer>;
    };
    return SandboxContainer.getByName(this.ctx.props.iterateContextName);
  }

  /** A verb that has run for SANDBOX_MAX_BUSY_MS no longer keeps a billing container from a park. */
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
  #stopping?: Promise<unknown>;
  #starting?: Promise<void>;

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

  /** A command sees only the placeholder: the egress puts the token in, for github.com alone. */
  async #githubEnv(): Promise<Record<string, string>> {
    using itx = this.getItx();
    // `secrets.list` answers paths, pins and refresh kinds, never a value
    const secrets = (await itx.secrets.list()) as {
      path: string;
      urls: string[];
      refresh?: string;
    }[];
    const github = secrets.filter((secret) => secret.urls.includes("https://github.com"));
    const secret =
      github.find((candidate) => candidate.refresh === "github-app-installation") || github[0];
    if (!secret) return {};
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

  /** At most once a minute: a connection made meanwhile reaches a running sandbox within it. */
  #plantedAt = 0;
  async #plant(): Promise<void> {
    if (Date.now() - this.#plantedAt < 60_000) return;
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

  /** A caller waits at most 50 seconds: the platform ends a call at a minute without an answer, and
   *  pulling a new image onto a host can take longer. The start goes on. */
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

  async #start(options: z.input<typeof StartOptions>): Promise<void> {
    const state = await this.#state();
    assertCreated("sandbox", this.#path, state);
    const { image, containerSnapshot, from, ...rest } = StartOptions.parse(options);
    assertOwnSnapshot(this.#path, state, containerSnapshot);
    if ([image, containerSnapshot, from].filter(Boolean).length > 1)
      throw new Error(`sandbox ${this.#path}: start takes one of image, containerSnapshot or from`);
    const source = from ? await this.#snapshotOf(from) : undefined;
    const snapshotId = image
      ? undefined
      : source?.id || containerSnapshot?.id || state.snapshot?.id;
    const instance = rest.instance || source?.instance || state.instance || undefined;
    const startOptions: SandboxStartOptions = {
      ...rest,
      // a disk does not run on a smaller size than it was saved on
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

  /** Read through this sandbox's own itx, so a path in another mind is never reachable. */
  async #snapshotOf(path: string): Promise<SandboxSnapshot & { instance?: SandboxInstance }> {
    if (path === this.#path)
      throw new Error(`sandbox ${path}: start({ from }) names another sandbox`);
    using itx = this.getItx();
    // plain values: an object answered over RPC is a stub that cannot outlive this scope
    const sibling = itx.sandboxes.get(path);
    const none = (cause?: unknown) =>
      new Error(
        `sandbox ${path} has no snapshot to start from: it does not exist, or has not saved its disk yet (a stop saves it, or snapshotContainer)`,
        { cause },
      );
    const id = await (
      sibling.invoke([["snapshot"], "state", "snapshot", "id"]) as Promise<string | null>
    ).catch((error: unknown) => {
      throw none(error);
    });
    if (!id) throw none();
    const size = (await sibling.invoke([["snapshot"], "state", "snapshot", "size"])) as number;
    const instance = SandboxInstance.optional().parse(
      (await sibling.invoke([["snapshot"], "state", "instance"])) ?? undefined,
    );
    return { id, size, instance };
  }

  /** Through the head of the log: a snapshot a park recorded a moment ago is the one to restore. */
  async #state(): Promise<SandboxState> {
    await this.catchUpFromLog();
    return (await this.snapshot()).state;
  }

  async #append(fact: string, payload: Record<string, unknown>): Promise<number> {
    using itx = this.getItx();
    const [event] = (await itx.append({
      type: `events.iterate.com/sandbox/${fact}`,
      payload,
    })) as { offset: number }[];
    return event!.offset;
  }

  async #checkpoint(): Promise<SandboxSnapshot> {
    const snapshot = SandboxSnapshot.parse(await this.#container.snapshotContainer());
    await this.#append("snapshotted", snapshot);
    return snapshot;
  }

  async #park(): Promise<boolean> {
    while (this.#stopping) await this.#stopping;
    if (this.#busy()) return false;
    await this.#exclusively(async () => {
      // a requested stop that got here first recorded its own `stopped`
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

  /** A verb that arrives meanwhile waits, so `started` never lands before the `stopped`. */
  async #exclusively<T>(stop: () => Promise<T>): Promise<T> {
    const stopping = stop();
    const done = () => (this.#stopping = undefined);
    this.#stopping = stopping.then(done, done);
    return stopping;
  }

  async start(options?: z.input<typeof StartOptions>): Promise<void> {
    while (this.#stopping) await this.#stopping;
    await this.#up(options || {});
  }

  /** A nonzero exit is an answer, not a failure. */
  async exec(
    command: string[],
    options?: z.input<typeof ExecOptions>,
  ): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
    const argv = Command.parse(command);
    const { stdin, ...rest } = ExecOptions.parse(options || {});
    const logged = argv.join(" ").slice(0, 500);
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
      // a started command is never left open
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

  /** A getter, so `files.read(path)` is a call on it, not a method of the facet. */
  get files(): SandboxFiles {
    return new SandboxFiles((work) => this.#use(work));
  }

  /** What the raw container API did to the disk or the run is recorded, whoever asked. */
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
    // `invoke` answers a `Fetcher` for `getTcpPort`, which the stub's type cannot say
    const stub = this.#container as unknown as { invoke(steps: unknown): Promise<unknown> };
    const toInvoke =
      verb === "start" &&
      Array.isArray(first) &&
      state.instance &&
      !ContainerStartOptions.parse(first[1] ?? {}).instance
        ? [["start", { ...(first[1] as object), instance: state.instance }], ...parsed.slice(1)]
        : parsed;
    // a `monitor` is a wait: not a use, and a stop does not hold it off
    if (verb === "monitor") return stub.invoke(parsed);
    while (this.#stopping) await this.#stopping;
    // nothing starts the container between a requested `destroy` and its `stopped`
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

  async configure(settings: z.input<typeof SandboxConfigured>): Promise<{ idleAfterMs: number }> {
    assertCreated("sandbox", this.#path, await this.#state());
    await this.#append("configured", SandboxConfigured.parse(settings));
    return { idleAfterMs: (await this.#state()).idleAfterMs };
  }
}
