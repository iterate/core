// src/deployment/contract.ts — A DEPLOYMENT: one deployment of core/os on Cloudflare, a domain object
// on the context at any path of a project (`/deployments/<worker>` by convention: the path's last
// segment is the Worker's name, Alchemy's stage and the name of its secret). Its facts live on that
// path's log, and THIS FILE is the only place they are spelled: the entity lifecycle every entity
// shares (src/project/entity-lifecycle.ts), and THE RUN, a saga (core/lib README, "A multi-step
// run"): the request, each attempt, the steps of each attempt, and the one settlement.
// durable-object.ts turns a verb into the request, processor.ts drives the run, and run.ts is one
// attempt.
//
// NO PAYLOAD HOLDS A SECRET: the iterate config a run deploys, its secrets and the account's API
// token among them, stays in the facet's own storage (durable-object.ts), where the verb put it
// under an id of its own. A fact names the release, the images, the account and that id.
import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";
import { EntityCreationAndDeletionState, entityLifecycle } from "../project/entity-lifecycle.ts";

/** An offset on the deployment's log: a request's, which is the id of its run, or a step's. */
const Offset = z.number().int().positive();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Where a run acts: the Cloudflare account its config names, and the id the facet keeps that
 *  config under. Each request brings its own, so a request that opens no run leaves the open
 *  run's, and the last run's, as they are. */
const DeploymentTarget = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  configId: z.string().min(1),
});

/** `deployment/run-requested`: all that a run needs but the config. A plan or a deploy names its
 *  release (a zip of bundle/, assets/ and migrations/ in the project's files) and the images. A
 *  destroy plans from Alchemy's state alone. */
export const DeploymentRunRequested = z.discriminatedUnion("kind", [
  DeploymentTarget.extend({
    kind: z.enum(["plan", "deploy"]),
    release: z.object({ file: z.string().startsWith("/"), sha256: Sha256 }),
    /** image name ⇒ its reference in the account's registry, pinned by digest (scripts/images.ts) */
    images: z.record(
      z.string(),
      z.string().regex(/^registry\.cloudflare\.com\/[0-9a-f]{32}\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/),
    ),
    version: z.string().optional(),
  }),
  DeploymentTarget.extend({ kind: z.literal("destroy") }),
]);
export type DeploymentRunRequested = z.infer<typeof DeploymentRunRequested>;

/** Every step names the request it belongs to and the attempt that took it. The attempt reports
 *  the rest, and the processor adds these two (processor.ts). */
const Step = z.object({ requestOffset: Offset, attempt: z.number().int().positive() });

/** `deployment/release-staged`, as the attempt reports it: the release it read from the project's
 *  files, checked and unzipped. */
