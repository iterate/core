import type { ItxExpression } from "iterate/expression";
import { errorCode, jsonEqual } from "iterate/lib";
import { failureKind, isPlatformFailureKind } from "iterate/platform-retry";
import {
  type ConsumedEvent,
  type EmittedEventInput,
  type ProcessEventArgs,
  type ReduceArgs,
  type StreamEventInput,
  StreamProcessor,
} from "iterate/stream/processor";
import { pinDependencies } from "iterate/package-builds";
import { z } from "zod";
import {
  runningUnder,
  sha256Hex,
  unavailableError,
  type ItxEntrypointScope,
  type WorkerManifest,
} from "core-itx";
import { templates } from "../generated/config-templates.js";
import { readPackage } from "../context/module-resolution.ts";
import { PLATFORM_AUTHOR } from "../repo/contract.ts";
import { ProjectContract, type ProjectState } from "./contract.ts";
import {
  configPointer,
  configRepoCall,
  probedConfig,
  type ProjectPublisher,
} from "./publication.ts";
import {
  seedOf,
  templateChanges,
  templateCommitMessage,
  type RepoFiles,
  type TemplateKept,
} from "./template-update.ts";

// a publication resolves its npm dependencies from esm.sh
const PUBLICATION_BUDGET_MS = 60_000;

const PUBLICATION_ATTEMPT_WAITS_MS = [0, 5_000, 30_000] as const;

// After the last give-up the commit stays owed to the project's next incarnation.
const PUBLICATION_RERUN_WAITS_MS = [30_000, 30_000] as const;

const ingressToConfig = () => ({
  type: "events.iterate.com/itx/ingress-configured" as const,
  idempotencyKey: "itx/ingress-configured",
  payload: { target: ["itx", "config"] },
});

const filesOf = (changes: { path: string; content: string }[]) =>
  Object.fromEntries(changes.map((file) => [file.path, file.content]));

// What the config repo's facet answers to the template's update (iterate/api `RepoHandle`).
const LogAnswer = z.array(
  z.object({
    oid: z.string(),
    message: z.string(),
    author: z.object({ email: z.string() }),
    parents: z.array(z.string()),
  }),
);
const FilesAnswer = z.record(z.string(), z.union([z.string(), z.object({ base64: z.string() })]));
const CommitAnswer = z.object({ commitOid: z.string().nullable() });

/** The facet's own storage, for what no event carries (template-update.ts `TemplateKept`). Not the
 *  reduced state: a root's row names the types it delivers at its birth, so a root born before
 *  this code would never be handed a new one. */
export type KeptByTheFacet = {
  template(): Promise<TemplateKept | undefined>;
  keepTemplate(kept: TemplateKept): Promise<void>;
};

type PublicationAttempt =
  | { kind: "admitted"; mainModule: string; manifest: WorkerManifest }
  | { kind: "refused"; error: string };

export class ProjectProcessor extends StreamProcessor<
  ProjectState,
  ConsumedEvent<typeof ProjectContract>
