// src/sandbox/contract.ts — A SANDBOX: a domain object on the context at any path (`/sandboxes/<name>`
// by convention). It is a Linux container with a disk, and its facts live on that path's log. THIS
// FILE is the only place they are spelled: the entity lifecycle every entity shares
// (src/project/entity-lifecycle.ts), when the container started and from what, each disk snapshot,
// when it stopped, and what each command did. The container itself is the `SandboxContainer`
// Durable Object (container.ts); durable-object.ts is the facet that speaks to it behind the
// `created` guard; src/project/collection.ts is `itx.sandboxes` (`list`, `create`, `delete`);
// library.ts hands out the handle (`itx.sandboxes.get(path)`).
//
// THE DISK IS THE LOG'S FACT: the latest `snapshotted` is what the next `started` restores.
import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";
import { EntityCreationAndDeletionState, entityLifecycle } from "../project/entity-lifecycle.ts";

/** Cloudflare's handle to a stored disk (`ContainerSnapshot`): opaque, and valid only for the image
 *  it was taken from, for 30 days after its last restore. */
export const SandboxSnapshot = z.object({
  id: z.string().min(1),
  size: z.number().int().nonnegative(),
  name: z.string().optional(),
});
export type SandboxSnapshot = z.infer<typeof SandboxSnapshot>;

/** A container's size: one of Cloudflare's instance types, or a custom one. */
export const SandboxInstance = z.union([
  z.enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"]),
  z.object({
    vcpu: z.number().positive(),
    memoryMib: z.number().positive(),
    diskMb: z.number().positive(),
  }),
]);
export type SandboxInstance = z.infer<typeof SandboxInstance>;

/** `sandbox/started`'s payload: where the disk came from. `discardedSnapshotId` names the snapshot a
 *  start from an image on request (`start({ image })`) left behind: the reduce forgets it. A snapshot
 *  Cloudflare will not restore (its image has been replaced, or it expired) fails the start: nothing
 *  falls back to the image, since that would lose the disk without a word. */
export const SandboxStarted = z.object({
  from: z.enum(["image", "snapshot"]),
  snapshotId: z.string().min(1).optional(),
  /** The sandbox whose snapshot this start restored (`start({ from })`), when it was not its own. */
  fromSandbox: z.string().min(1).optional(),
  /** That snapshot's size: it becomes this sandbox's own disk until it saves another. */
  snapshotSize: z.number().int().nonnegative().optional(),
  discardedSnapshotId: z.string().min(1).optional(),
  /** The size the caller named; the sandbox starts on it again until a start names another. */
  instance: SandboxInstance.optional(),
});
export type SandboxStarted = z.infer<typeof SandboxStarted>;

/** `sandbox/stopped`'s payload: who stopped it. `unknown` is a container found stopped that no verb
 *  stopped (it crashed, or Cloudflare stopped it), and so a disk since the last snapshot is lost. */
const SandboxStopped = z.object({ reason: z.enum(["requested", "idle", "unknown"]) });

/** The command as the log keeps it: cut to a screenful. It may carry a secret, so a command takes
 *  its secrets from the environment (`env` is never logged). */
const SandboxExecStarted = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

/** `sandbox/exec-finished`'s payload: the command settled, with the offset of the `exec-started`
 *  it settles, how it ended (an `exitCode`, or an `error` when no exit came: a timeout, a container
 *  that died), how long it took, how much it printed, and the start and end of that output. */
const SandboxExecFinished = z.object({
  startedOffset: z.number().int().nonnegative(),
  command: z.string(),
  exitCode: z.number().int().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  /** What the log kept of each stream: all of a short one, else its two ends (exec-record.ts). */
  stdout: z.string(),
  stderr: z.string(),
  /** A stream's middle was left out: its `…Bytes` say how much it printed. */
  truncated: z.boolean(),
});

/** The image a start names none for: the platform's own, built from `core/os/images/<name>` and
 *  named so in the container's `images` (Node 24, Debian, with git, gh, Chromium, ffmpeg and the
 *  agent CLIs). A name of an image is always `<what>-image`. Where no image is built (a local run),
 *  it starts `SANDBOX_BASE_IMAGE`. */
export const SANDBOX_IMAGE = "iterate-dev-image";
/** Cloudflare's managed image (Node 24, Debian slim; no git or curl), which `start({ image })` can
 *  name for a lean machine. */
export const SANDBOX_BASE_IMAGE = "cloudflare/debian-trixie";

/** How long a sandbox may go unused before it is parked, by default. */
const SANDBOX_DEFAULT_IDLE_AFTER_MS = 5 * 60_000;
/** A running sandbox in use has its disk saved this often, so a container that dies loses at most
 *  this much work. */
export const SANDBOX_CHECKPOINT_AFTER_MS = 15 * 60_000;
/** The longest idle period: the container's backstop (container.ts) is two hours, and the park,
 *  which saves the disk first, must come before it. */
const SANDBOX_MAX_IDLE_AFTER_MS = 60 * 60_000;
/** The longest one call holds a sandbox busy. A call that never ends (a stream a client abandoned, a
 *  command left running) must not keep a container, which bills while it runs, from being parked
 *  for good. */
export const SANDBOX_MAX_BUSY_MS = 60 * 60_000;

/** `sandbox/configured`'s payload: the knobs it patches (a field left out stays as it was). */
export const SandboxConfigured = z.object({
  idleAfterMs: z.number().int().min(1_000).max(SANDBOX_MAX_IDLE_AFTER_MS).optional(),
});
export type SandboxConfigured = z.infer<typeof SandboxConfigured>;

/** A sandbox's reduced state: the lifecycle's, whether a container is running, the disk the next
 *  start restores (null: the base image), and how long it may sit unused. */
export const SandboxState = EntityCreationAndDeletionState.extend({
  running: z.boolean().default(false),
  snapshot: SandboxSnapshot.nullable().default(null),
  /** When the disk was last saved, or the container last started from it (epoch ms): the checkpoint's
   *  clock. */
  savedAt: z.number().int().nullable().default(null),
  /** The size the last start that named one asked for: restarts keep it (null: the platform's default). */
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