export const DeploymentReleaseStaged = z.object({
  sha256: Sha256,
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
/** `deployment/run-planned`, as the attempt reports it: the action of each resource. `action` is a
 *  string because Alchemy owns that set (its Plan.ts): a copy here would break on an upgrade. */
export const DeploymentRunPlanned = z.object({
  resources: z.array(z.object({ fqn: z.string(), type: z.string(), action: z.string() })),
});
/** `deployment/resource-applied`, as the attempt reports it: one resource that the apply finished,
 *  and Alchemy's status for it (its Report.ts owns that set, as Plan.ts owns the actions). */
export const DeploymentResourceApplied = z.object({
  fqn: z.string(),
  type: z.string(),
  status: z.string(),
});

/** `deployment/run-settled`, the run's one terminal fact, keyed by its request. */
export const DeploymentRunSettled = z.object({
  requestOffset: Offset,
  /** How the run ended (docs/engineering-invariants.md, "Failures and retries"): `refused` is an
   *  expected outcome (the request opened no run, the deployment's deletion was asked, or the
   *  release, the config, the secret or the token's reach refused it); `failed` is any other
   *  error, our own defect or an answer of Cloudflare's, which `error` names by its tag, or
   *  attempts that kept ending before they settled the run: run it again; `unavailable` is the
   *  platform's failure: run it again too. */
  status: z.enum(["succeeded", "refused", "failed", "unavailable"]),
  /** the attempts started: 0 for a request that opened no run */
  attempts: z.number().int().nonnegative(),
  /** the Worker's URL, after a deploy that succeeded */
  url: z.string().optional(),
  /** why the run did not succeed, with every secret value masked */
  error: z.string().optional(),
});
export type DeploymentRunSettled = z.infer<typeof DeploymentRunSettled>;

/** A deployment's reduced state: the lifecycle's, where the open run stands, where the runs act, and
 *  where the Worker answers. */
export const DeploymentState = EntityCreationAndDeletionState.extend({
  /** The open run, what `snapshot()` renders: the request whole, the attempt under way (0 before the
   *  first), the last step it reached, and the offset of that step's fact. Null when no run is open. */
  run: z
    .object({
      requestOffset: Offset,
      request: DeploymentRunRequested,
      attempt: z.number().int().nonnegative(),
      step: z.enum(["requested", "started", "staged", "planned", "applying"]),
      stepOffset: Offset,
    })
    .nullable()
    .default(null),
  /** The account and the config id of the last request that opened a run: what `destroy()` and
   *  the deletion's teardown act with. */
  target: DeploymentTarget.nullable().default(null),
  /** The Worker's URL after the last deploy that succeeded; null after a destroy that succeeded. */
  url: z.string().nullable().default(null),
});
export type DeploymentState = z.infer<typeof DeploymentState>;

const lifecycle = entityLifecycle("deployment");

export const DeploymentContract = defineProcessorContract({
  ...lifecycle,
  stateSchema: DeploymentState,
  version: "1",
  description:
    "A deployment of core/os on Cloudflare: its creation and deletion, and each run (a plan, a deploy or a destroy): the request, each attempt and its steps, and how the run settled.",
  consumes: [
    ...lifecycle.consumes,
    "events.iterate.com/deployment/run-requested",
    "events.iterate.com/deployment/attempt-started",
    "events.iterate.com/deployment/release-staged",
    "events.iterate.com/deployment/run-planned",
    "events.iterate.com/deployment/resource-applied",
    "events.iterate.com/deployment/run-settled",
  ],
  emits: [
    ...lifecycle.emits,
    "events.iterate.com/deployment/attempt-started",
    "events.iterate.com/deployment/release-staged",
    "events.iterate.com/deployment/run-planned",
    "events.iterate.com/deployment/resource-applied",
    "events.iterate.com/deployment/run-settled",
  ],
  events: {
    ...lifecycle.events,
    "events.iterate.com/deployment/run-requested": {
      description:
        "A verb asked for a run: a plan, a deploy or a destroy. Its offset is the run's id. No field is a secret: the iterate config, its secrets and the account's API token stay in the facet's own storage, under `configId`. A request that opens no run (one run is open, or the deployment is not created, or its deletion was asked) is settled `refused` at once.",
      payloadSchema: DeploymentRunRequested,
    },
    "events.iterate.com/deployment/attempt-started": {
      description:
        "The run started an attempt. `retrying` names the attempt before it, which ended before it settled the run: with the incarnation that ran it, or before a fact of its driver landed.",
      payloadSchema: Step.extend({ retrying: z.string().optional() }),
    },
    "events.iterate.com/deployment/release-staged": {
      description:
        "The attempt read the release from the project's files, checked its SHA-256 and unzipped it.",
      payloadSchema: DeploymentReleaseStaged.extend(Step.shape),
    },
    "events.iterate.com/deployment/run-planned": {
      description:
        "The attempt's plan: the action of each resource. A plan run settles after this fact.",
      payloadSchema: DeploymentRunPlanned.extend(Step.shape),
    },
    "events.iterate.com/deployment/resource-applied": {
      description: "The attempt's apply finished one resource, with Alchemy's status for it.",
      payloadSchema: DeploymentResourceApplied.extend(Step.shape),
    },
    "events.iterate.com/deployment/run-settled": {
      description:
        "The run's one terminal fact, after how many attempts: succeeded (with the Worker's URL after a deploy), refused (an expected outcome), failed (any other error: our own defect or an answer of Cloudflare's) or unavailable (the platform failed), and why, with every secret value masked. After failed or unavailable, run it again.",
      payloadSchema: DeploymentRunSettled,
    },
  },
});
