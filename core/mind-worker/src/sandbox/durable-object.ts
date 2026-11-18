import { z } from "zod";
import { codedError, errorCode } from "iterate/lib";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { IterateContextApi } from "iterate/api";
import { DurableObjectNameCodec, type ItxEntrypointScope } from "core-itx";
import { assertCreated } from "../mind/entity-lifecycle.ts";
import type { SandboxContainer, SandboxPortOpening, SandboxStartOptions } from "./container.ts";
import {
  CLOUDFLARE_MANAGED_IMAGE,
  SANDBOX_MAX_BUSY_MS,
  SandboxConfigured,
  SandboxInstance,
  SandboxContract,
  SandboxPortExposed,
  SandboxSnapshot,
  type SandboxStarted,
  type SandboxState,
} from "./contract.ts";
import { portRoutesOf, type SandboxPortReadiness } from "./ports.ts";
import { SandboxFiles } from "./files.ts";
import { outputForLog } from "./exec-record.ts";
import { SandboxProcessor } from "./processor.ts";

/** `replay` is `container`'s, and `readyPort` a port request's: library.ts calls them. */
export const sandboxVerbs = ["start", "exec", "configure", "files", "replay", "readyPort"] as const;

/** One bound for a request that finds its port not ready: the start, the command and the port's
 *  opening. Under the 60 s after which a context restarts a facet whose call has not answered. */
const PORT_READY_WITHIN_MS = 45_000;
/** How long a port may take to open after its command ran. */
const PORT_OPENS_WITHIN_MS = 30_000;
/** The start failed, or the container's object did not answer: no port was tried. */
type SandboxNotStarted = { open: false; notStarted: true; error: string };

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

/** What a start runs. An image it names wins, and leaves the snapshot behind. Else a snapshot:
 *  another sandbox's (`from`), the one it names, or its own last saved one. Else the image that
 *  `events.iterate.com/mind/sandbox-image-configured` on `/` names, read only then. Else no image
 *  is named, and the container starts the stack's default (container.ts `#imageOf`). */
export async function imageOrSnapshot(
  named: { image?: string; snapshotId?: string },
  mindImage: () => Promise<string | null>,
): Promise<{ image?: string; containerSnapshot?: never } | { containerSnapshot: { id: string } }> {
  if (named.image) return { image: named.image };
  if (named.snapshotId) return { containerSnapshot: { id: named.snapshotId } };
  return { image: (await mindImage()) || undefined };
}

/** Why a start cannot take what it names, or undefined when it can. A start that names `image`,
 *  `containerSnapshot` or `from` says what the sandbox is to run on. A sandbox that runs already,
 *  or that another call is starting, keeps what it runs on, so that word would be dropped: the
 *  start fails and says so. Three starts are never refused. One that names none of the three only
 *  makes the sandbox run. One asked again in the same words, while it goes on, waits for it. And
 *  one that names what the running sandbox started on has nothing left to do: a caller whose start
 *  was still going on after 50 seconds is told to try again, and that try finds the sandbox up.
 *  `image` is the image `options.image` names, as Cloudflare takes it. */
