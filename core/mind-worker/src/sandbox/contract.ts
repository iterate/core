// The snapshot is the log's fact: the latest `snapshotted` is what the next `started` restores.
import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";
import { EntityCreationAndDeletionState, entityLifecycle } from "../mind/entity-lifecycle.ts";

/** Valid only for the image it was taken from, for 30 days after its last restore. */
export const SandboxSnapshot = z.object({
  id: z.string().min(1),
  size: z.number().int().nonnegative(),
  name: z.string().optional(),
});
export type SandboxSnapshot = z.infer<typeof SandboxSnapshot>;

export const SandboxInstance = z.union([
  z.enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"]),
  z.object({
    vcpu: z.number().positive(),
    memoryMib: z.number().positive(),
    diskMb: z.number().positive(),
  }),
]);
export type SandboxInstance = z.infer<typeof SandboxInstance>;

/** A snapshot Cloudflare will not restore fails the start: falling back to the image would lose the
 *  disk without a word. */
export const SandboxStarted = z.object({
  from: z.enum(["image", "snapshot"]),
  /** The image it started on, as Cloudflare took it. A start from a snapshot has none. */
  image: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
  fromSandbox: z.string().min(1).optional(),
  /** It becomes this sandbox's own disk until it saves another. */
  snapshotSize: z.number().int().nonnegative().optional(),
  discardedSnapshotId: z.string().min(1).optional(),
  instance: SandboxInstance.optional(),
});
export type SandboxStarted = z.infer<typeof SandboxStarted>;

/** `unknown`: no verb stopped it, so a disk since the last snapshot is lost. */
const SandboxStopped = z.object({ reason: z.enum(["requested", "idle", "unknown"]) });

