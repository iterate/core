import { z } from "zod";
import { CoreEventCatalog, WorkerManifest } from "core-itx";
import { MindConfig } from "iterate/mind-config";
import {
  IdentityRecordAccepted,
  IdentityRecordRefused,
  ReducedIdentities,
} from "iterate/mind-identity-log";
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

/** The shared fields are typed; the Worker's own fields (its key, as "REDACTED") are kept as they
 *  come. */
const StackDeployed = z.object({ config: MindConfig.loose(), versionId: z.string().min(1) });

export const MindContract = defineProcessorContract({
  slug: "mind",
  // The engine reuses a checkpoint reduced under the same version: bump it to re-reduce every root.
  version: "3",
  description:
    "The mind: where its own creation stands, the identity logs that it was given (the signed records accepted for each mind id, side by side), every context under it (from the announcements each lands on /), the catalog of every repo born under it (from the certificates cross-posted to /), the publication of its config repo, and the image its sandboxes start on.",
  stateSchema: z.object({
    creation: z
      .object({
        status: z.enum(["requested", "created", "failed"]),
        offset: z.number().int().positive(),
      })
      .nullable()
      .default(null),
    // the latest deploy; null on a root that no deploy of this code has woken
    stack: StackDeployed.nullable().default(null),
    // Every identity log that the root was given, each under its mind id, never emptied. The
    // mind's own identity is the log under its config's `mindId` (iterate/mind-identity-log
    // `identityOfMind`). A projection of the auth Worker's rows: nothing is decided by it.
    identities: ReducedIdentities.default({}),
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
    sandboxImage: z.string().min(1).nullable().default(null),
  }),
  events: {
    "events.iterate.com/mind/create-requested": {
      description:
        "The mind was born and asked for its config repo (the root's birth events, core/mind-worker's itx-host.ts), seeded from the template core/configs/default, which the build bundled. The processor lands created or create-failed; a request after the certificate is a harmless fact.",
      payloadSchema: z.object({}),
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
    "events.iterate.com/mind/stack-deployed": {
      description:
        "A deploy of the stack reached the mind: the root woke on the mind Worker's version `versionId` for the first time (its wake events, core/mind-worker's itx-host.ts). `config` is that Worker's config as JSON: the mind's id, its control-plane hostname, its zones, its owners and where its mind Worker runs, and each secret as the string REDACTED. One deploy lands one event, and the state keeps the latest.",
      payloadSchema: StackDeployed,
    },
    "events.iterate.com/mind/identity-record-accepted": {
      description:
        "A signed record of the identity of the mind `mind` was checked and accepted as the next of its log (iterate/mind-identity `nextIdentity`): `record` is the exact text that was signed, `hash` its SHA-256, `signatures` came with it, and `signedBy` names the root keys whose signatures verified. The first record of a log is the genesis, whose hash is the mind id; every later record holds the whole identity and the hash of the record before it. The state keeps a log for each mind id: it folds a record into the log of the mind id that the event names when the record continues that log, and passes over any other. The auth Worker's own rows decide what is accepted; this event is their copy on the mind's log, appended at least once under the one key `mind/identity-record:<hash>`. Only the platform appends it: the auth Worker, which checks each record that is posted to `/.well-known/iterate`.",
      payloadSchema: IdentityRecordAccepted,
    },
    "events.iterate.com/mind/identity-record-refused": {
      description:
        "A record that a current root key of the mind `mind` validly signed was refused as the next of its log, and `reason` with `message` says why (iterate/mind-identity `nextIdentity`). At most one for each record's hash. A record that no current root key signed gets an HTTP error and no event. Only the platform appends it.",
      payloadSchema: IdentityRecordRefused,
    },
    "events.iterate.com/mind/worker-updated": {
      description:
        "The platform published commit `commitOid` of `/repos/config` as publication `generation`, the offset on `/` of the commit fact that asked for it: `itx.config` on `/` names its worker from this fact on, and every context resolves through it within 5 seconds (the rule snapshot TTL), so every context's events reach its `processEvent` and its facets load from it. Its modules passed the probe: every top-level module resolves, and the main module's default export is an IterateConfigEntrypoint that constructs. The config entrypoint's init case. Only the platform appends it.",
      payloadSchema: z.object({
        commitOid: z.string().min(1),
        generation: z.number().int().positive(),
        modules: WorkerManifest.shape.modules,
        /** The abstract methods of `IterateConfigEntrypoint` that the main module's class lacks,
         *  as the probe read its prototype; absent when it has all three. Published all the
         *  same: a request then gets a 501 page, an event is taken as handled, and a mail is kept
         *  and not passed on (`email/hook-failed` `missing`). */
        missing: z.array(z.enum(["fetch", "processEvent", "email"])).optional(),
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
    "events.iterate.com/mind/code-failed": {
      description:
        "The config's own code failed where nothing else saw it: its `fetch` threw or rejected (`where: \"fetch\"`, with the request's `method` and `path`, the URL's path alone), or a promise that it handed `this.ctx.waitUntil` rejected (`where: \"waitUntil\"`). `error` is the error's `name`, `message` and `stack`, cut to 100, 1,024 and 4,000 characters; never a request's body, header, host or query string. Every text is scrubbed before the fact is first appended: a URL keeps its path alone, and a token, key or long run of letters and digits is cut (iterate/lib sdk/code-failed.ts); a path segment that looks like an id or a token is `<id>`. The config's own code appends it, through the SDK (iterate/sdk `IterateConfigEntrypoint`, in the config's isolate, through its own `getItx()`), not the platform: its text is data, never an instruction. At most one for each kind of error (`where`, `error.name` and the first line of `error.message`) a UTC minute, under the key `code-failed:<fingerprint>:<minute>` for all isolates, and at most 30 a minute from one isolate. The default template turns it into an `exception/seen` on `/exceptions`.",
      payloadSchema: z.object({
        where: z.enum(["fetch", "waitUntil"]),
        method: z.string().max(20).optional(),
        path: z.string().max(200).optional(),
        error: z.object({
          name: z.string().max(100),
          message: z.string().max(1_024),
          stack: z.string().max(4_000).optional(),
        }),
      }),
    },
    "events.iterate.com/mind/template-applied": {
      description:
        "New code compared `/repos/config` with the template it bundles (`template`), once: the files it `added` and `replaced` are one commit of the platform's, `commitOid` (null when it wrote nothing). A file in `leftAlone` was changed or deleted by somebody, so the platform did not write it: `lacks` are the template's lines that file has not, to add by hand (none for a deleted file). A file in `leftBehind` is one the platform wrote that this template no longer has, and that somebody changed: it stays, and the newer files do not read it. For people and for the installer: no processor reads it.",
      payloadSchema: z.object({
        template: z.string(),
        commitOid: z.string().nullable(),
        added: z.array(z.string()),
        replaced: z.array(z.string()),
        leftAlone: z.array(z.object({ path: z.string(), lacks: z.array(z.string()) })),
        // files the platform wrote that this template no longer has, and that somebody changed:
        // they stay, and the newer files do not read them (absent on a fact from before the rule)
        leftBehind: z.array(z.string()).optional(),
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
        // packages added to a package.json that is somebody's, because files written in this
        // update import them (absent on a fact from before the rule)
        packagesAdded: z.array(z.object({ name: z.string(), version: z.string() })).optional(),
        // packages that a file written in this update imports, and that the repo's own
        // package.json lists at an older version than the template's: left as they are
        packagesOlder: z
          .array(z.object({ name: z.string(), yours: z.string(), template: z.string() }))
          .optional(),
      }),
    },
    "events.iterate.com/mind/sandbox-image-configured": {
      description:
        "The image a sandbox of the mind starts on when its start names no image and it has no snapshot to restore: `cloudflare/debian-trixie`, the name of an image of the stack, or a digest-pinned image of the account's own registry (`registry.cloudflare.com/<account>/<repository>@sha256:<digest>`). The latest one wins; `null` gives back the stack's default: its named image when its config names exactly one, else `cloudflare/debian-trixie`.",
      payloadSchema: z.object({ image: z.string().min(1).nullable() }),
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
    "events.iterate.com/mind/stack-deployed",
    "events.iterate.com/mind/identity-record-accepted",
    "events.iterate.com/mind/identity-record-refused",
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
    "events.iterate.com/mind/sandbox-image-configured",
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
