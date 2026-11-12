import { z } from "zod";
import { CoreEventCatalog, WorkerManifest } from "core-itx";
import { defineProcessorContract, type ProcessorState } from "iterate/stream/processor";
import { RepoContract } from "../repo/contract.ts";
import { WorkspaceContract } from "../workspace/contract.ts";
import { SandboxContract } from "../sandbox/contract.ts";

const EventCause = z.object({
  chain: z.string(),
  depth: z.number(),
  at: z.number().optional(),
  parent: z.string().optional(),
});

export const MindContract = defineProcessorContract({
  slug: "mind",
  // The engine reuses a checkpoint reduced under the same version: bump it to re-reduce every root.
  version: "1",
  description:
    "The mind: where its own creation stands, every context under it (from the announcements each lands on /), the catalog of every repo born under it (from the certificates cross-posted to /), and the publication of its config repo.",
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
        configRepoTemplate: z.string().optional(),
      })
      .nullable()
      .default(null),
    repos: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    workspaces: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    sandboxes: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    // `/` itself is not in it.
    contexts: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    configRepoTip: z
      .object({ commitOid: z.string().min(1), offset: z.number().int().positive() })
      .nullable()
      .default(null),
    // oldest first, each with the fact's cause, which its publication runs under
    unpublishedCommits: z
      .array(
        z.object({
          commitOid: z.string().min(1),
          offset: z.number().int().positive(),
          cause: EventCause.optional(),
        }),
      )
      .default([]),
    // the platform's give-up included
    lastPublicationFactOffset: z.number().int().positive().nullable().default(null),
    // not the tip while the tip's publication is owed or was refused
    publishedCommit: z.string().min(1).nullable().default(null),
  }),
  events: {
    "events.iterate.com/mind/create-requested": {
      description:
        "The mind was born and asked for its config repo (the root's birth events, core/mind-worker's itx-host.ts), seeded from the template `configRepoTemplate` names, a folder of core/configs the build bundled. The processor lands created or create-failed; a request after the certificate is a harmless fact.",
      payloadSchema: z.object({ configRepoTemplate: z.string().optional() }),
    },
    "events.iterate.com/mind/created": {
      description:
        "The birth certificate: existence only, on `/` — the context it lands on IS the mind.",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/mind/create-failed": {
      description: "What provisioning reported. Terminal until a new request.",
      payloadSchema: z.object({ error: z.string() }),
    },
    "events.iterate.com/mind/worker-updated": {
      description:
        "The platform published commit `commitOid` of `/repos/config` as publication `generation`, the offset on `/` of the commit fact that asked for it: `itx.config` on `/` names its worker from this fact on, and every context resolves through it within 5 seconds (the rule snapshot TTL), so every context's events reach its `processEvent` and its facets load from it. Its modules passed the probe: every top-level module resolves, and the main module's default export is an IterateConfigEntrypoint that constructs. The config entrypoint's init case. Only the platform appends it.",
      payloadSchema: z.object({
        commitOid: z.string().min(1),
        generation: z.number().int().positive(),
        modules: WorkerManifest.shape.modules,
      }),
    },
    "events.iterate.com/mind/worker-update-failed": {
      description:
        "Commit `commitOid` of `/repos/config` failed its publication as `generation`, and why: `main` moved on before it was published, a module that does not resolve, or a main module whose default export is no IterateConfigEntrypoint or does not construct. With `unavailable`, the platform could not finish it for now (esm.sh, a module lock, the probe's load): the commit is still owed, and the platform runs its publication again 30 seconds later, twice, then in the mind's next incarnation. `itx.config` still names the publication before it. Only the platform appends it.",
      payloadSchema: z.object({
        commitOid: z.string().min(1),
        generation: z.number().int().positive(),
        error: z.string(),
        unavailable: z.literal(true).optional(),
      }),
    },
    "events.iterate.com/mind/template-applied": {
      description:
        "New code compared `/repos/config` with the template it bundles (`template`), once: the files it `added` and `replaced` are one commit of the platform's, `commitOid` (null when it wrote nothing). A file in `leftAlone` was changed or deleted by somebody, so the platform did not write it: `lacks` are the template's lines that file has not, to add by hand (none for a deleted file). For people and for the installer: no processor reads it.",
      payloadSchema: z.object({
        template: z.string(),
        commitOid: z.string().nullable(),
        added: z.array(z.string()),
        replaced: z.array(z.string()),
        leftAlone: z.array(z.object({ path: z.string(), lacks: z.array(z.string()) })),
        // a deleted file that one of the platform's own files imports: written again, with one
        // file that imports it (absent on a fact from before the rule)
        putBack: z.array(z.object({ path: z.string(), importedBy: z.string() })).optional(),
        // an app whose newer files were not written, so that it stays one version: `yours` are
        // its files somebody changed or deleted, `lacksPackages` what the repo's own
        // package.json does not list (absent on a fact from before the rule)
        appsLeftOld: z
          .array(
            z.object({
              app: z.string(),
              yours: z.array(z.string()),
              lacksPackages: z.array(z.string()),
              // the files of another app left old that this app's newer files import
              imports: z.array(z.string()).optional(),
              // the files held back that import a file of this app, at their older version
              importedBy: z.array(z.string()).optional(),
              notWritten: z.array(z.string()),
            }),
          )
          .optional(),
        // a file outside `apps/` that was not written because it imports a file that was not
        // (absent on a fact from before the rule)
        heldBack: z
          .array(
            z.object({
              path: z.string(),
              imports: z.array(z.string()),
              // the files held back that import this one, at their older version
              importedBy: z.array(z.string()).optional(),
            }),
          )
          .optional(),
        // the update wrote nothing, because the tree it would have left does not load: each file
        // it would have written, with what was wrong (absent on a fact from before the rule)
        refused: z.array(z.object({ path: z.string(), why: z.string() })).optional(),
      }),
    },
    "events.iterate.com/mind/template-not-published": {
      description:
        "The platform's own commit of a template (`template-applied`'s `commitOid`) was refused publication, and `error` says why. The mind still runs the commit published before it, and no later commit publishes until the config repo loads again. Not said for a commit that a newer one replaced before it was published.",
      payloadSchema: z.object({
        template: z.string(),
        commitOid: z.string().min(1),
        error: z.string(),
      }),
    },
  },
  processorDeps: [RepoContract, WorkspaceContract, SandboxContract, CoreEventCatalog],
  consumes: [
    "events.iterate.com/mind/create-requested",
    "events.iterate.com/mind/created",
    "events.iterate.com/mind/create-failed",
    "events.iterate.com/itx/child-created",
    "events.iterate.com/repo/created",
    "events.iterate.com/repo/deleted",
    "events.iterate.com/workspace/created",
    "events.iterate.com/workspace/deleted",
    "events.iterate.com/sandbox/created",
    "events.iterate.com/sandbox/deleted",
    "events.iterate.com/repo/commit-completed",
    "events.iterate.com/mind/worker-updated",
    "events.iterate.com/mind/worker-update-failed",
  ],
  emits: [
    "events.iterate.com/mind/create-requested",
    "events.iterate.com/mind/created",
    "events.iterate.com/mind/create-failed",
    "events.iterate.com/itx/ingress-configured",
    "events.iterate.com/mind/template-applied",
    "events.iterate.com/mind/template-not-published",
  ],
});

export type MindState = ProcessorState<typeof MindContract>;