> {
  readonly contract = ProjectContract;

  private readonly getItx: () => ItxEntrypointScope & Disposable;
  private readonly publisher: () => ProjectPublisher;
  private readonly kept: KeptByTheFacet;

  constructor(
    getItx: () => ItxEntrypointScope & Disposable,
    publisher: () => ProjectPublisher,
    kept: KeptByTheFacet,
  ) {
    super();
    this.getItx = getItx;
    this.publisher = publisher;
    this.kept = kept;
  }

  // per incarnation; the durable ground is the state
  #creating = false;
  #retriedFailedCreation = false;
  #templateFollowed = false;
  // One publication runs at a time and drains, oldest first: a commit that lands while one is in
  // flight is next, without waiting for another delivery.
  #unpublished: ProjectState["unpublishedCommits"] = [];
  #handledThrough = 0;
  #publishing = false;
  #newestState: ProjectState | null = null;
  #seedProbes = new Map<string, ReturnType<typeof probedConfig>>();

  override reduce({
    event,
    state,
  }: ReduceArgs<ProjectState, ConsumedEvent<typeof ProjectContract>>): ProjectState | undefined {
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        return state.creation?.status === "created"
          ? undefined
          : {
              ...state,
              creation: {
                status: "requested",
                offset: event.offset,
                configRepoTemplate: event.payload.configRepoTemplate,
              },
            };
      case "events.iterate.com/project/created":
        return { ...state, creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/project/create-failed":
        return state.creation?.status === "created"
          ? undefined
          : {
              ...state,
              creation: {
                status: "failed",
                offset: event.offset,
                configRepoTemplate: state.creation?.configRepoTemplate,
              },
            };
      case "events.iterate.com/repo/created":
        if (state.repos[event.payload.path]) return undefined;
        return {
          ...state,
          repos: { ...state.repos, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/repo/deleted": {
        if (!state.repos[event.payload.path]) return undefined;
        const { [event.payload.path]: _gone, ...repos } = state.repos;
        return { ...state, repos };
      }
      case "events.iterate.com/workspace/created":
        if (state.workspaces[event.payload.path]) return undefined;
        return {
          ...state,
          workspaces: { ...state.workspaces, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/workspace/deleted": {
        if (!state.workspaces[event.payload.path]) return undefined;
        const { [event.payload.path]: _gone, ...workspaces } = state.workspaces;
        return { ...state, workspaces };
      }
      case "events.iterate.com/sandbox/created":
        if (state.sandboxes[event.payload.path]) return undefined;
        return {
          ...state,
          sandboxes: { ...state.sandboxes, [event.payload.path]: { createdAt: event.createdAt } },
        };
      case "events.iterate.com/sandbox/deleted": {
        if (!state.sandboxes[event.payload.path]) return undefined;
        const { [event.payload.path]: _gone, ...sandboxes } = state.sandboxes;
        return { ...state, sandboxes };
      }
      case "events.iterate.com/itx/child-created":
        if (state.contexts[event.payload.childPath]) return undefined;
        return {
          ...state,
          contexts: {
            ...state.contexts,
            [event.payload.childPath]: { createdAt: event.createdAt },
          },
        };
      case "events.iterate.com/repo/commit-completed":
        if (event.payload.path !== "/repos/config") return undefined;
        return {
          ...state,
          configRepoTip: { commitOid: event.payload.commitOid, offset: event.offset },
          unpublishedCommits: [
            ...state.unpublishedCommits,
            {
              commitOid: event.payload.commitOid,
              offset: event.offset,
              ...(event.source?.cause && {
                cause: { ...event.source.cause, parent: `${event.path}@${event.offset}` },
              }),
            },
          ],
        };
      case "events.iterate.com/project/worker-updated": {
        const { commitOid, generation } = event.payload;
        return {
          ...state,
          unpublishedCommits: state.unpublishedCommits.filter(
            ({ offset }) => offset !== generation,
          ),
          lastPublicationFactOffset: event.offset,
          publishedCommit: commitOid,
        };
      }
      case "events.iterate.com/project/worker-update-failed": {
        const { generation, unavailable } = event.payload;
        return {
          ...state,
          unpublishedCommits: unavailable
            ? state.unpublishedCommits
            : state.unpublishedCommits.filter(({ offset }) => offset !== generation),
          lastPublicationFactOffset: event.offset,
        };
      }
      default:
        return undefined;
    }
  }

  override processEvent({
    state,
    delivery,
    append,
    runInBackground,
  }: ProcessEventArgs<
    ProjectState,
    ConsumedEvent<typeof ProjectContract>,
    EmittedEventInput<typeof ProjectContract>
  >): undefined {
    this.#newestState = state;
    if (!delivery.caughtUp) return;
    // A commit is answered as the generation of its fact's offset, so a return to a commit published
    // before is a publication of its own. A state that owes nothing starts no background work.
    this.#unpublished = state.unpublishedCommits;
    const publisher = this.publisher();
    if (this.#nextOwed() && !this.#publishing) {
      this.#publishing = true;
      runInBackground(async () => {
        try {
          for (let owed = this.#nextOwed(); owed; owed = this.#nextOwed()) {
            // under the commit's own cause: a publication keeps the commit's depth
            const commit = owed;
            await runningUnder(commit.cause, async () => {
              const rerunWaits = [...PUBLICATION_RERUN_WAITS_MS];
              // a newer commit supersedes this one: its publication could only be refused
              const stop = () => this.#unpublished.some(({ offset }) => offset > commit.offset);
              while (!(await this.#publish(commit, publisher)) && rerunWaits.length > 0) {
                for (let waited = 0; waited < rerunWaits[0]! && !stop(); waited += 1_000)
                  await new Promise((resolve) => setTimeout(resolve, 1_000));
                rerunWaits.shift();
                if (stop()) break;
              }
            });
            this.#handledThrough = commit.offset;
          }
        } finally {
          this.#publishing = false;
        }
      });
    }
    // A NEWER TEMPLATE, once per incarnation. A config repo is seeded once, and this code bundles
    // the template it was built with: a project seeded from an older one gets what that adds
    // (template-update.ts). A deploy restarts the root, whose next wake is delivered here.
    if (
      state.creation?.status === "created" &&
      !this.#nextOwed() &&
      !this.#publishing &&
      !this.#templateFollowed
    ) {
      this.#templateFollowed = true;
      runInBackground(async () => {
        try {
          const followed = await this.#followTemplate();
          if (!followed) return;
          if (followed.fact) await append(followed.fact);
          await this.kept.keepTemplate(followed.kept);
        } catch (error) {
          // the next incarnation tries again: a commit made meanwhile only moved the tip
          console.info({
            event: "project.template-not-followed",
            namespace: "project",
            message: "the config repo was not compared with the bundled template",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
    // A failed creation is asked for again, once per incarnation: only the root's birth writes the
    // request, so a failure that stood would leave the project with no site for good.
    if (state.creation?.status === "failed" && !this.#retriedFailedCreation) {
      this.#retriedFailedCreation = true;
      const configRepoTemplate = state.creation.configRepoTemplate;
      runInBackground(() =>
        append({
          type: "events.iterate.com/project/create-requested",
          payload: { configRepoTemplate },
        }),
      );
      return;
    }
    if (state.creation?.status !== "requested" || this.#creating) return;
    // seeded, its publication not landed yet: the publication fact's delivery lands the certificate
    if (state.configRepoTip && state.lastPublicationFactOffset === null) return;
    this.#creating = true;
    runInBackground(async () => {
      try {
        if (!state.configRepoTip) {
          await this.#seed(state, publisher);
          return;
        }
        // The publication's batch already pointed the ingress: this repeat only waits out its fence.
        await append(ingressToConfig());
        await append({
          type: "events.iterate.com/project/created",
          payload: {},
          idempotencyKey: "project/created",
        });
      } catch (error) {
        await append({
          type: "events.iterate.com/project/create-failed",
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        this.#creating = false;
      }
    });
  }

  async #seed(state: ProjectState, publisher: ProjectPublisher): Promise<void> {
    // one stub a call: the template's download outlasts any one of them
    const call = async (expression: ItxExpression) => {
      using itx = this.getItx();
      return await itx.invoke(expression);
    };
    const repo = call(["itx", "builtins", "repos", ["create", "/repos/config"]]);
    const reference = state.creation?.configRepoTemplate;
    // The loader refuses a ref that moves (`…@main`), so the seed pins them; one that cannot be
    // pinned fails the creation.
    const files = (async () => {
      const changes = await pinDependencies(templateFilesOf(reference || "minimal"));
      readPackage(filesOf(changes), "The config template");
      return changes;
    })();
    const probed = files.then((changes) => probedConfig(filesOf(changes), publisher));
    // the publication reads its outcome; one no publication reads is no unhandled rejection
    probed.catch(() => {});
    // Only on an unborn `main` (`parent: null`): `create` answers before the certificate, so the
    // config repo may be written meanwhile, and the seed must never put its files back over that.
    const [repoMade, filesMade] = await Promise.allSettled([repo, files]);
    if (repoMade.status === "rejected") throw repoMade.reason;
    let commitOid: string | null;
    try {
      if (filesMade.status === "rejected") throw filesMade.reason;
      const changes = filesMade.value;
      const seeded = (await call(
        configRepoCall("commitFiles", {
          message: `seed: core/configs/${reference || "minimal"}`,
          changes,
          parent: null,
        }),
      )) as { commitOid: string | null; changedPaths: string[] };
      commitOid = seeded.commitOid;
      if (
        commitOid &&
        jsonEqual([...seeded.changedPaths].sort(), changes.map((file) => file.path).sort())
      )
        this.#seedProbes.set(commitOid, probed);
    } catch (error) {
      // A main born before this project (its Artifacts repo outlived the deployment) has no fact on
      // this log for the follower to publish: `announceTip` lands one.
      commitOid = (await call(configRepoCall("announceTip"))) as string | null;
      if (!commitOid) throw error;
      console.info({
        event: "project.seed-on-born-main",
        namespace: "project",
        message:
          "the seed threw with main born — the repo is older than this project, or an earlier attempt seeded it, or a commit got there first (the seed refused itself), or the seed landed without its answer: main's tip is the project's config, announced for publication",
        commitOid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!commitOid) throw new Error("the config repo's seed left main unborn");
  }

  // What to keep, and the fact to append when there is something to say. Compared once for each
  // set of bundled templates. Nothing is kept when the commit is refused: the next incarnation
  // compares again.
  async #followTemplate() {
    const hash = await sha256Hex(JSON.stringify(templates));
    const kept = await this.kept.template();
    if (kept?.hash === hash) return undefined;
    const call = async (expression: ItxExpression) => {
      using itx = this.getItx();
      return await itx.invoke(expression);
    };
    // the repo's facet answers an itx expression, which is typed `unknown`: each answer is parsed
    const filesAt = async (commitOid: string) =>
      FilesAnswer.parse(await call(configRepoCall("files", { commitOid })));
    // 50 commits back: a seed older than that is out of reach, and the template then only adds
    // the files the repo lacks
    const log = LogAnswer.parse(await call(configRepoCall("log", { limit: 50 })));
    const tip = log[0]?.oid;
    if (!tip) return undefined;
    const current = await filesAt(tip);
    const hashesOf = async (files: RepoFiles) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(files)
            .filter((file): file is [string, string] => typeof file[1] === "string")
            .map(async ([path, content]) => [path, await sha256Hex(content)] as const),
        ),
      );
    // the platform's record of what it wrote; a project older than the record starts from its seed
    const seed = kept?.written ? undefined : seedOf(log, PLATFORM_AUTHOR.email);
    const seeded = seed && (seed.oid === tip ? current : await filesAt(seed.oid));
    const written = kept?.written || (seeded ? await hashesOf(seeded) : {});
    const manifest = typeof current["package.json"] === "string" ? current["package.json"] : "";
    const name =
      kept?.template ||
      seed?.template ||
      /"name":\s*"@iterate-com\/config-([\w-]+)"/.exec(manifest)?.[1] ||
      "";
    if (!Object.hasOwn(templates, name)) return { kept: { ...kept, hash }, fact: undefined };
    const template = await pinDependencies(templateFilesOf(name));
    const now = await hashesOf(current);
    const untouched = new Set(
      Object.keys(written).filter(
        (path) => Object.hasOwn(now, path) && now[path] === written[path],
      ),
    );
    const { changes, added, replaced, platforms, leftAlone } = templateChanges({
      template,
      current,
      written: new Set(Object.keys(written)),
      untouched,
    });
    // only on the tip that was read: a commit made meanwhile refuses this one
    const commit = changes.length
      ? CommitAnswer.parse(
          await call(
            configRepoCall("commitFiles", {
              message: templateCommitMessage(name),
              changes,
              parent: tip,
            }),
          ),
        )
      : null;
    const contents = new Map(template.map((file) => [file.path, file.content]));
    const nowWritten = Object.fromEntries(
      await Promise.all(
        platforms.map(async (path) => [path, await sha256Hex(contents.get(path)!)] as const),
      ),
    );
    return {
      kept: { hash, template: name, written: { ...written, ...nowWritten } },
      fact:
        changes.length || leftAlone.length
          ? {
              type: "events.iterate.com/project/template-applied" as const,
              idempotencyKey: `project/template-applied:${hash.slice(0, 16)}:${tip}`,
              payload: {
                template: name,
                commitOid: commit?.commitOid || null,
                added,
                replaced,
                leftAlone,
              },
            }
          : undefined,
    };
  }

  #nextOwed(): ProjectState["unpublishedCommits"][number] | undefined {
    return this.#unpublished.find(({ offset }) => offset > this.#handledThrough);
  }

  // The pointer and `project/worker-updated` land in one batch, so no state of `/` holds either
  // without the other. True once the outcome landed, false after a give-up.
  async #publish(
    commit: { commitOid: string; offset: number },
    publisher: ProjectPublisher,
  ): Promise<boolean> {
    const { commitOid } = commit;
    const generation = commit.offset;
    const giveUpAt = Date.now() + PUBLICATION_BUDGET_MS;
    let lastFailure: unknown;
    for (const waitMs of PUBLICATION_ATTEMPT_WAITS_MS) {
      if (Date.now() + waitMs >= giveUpAt) break;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      let attempt: PublicationAttempt;
      // a pending timer keeps the context resident
      let budget: ReturnType<typeof setTimeout> | undefined;
      try {
        attempt = await Promise.race([
          this.#attemptPublication(commitOid, generation, publisher),
          new Promise<never>((_, reject) => {
            budget = setTimeout(
              () =>
                reject(
                  unavailableError(
                    "overloaded",
                    `publication ${generation} did not finish within ${PUBLICATION_BUDGET_MS} ms`,
                  ),
                ),
              giveUpAt - Date.now(),
            );
          }),
        ]);
      } catch (error) {
        if (!isPlatformFailureKind(failureKind(error))) throw error;
        lastFailure = error;
        continue;
      } finally {
        clearTimeout(budget);
      }
      if (attempt.kind === "refused") {
        await landOnce(publisher, {
          type: "events.iterate.com/project/worker-update-failed",
          idempotencyKey: `project/publication:${generation}`,
          payload: { commitOid, generation, error: attempt.error },
        });
        return true;
      }
      const { mainModule, manifest } = attempt;
      const pointer = configPointer(commitOid, mainModule, manifest);
      const outcome = {
        type: "events.iterate.com/project/worker-updated",
        idempotencyKey: `project/publication:${generation}`,
        payload: { commitOid, generation, modules: manifest.modules },
      };
      // A project being created gets its ingress in this batch too, so creation waits out one fence.
      // Should its key name another event, the batch is refused whole and lands without it.
      if (this.#newestState?.creation?.status === "requested")
        try {
          await publisher.appendAsPlatform(...pointer, ingressToConfig(), outcome);
          return true;
        } catch (error) {
          if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
        }
      await landOnce(publisher, ...pointer, outcome);
      return true;
    }
    await publisher.appendAsPlatform({
      type: "events.iterate.com/project/worker-update-failed",
      payload: {
        commitOid,
        generation,
        error: lastFailure instanceof Error ? lastFailure.message : String(lastFailure),
        unavailable: true,
      },
    });
    return false;
  }

  async #attemptPublication(
    commitOid: string,
    generation: number,
    publisher: ProjectPublisher,
  ): Promise<PublicationAttempt> {
    const head = await publisher.head();
    if (head !== commitOid)
      return {
        kind: "refused",
        error: `main moved on to ${head || "no commit (unborn)"} before this commit was published`,
      };
    // once: an attempt run again probes what the repo holds
    const seedProbe = this.#seedProbes.get(commitOid);
    this.#seedProbes.delete(commitOid);
    try {
      const { mainModule, modules } = await (seedProbe ||
        probedConfig(await publisher.files(commitOid), publisher));
      return { kind: "admitted", mainModule, manifest: { generation, modules } };
    } catch (error) {
      if (isPlatformFailureKind(failureKind(error))) throw error;
      return { kind: "refused", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// An IDEMPOTENCY_CONFLICT is an earlier attempt's landed batch: a batch lands whole or not at all.
async function landOnce(publisher: ProjectPublisher, ...events: StreamEventInput[]): Promise<void> {
  try {
    await publisher.appendAsPlatform(...events);
  } catch (error) {
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  }
}

function templateFilesOf(name: string) {
  const files = Object.hasOwn(templates, name) ? templates[name] : undefined;
  if (!files)
    throw new Error(
      `no config template ${JSON.stringify(name)}: this build bundles ${Object.keys(templates).join(", ")} (core/configs)`,
    );
  return files;
}