export function startRefusal(
  path: string,
  options: z.infer<typeof StartOptions>,
  sandbox:
    | { running: true; started?: SandboxStarted | null; image?: string }
    | { starting: z.infer<typeof StartOptions> },
): string | undefined {
  const names = (["image", "containerSnapshot", "from"] as const).find((key) => options[key]);
  if (!names) return undefined;
  if ("running" in sandbox) {
    const { started, image } = sandbox;
    const same =
      !!started &&
      (options.from
        ? started.fromSandbox === options.from
        : options.containerSnapshot
          ? started.from === "snapshot" &&
            !started.fromSandbox &&
            started.snapshotId === options.containerSnapshot.id
          : started.from === "image" && !!image && started.image === image);
    if (same) return undefined;
    return `sandbox ${path} runs already, and not on what start({ ${names} }) names: the start would not change what it runs on. Stop it first with container.destroy() (container.snapshotContainer() before that keeps its disk), then start it.`;
  }
  if (JSON.stringify(sandbox.starting) === JSON.stringify(options)) return undefined;
  return `sandbox ${path} is being started by another call: start({ ${names} }) would not change what that start runs. Wait for it with start(), stop the sandbox with container.destroy(), then start it.`;
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
    {
      // the hosts first: once the container is gone, a host that stayed would serve nothing
      teardown: async () => {
        await this.#removePortRoutes();
        await this.#container.erase();
      },
    },
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
  #starting?: { options: z.infer<typeof StartOptions>; done: Promise<void> };

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
  async #up(given: z.input<typeof StartOptions>): Promise<void> {
    const options = StartOptions.parse(given);
    if (this.#starting) {
      const refusal = startRefusal(this.#path, options, { starting: this.#starting.options });
      if (refusal) throw codedError("INVALID_INPUT", refusal);
    }
    this.#starting ??= {
      options,
      done: this.#start(options).finally(() => (this.#starting = undefined)),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((resolve) => {
      timer = setTimeout(() => resolve("slow"), 50_000);
    });
    try {
      if ((await Promise.race([this.#starting.done.then(() => "up" as const), slow])) === "slow")
        throw new Error(
          `sandbox ${this.#path} is still starting (the first start of an image on a host pulls it): the start goes on, so try again`,
        );
    } finally {
      clearTimeout(timer);
    }
  }

  async #start(options: z.infer<typeof StartOptions>): Promise<void> {
    const state = await this.#state();
    assertCreated("sandbox", this.#path, state);
    const { image, containerSnapshot, from, ...rest } = options;
    assertOwnSnapshot(this.#path, state, containerSnapshot);
    if ([image, containerSnapshot, from].filter(Boolean).length > 1)
      throw new Error(`sandbox ${this.#path}: start takes one of image, containerSnapshot or from`);
    const source = from ? await this.#snapshotOf(from) : undefined;
    const runs = await imageOrSnapshot(
      { image, snapshotId: source?.id || containerSnapshot?.id || state.snapshot?.id },
      () => this.#mindSandboxImage(),
    );
    const snapshotId = runs.containerSnapshot?.id;
    const instance = rest.instance || source?.instance || state.instance || undefined;
    const startOptions: SandboxStartOptions = {
      ...rest,
      // a disk does not run on a smaller size than it was saved on
      instance,
      ...runs,
    };
    let begun: Awaited<ReturnType<SandboxContainer["begin"]>>;
    try {
      begun = await this.#container.begin(startOptions);
    } catch (error) {
      // a stack with no container cannot restore any snapshot: the refusal says so as it is
      if (!snapshotId || errorCode(error) === "NO_SANDBOXES_YET") throw error;
      throw new Error(
        `sandbox ${this.#path}: cannot restore snapshot ${snapshotId} (${error instanceof Error ? error.message : String(error)}). A snapshot works only for the image it was taken from, for 30 days after its last restore. start({ image }) starts from an image and discards it: "${CLOUDFLARE_MANAGED_IMAGE}", or a named image of the stack.`,
      );
    }
    if (!begun) {
      // a state reduced before `started` was kept has no such key
      const refusal = startRefusal(this.#path, options, {
        running: true,
        started: state.started,
        image: image && state.started ? await this.#container.imageOf(image) : undefined,
      });
      if (refusal) throw codedError("INVALID_INPUT", refusal);
      return;
    }
    this.#plantedAt = 0;
    await this.#append("started", {
      from: snapshotId ? "snapshot" : "image",
      image: begun.image,
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

  /** The `mind` facet's own answer on `/`, which is null also for a root reduced before the field existed. */
  async #mindSandboxImage(): Promise<string | null> {
    using itx = this.getItx();
    const image = await itx
      .cd("/")
      .invoke(["itx", "builtins", "facets", ["get", "mind"], ["sandboxImage"]]);
    return z.string().min(1).nullish().parse(image) ?? null;
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
            image: containerSnapshot ? undefined : image,
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

  /** MAKES A PORT READY FOR ONE REQUEST, which the library then sends to the container's object by
   *  `fetch` (./ports.ts). No Request is in this call, so no socket has to cross an RPC. A stopped
   *  sandbox starts as for `exec`, and an exposed port that is closed gets its command run. The
   *  answer is the request's own: a sandbox that does not exist is 404, a port that stays closed is
   *  502, and a start that outlasts PORT_READY_WITHIN_MS is 503 while the start goes on. */
  async readyPort(port: number): Promise<SandboxPortReadiness> {
    const which = SandboxPortExposed.shape.port.parse(port);
    const state = await this.#state();
    if (state.deletion || state.creation?.status !== "created")
      return { ready: false, status: 404, reason: `no sandbox at ${this.#path}` };
    const command = state.ports[which]?.command;
    // settles by itself: a request that stops waiting does not stop the start
    const opening = this.#use(async (container): Promise<SandboxPortOpening> =>
      container.readyPort(which, command, PORT_OPENS_WITHIN_MS),
    )
      .catch((error: unknown): SandboxNotStarted => ({
        open: false,
        notStarted: true,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((answer) => this.#recordedPortOpening(which, answer));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<"slow">((resolve) => {
      timer = setTimeout(() => resolve("slow"), PORT_READY_WITHIN_MS);
    });
    try {
      const answer = await Promise.race([opening, slow]);
      if (answer === "slow")
        return {
          ready: false,
          status: 503,
          reason: `sandbox ${this.#path} is still starting: try again`,
        };
      if (answer.open) return { ready: true };
      return {
        ready: false,
        status: 502,
        // a failed start's own words can name a snapshot: they are in the sandbox's log alone
        reason:
          "notStarted" in answer
            ? `sandbox ${this.#path} could not make the port ready: its log says why`
            : `sandbox ${this.#path}: ${answer.error}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A command that was run for a port, and a start that failed, are facts of the sandbox. A fact
   *  that cannot be written does not fail the request that waits for the port. */
  async #recordedPortOpening(
    port: number,
    opening: SandboxPortOpening | SandboxNotStarted,
  ): Promise<SandboxPortOpening | SandboxNotStarted> {
    try {
      if (!opening.open && ("notStarted" in opening || opening.ran))
        await this.#append("port-start-failed", { port, error: opening.error });
      if (opening.open && opening.ran)
        await this.#append("port-started", { port, waitedMs: opening.waitedMs });
    } catch (error) {
      console.warn({
        event: "sandbox.port-fact-not-recorded",
        path: this.#path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return opening;
  }

  /** A deleted sandbox serves no host: each route of its ports goes, while it still names the port.
   *  The facet's own `itx` is the platform's, so the delete does not depend on who exposed. */
  async #removePortRoutes(): Promise<void> {
    const { ports } = await this.#state();
    if (Object.keys(ports).length === 0) return;
    using itx = this.getItx();
    const root = itx.cd("/");
    const routes = await root.invoke(["itx", "builtins", "fetchRoutes", ["list"]]);
    for (const fetchRouteName of portRoutesOf(routes, this.#path, ports))
      await root.invoke(["itx", "builtins", "fetchRoutes", ["set", fetchRouteName, null]]);
  }

  async configure(settings: z.input<typeof SandboxConfigured>): Promise<{ idleAfterMs: number }> {
    assertCreated("sandbox", this.#path, await this.#state());
    await this.#append("configured", SandboxConfigured.parse(settings));
    return { idleAfterMs: (await this.#state()).idleAfterMs };
  }
}
