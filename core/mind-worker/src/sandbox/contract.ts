// The disk is the log's fact: the latest `snapshotted` is what the next `started` restores.
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

/** Built from `core/os/images/<name>`; an image name is always `<what>-image`. Where no image is built
 *  (a local run), a start uses SANDBOX_BASE_IMAGE. */
export const SANDBOX_IMAGE = "iterate-dev-image";
export const SANDBOX_BASE_IMAGE = "cloudflare/debian-trixie";

const SANDBOX_DEFAULT_IDLE_AFTER_MS = 5 * 60_000;
export const SANDBOX_CHECKPOINT_AFTER_MS = 15 * 60_000;
/** The park, which saves the disk, must come before the container's two-hour backstop. */
const SANDBOX_MAX_IDLE_AFTER_MS = 60 * 60_000;
/** A call that never ends must not keep a billing container from being parked for good. */
export const SANDBOX_MAX_BUSY_MS = 60 * 60_000;

export const SandboxConfigured = z.object({
  idleAfterMs: z.number().int().min(1_000).max(SANDBOX_MAX_IDLE_AFTER_MS).optional(),
});
export type SandboxConfigured = z.infer<typeof SandboxConfigured>;

export const SandboxState = EntityCreationAndDeletionState.extend({
  running: z.boolean().default(false),
  snapshot: SandboxSnapshot.nullable().default(null),
  savedAt: z.number().int().nullable().default(null),
  instance: SandboxInstance.nullable().default(null),
  idleAfterMs: z.number().int().positive().default(SANDBOX_DEFAULT_IDLE_AFTER_MS),
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
    SANDBOX_IDLE_CHECK,
    "events.iterate.com/itx/schedule-failed",
  ],
  version: "1",
  description:
    "A sandbox: its creation and deletion, each start of its container (from the base image or a disk snapshot), each snapshot of its disk, each stop, and each command that ran.",
  events: {
    ...lifecycle.events,
    "events.iterate.com/sandbox/started": {
      description:
        "The container came up, from the base image or from the latest disk snapshot. A start from an image on request names the snapshot it left behind as discarded.",
      payloadSchema: SandboxStarted,
    },
    "events.iterate.com/sandbox/snapshotted": {
      description:
        "The container's disk was saved: on request, while idle before a stop, or as a checkpoint of a sandbox in use. This snapshot is what the next start restores. Memory and processes are not part of it.",
      payloadSchema: SandboxSnapshot,
    },
    "events.iterate.com/sandbox/stopped": {
      description:
        "The container stopped: on request (`destroy`), because nothing had used it for the idle period (its disk was snapshotted first), or for a reason no verb saw (`unknown`).",
      payloadSchema: SandboxStopped,
    },
    "events.iterate.com/sandbox/configured": {
      description:
        "A knob of the sandbox set: how long it may sit unused before its disk is saved and its container stopped.",
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
    [SANDBOX_IDLE_CHECK]: {
      description:
        "The sandbox's own schedule: the container may have gone unused for the idle period. The processor asks the container how long it has been idle, and stops it (disk first) or sets the next check.",
      payloadSchema: z.object({}),
    },
  },
});

export const SANDBOXES_ROOT_DESCRIPTION =
  'Linux containers with a disk that is saved when idle and restored on the next use: `sandboxes.create(path)` once, then `sandboxes.get(path).exec(["bash", "-c", "ls -la"], { cwd?, env?, stdin?, timeoutMs? })` → { exitCode, stdout, stderr } (bytes) · `.files.read(path)` (a stream) · `.files.write(path, string | bytes | stream)` · `stat` · `lstat` · `readDirectory` · `mkdir` · `rename` · `remove` · `.container.<the container API>`, every member under its own name: `.container.snapshotContainer()`, `.container.exec(argv).stdout`, `.container.destroy()`, `.container.setInactivityTimeout(ms)`, `.container.monitor()` · `.configure({ idleAfterMs })` · `sandboxes.list()`. Debian with Node 24, git, gh, Chromium, ffmpeg, pnpm, the Claude, Codex and Grok CLIs, cf, doppler and the iterate CLI, and a clone of iterate/core in /work/core; `apt-get update && apt-get install` work through the egress (a call that does not answer within a minute fails: run longer work in the background). The default instance is standard-1; `start({ instance })` names another. The only way out is the egress of the mind: every HTTP and HTTPS request of the container is answered by `itx.fetch`. An idle sandbox is saved and stopped after five minutes; a disk Cloudflare cannot restore fails the start (`start({ image: "iterate-dev-image" })` discards it)';