/** The command may carry a secret, so a command takes its secrets from `env`, which is never logged. */
const SandboxExecStarted = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const SandboxExecFinished = z.object({
  startedOffset: z.number().int().nonnegative(),
  command: z.string(),
  exitCode: z.number().int().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

/** The Cloudflare-managed image: what a start runs on a stack with no named image. */
export const CLOUDFLARE_MANAGED_IMAGE = "cloudflare/debian-trixie";

const SANDBOX_DEFAULT_IDLE_AFTER_MS = 5 * 60_000;
export const SANDBOX_CHECKPOINT_AFTER_MS = 15 * 60_000;
/** The park, which saves the disk, must come before the container's two-hour backstop. */
const SANDBOX_MAX_IDLE_AFTER_MS = 60 * 60_000;
/** A call that never ends must not keep a billing container from being parked for good. */
export const SANDBOX_MAX_BUSY_MS = 60 * 60_000;

/** A port of the sandbox that a host of the mind serves (`exposePort`). The host's name and who may
 *  reach it are the fetch route's on `/`, which is what is served: this fact holds what the sandbox
 *  itself needs, the command and which route a delete removes. The command is kept here, in the
 *  log, so it never holds a secret. */
export const SandboxPortExposed = z.object({
  port: z.number().int().min(1).max(65535),
  name: z.string().min(1),
  command: z.array(z.string()).min(1).optional(),
});
export type SandboxPortExposed = z.infer<typeof SandboxPortExposed>;

export const SandboxPortUnexposed = z.object({ port: z.number().int().min(1).max(65535) });

export const SandboxConfigured = z.object({
  idleAfterMs: z.number().int().min(1_000).max(SANDBOX_MAX_IDLE_AFTER_MS).optional(),
});
export type SandboxConfigured = z.infer<typeof SandboxConfigured>;

export const SandboxState = EntityCreationAndDeletionState.extend({
  running: z.boolean().default(false),
  /** What the running container started on: its `started` event. Null while it does not run. */
  started: SandboxStarted.nullable().default(null),
  snapshot: SandboxSnapshot.nullable().default(null),
  savedAt: z.number().int().nullable().default(null),
  instance: SandboxInstance.nullable().default(null),
  idleAfterMs: z.number().int().positive().default(SANDBOX_DEFAULT_IDLE_AFTER_MS),
  /** By port number. */
  ports: z.record(z.string(), SandboxPortExposed.omit({ port: true })).default({}),
});
export type SandboxState = z.infer<typeof SandboxState>;

const lifecycle = entityLifecycle("sandbox");

export const SANDBOX_IDLE_CHECK = "events.iterate.com/sandbox/idle-check";

export const SandboxContract = defineProcessorContract({
  ...lifecycle,
  stateSchema: SandboxState,
  consumes: [
    ...lifecycle.consumes,
    "events.iterate.com/sandbox/started",
    "events.iterate.com/sandbox/snapshotted",
    "events.iterate.com/sandbox/stopped",
    "events.iterate.com/sandbox/configured",
    "events.iterate.com/sandbox/port-exposed",
    "events.iterate.com/sandbox/port-unexposed",
    SANDBOX_IDLE_CHECK,
    "events.iterate.com/itx/schedule-failed",
  ],
  version: "1",
  description:
    "A sandbox: its creation and deletion, each start of its container (from a snapshot, or from an image: the one the start names, else the one the mind names on `/`, else the stack's), each snapshot of its writable root filesystem, each stop, and each command that ran.",
  events: {
    ...lifecycle.events,
    "events.iterate.com/sandbox/started": {
      description:
        "The container came up, from an image (`image` names it) or from a snapshot: the sandbox's own latest, or another sandbox's (`fromSandbox`). A start from an image on request names the snapshot it left behind as discarded.",
      payloadSchema: SandboxStarted,
    },
    "events.iterate.com/sandbox/snapshotted": {
      description:
        "A snapshot of the container's writable root filesystem was taken: on request, while idle before a stop, or as a checkpoint of a sandbox in use. This snapshot is what the next start restores. Memory and processes are not part of it.",
      payloadSchema: SandboxSnapshot,
    },
    "events.iterate.com/sandbox/stopped": {
      description:
        "The container stopped: on request (`destroy`), because nothing had used it for the idle period (a snapshot was taken first), or for a reason no verb saw (`unknown`).",
      payloadSchema: SandboxStopped,
    },
    "events.iterate.com/sandbox/configured": {
      description:
        "A knob of the sandbox set: how long it may sit unused before a snapshot is taken and its container stopped.",
      payloadSchema: SandboxConfigured,
    },
    "events.iterate.com/sandbox/exec-started": {
      description:
        "A command was started in the container (`exec`). Its `exec-finished` names this event's offset.",
      payloadSchema: SandboxExecStarted,
    },
    "events.iterate.com/sandbox/exec-finished": {
      description:
        "A command settled: how it ended (exit code, or the error that kept it from one), how long it took, how much it printed, and the start and end of its output. `startedOffset` is the `exec-started` it settles.",
      payloadSchema: SandboxExecFinished,
    },
    "events.iterate.com/sandbox/port-exposed": {
      description:
        "A port of the sandbox is served at a host of the mind (`exposePort`): the port, the host's name, and the command that is run when a request finds the port closed. The fetch route `sandbox-<name>` on `/` is what serves it and says who may reach it. The command is kept in this log: it never holds a secret.",
      payloadSchema: SandboxPortExposed,
    },
    "events.iterate.com/sandbox/port-unexposed": {
      description: "The port is no longer served at a host (`unexposePort`).",
      payloadSchema: SandboxPortUnexposed,
    },
    "events.iterate.com/sandbox/port-started": {
      description:
        "A request found an exposed port closed, its command was run, and the port opened after `waitedMs`.",
      payloadSchema: z.object({
        port: z.number().int().min(1).max(65535),
        waitedMs: z.number().int().nonnegative(),
      }),
    },
    "events.iterate.com/sandbox/port-start-failed": {
      description:
        "A request found a port closed and it did not open in time: the sandbox did not start, the command could not be run, or it ran and the port stayed closed. The request was answered 502 or 503.",
      payloadSchema: z.object({
        port: z.number().int().min(1).max(65535),
        error: z.string(),
      }),
    },
    "events.iterate.com/sandbox/session-opened": {
      description:
        "Code in the container opened a session with the mind's API and named no token. The sandbox's egress served it, as the code of this context. What the session appends carries this path as its origin.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/sandbox/session-ended": {
      description:
        "The mind ended such a session, because a rule now filters what the sandbox sends. A session that its client closes, or that ends with the container, leaves no fact of its own: the container's `stopped` is the fact.",
      payloadSchema: z.object({ reason: z.string() }),
    },
    [SANDBOX_IDLE_CHECK]: {
      description:
        "The sandbox's own schedule: the container may have gone unused for the idle period. The processor asks the container how long it has been idle, and stops it (snapshot first) or sets the next check.",
      payloadSchema: z.object({}),
    },
  },
});

export const SANDBOXES_ROOT_DESCRIPTION =
  'Linux containers, each with a writable root filesystem that is saved as a snapshot when the sandbox is idle and restored on its next use: `sandboxes.create(path)` once, then `sandboxes.get(path).exec(["bash", "-c", "ls -la"], { cwd?, env?, stdin?, timeoutMs? })` → { exitCode, stdout, stderr } (bytes) · `.files.read(path)` (a stream) · `.files.write(path, string | bytes | stream)` · `stat` · `lstat` · `readDirectory` · `mkdir` · `rename` · `remove` · `.container.<the container API>`, every member under its own name: `.container.snapshotContainer({ name? })`, `.container.destroy()`, `.container.setInactivityTimeout(ms)`, `.container.monitor()`, and a chain as one call, `.container.invoke([["exec", argv, options], "stdout"])` · `.configure({ idleAfterMs })` · `sandboxes.list()`. A SERVER IN A SANDBOX AT A HOST OF THE MIND: `.exposePort(8080, { name: "web", command: ["node", "/root/server.mjs"] })` serves the port at `https://web.<domain>/`, HTTP and WebSockets, for members only; a request starts a stopped sandbox and runs `command` when the port is closed (45 seconds at most, else 502 or 503). `public: true` lets ANY visitor reach it, start that one container and keep it running, with no bound on how often. Never put a secret in `command`: the sandbox\'s log keeps it. The name is free of other fetch routes and is not `iterate`, `auth`, `dash`, `docs` or `voice`; the sandbox is beneath the caller. `.unexposePort(8080)` · `.getExposedPorts()`. The same request from code, HTTP alone: `.container.invoke([["getTcpPort", 8080], ["fetch", request]])` with a Request. WHAT IS INSTALLED DEPENDS ON THE IMAGE, so look before you rely on a tool: `exec(["bash", "-c", "command -v git node claude"])`. `start({ image })` takes the Cloudflare-managed image `"cloudflare/debian-trixie"`, the name of an image of the stack, or a digest-pinned image of the account\'s own registry (`registry.cloudflare.com/<account>/<repository>@sha256:<digest>`). Cloudflare does not pull from another registry, so an image from elsewhere is pushed to the account\'s registry first. A start with no image and no snapshot runs the first of three. The mind\'s own image, once `/` has `events.iterate.com/mind/sandbox-image-configured` with `{ image }`. Else the stack\'s named image, when its config names exactly one (with several, the start must name one). iterate\'s `iterate-dev-image` is one: Debian with Node, git, gh, Chromium, ffmpeg, pnpm, the Claude, Codex and Grok CLIs, cf, doppler and the iterate CLI, and a clone of iterate/core in /work/core. Else `cloudflare/debian-trixie`: Debian with Node 24 and npm, and nothing else of that list: no git, no curl, no coding CLI. INSTALL ONCE, THEN COPY THE SANDBOX: in one sandbox, install what is missing (`apt-get update && apt-get install -y git curl ca-certificates` work through the egress), then take a snapshot, `.container.snapshotContainer({ name })`. Every other sandbox starts from it with `start({ from: "<that sandbox\'s path>" })`, in seconds, with every file, package and user of the first. Do not use the first sandbox after its snapshot: its next idle save replaces the snapshot. A snapshot restores only on the image it was taken from, for 30 days after its last restore, and never holds a running process. A CALL THAT DOES NOT ANSWER WITHIN A MINUTE FAILS, so run longer work in the background, as Cloudflare\'s recipe does: `.container.invoke([["exec", ["setsid", "sh", "-c", "<command> > /tmp/job.log 2>&1; echo $? > /tmp/job.exit"], { stdout: "ignore", stderr: "ignore" }], "pid"])` answers the process id at once, and later calls read the two files. A plain `exec(["bash", "-c", "setsid nohup <command> > /tmp/job.log 2>&1 < /dev/null & echo started"])` works too: join its parts with `;`, never `&&`. AN IDLE SANDBOX IS SAVED AND STOPPED after `idleAfterMs` (five minutes) with no call, and the stop kills its background jobs: a job is not a call. So poll within that period, or raise it for a long install: `.configure({ idleAfterMs })`, an hour at most. `start({ image | containerSnapshot | from })` on a sandbox that already runs on something else fails, and changes nothing: stop it first with `.container.destroy()`. On a sandbox that started on what it names, it does nothing: the sandbox keeps its files as they are now. A snapshot that Cloudflare cannot restore fails the start; `start({ image })` then starts from an image and discards it. The default instance is standard-1; `start({ instance })` names another. The only way out is the egress of the mind: every HTTP and HTTPS request of the container is answered by `itx.fetch`. It may use any secret pinned to where it sends. To filter, rewrite or refuse what one sandbox sends, start it with `start({ egress: ["itx", ["cd", "/"], "workers", ["get", spec], "fetch"] })`: a rule for `itx.fetch` on its context, which stays until another start names one, pointing at a fetch module of your own in another context. The module answers a Request and passes what it lets through on with `this.env.ITX.fetch(request)`, which carries WebSockets too (`itx.fetch` over RPC cannot). A target in the context of the sandbox itself would call itself. THE `iterate` CLI IN A SANDBOX NEEDS NO SIGN-IN: `iterate whoami`, `iterate itx run` and `iterate provide <file>` there reach this mind as the code of the sandbox\'s own context, with no token (each command has `ITERATE_MIND` and `ITERATE_SANDBOX`). A lend from a sandbox sits on its context: call it as `itx.cd("<sandbox path>").<name>`. While such a session is open the sandbox counts as used, and its idle stop comes after the session ends. CODE IN AN UNFILTERED SANDBOX CAN DO WHAT ITS CREATOR\'S CODE CAN, the mind\'s config included. So a sandbox that runs text from outside (a cloned repository, a web page, a guest\'s words) gets `start({ egress })` or lives beneath a jail: a sandbox with a rule for `itx.fetch` on its context or above it gets no session, and a rule that lands later ends an open one.';
