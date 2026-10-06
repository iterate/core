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

/** `sandbox/started`'s payload: where the disk came from. `discardedSnapshotId` names the snapshot a
 *  start from an image on request (`start({ image })`) left behind: the reduce forgets it. A snapshot
 *  Cloudflare will not restore (its image has been replaced, or it expired) fails the start: nothing
 *  falls back to the image, since that would lose the disk without a word. */
export const SandboxStarted = z.object({
  from: z.enum(["image", "snapshot"]),
  snapshotId: z.string().min(1).optional(),
  discardedSnapshotId: z.string().min(1).optional(),
});
export type SandboxStarted = z.infer<typeof SandboxStarted>;

/** `sandbox/stopped`'s payload: who stopped it. `unknown` is a container found stopped that no verb
 *  stopped (it crashed, or Cloudflare stopped it), and so a disk since the last snapshot is lost. */
const SandboxStopped = z.object({ reason: z.enum(["requested", "idle", "unknown"]) });

/** `sandbox/exec-finished`'s payload: the command (cut to a screenful: it may carry a secret, so a
 *  command takes its secrets from the environment), how it ended, and how much it printed. The
 *  output itself is the caller's, never the log's. */
const SandboxExecFinished = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
});

/** The image a start names none for: Cloudflare's managed one (Node 24, Debian; no git or curl). */
export const SANDBOX_IMAGE = "cloudflare/debian-trixie";

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
    "events.iterate.com/sandbox/exec-finished": {
      description: "A command ran in the container and ended.",
      payloadSchema: SandboxExecFinished,
    },
    [SANDBOX_IDLE_CHECK]: {
      description:
        "The sandbox's own schedule: the container may have gone unused for the idle period. The processor asks the container how long it has been idle, and stops it (disk first) or sets the next check.",
      payloadSchema: z.object({}),
    },
  },
});
