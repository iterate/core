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
import { readPackage } from "../context/module-resolution.ts";
import { PLATFORM_AUTHOR } from "../repo/contract.ts";
import { MindContract, type MindState } from "./contract.ts";
import { configPointer, configRepoCall, probedConfig, type MindPublisher } from "./publication.ts";
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

// After the last give-up the commit stays owed to the mind's next incarnation.
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

/** The config templates this build bundles (the generated config-templates.js, which the facet
 *  hands over): each folder of core/configs by its name, with its files. */
export type ConfigTemplates = Record<string, { path: string; content: string }[]>;

/** The facet's own storage, for what no event carries (template-update.ts `TemplateKept`). Not the
 *  reduced state: a root's row names the types it delivers at its birth, so a root born before
 *  this code would never be handed a new one. */
export type KeptByTheFacet = {
  template(): Promise<TemplateKept | undefined>;
  keepTemplate(kept: TemplateKept): Promise<void>;
};

type PublicationAttempt =
  | { kind: "admitted"; mainModule: string; manifest: WorkerManifest }
  // `superseded`: main moved on before the commit was looked at, which says nothing about it
  | { kind: "refused"; error: string; superseded?: true };

export class MindProcessor extends StreamProcessor<MindState, ConsumedEvent<typeof MindContract>> {
  readonly contract = MindContract;

  private readonly getItx: () => ItxEntrypointScope & Disposable;
  private readonly publisher: () => MindPublisher;
  private readonly kept: KeptByTheFacet;
  private readonly templates: ConfigTemplates;

  constructor(
    getItx: () => ItxEntrypointScope & Disposable,
    publisher: () => MindPublisher,
    kept: KeptByTheFacet,
    templates: ConfigTemplates,
  ) {
    super();
    this.getItx = getItx;
    this.publisher = publisher;
    this.kept = kept;
    this.templates = templates;
  }

  // per incarnation; the durable ground is the state
  #creating = false;
  #retriedFailedCreation = false;
  #templateFollowed = false;
  // The template commit this incarnation made: known here before the record of it is kept.
  #templateCommit: { commitOid: string; template: string } | undefined;
  // One publication runs at a time and drains, oldest first: a commit that lands while one is in
  // flight is next, without waiting for another delivery.
  #unpublished: MindState["unpublishedCommits"] = [];
  #handledThrough = 0;
  #publishing = false;
  #newestState: MindState | null = null;
  #seedProbes = new Map<string, ReturnType<typeof probedConfig>>();

  override reduce({
    event,
    state,
  }: ReduceArgs<MindState, ConsumedEvent<typeof MindContract>>): MindState | undefined {
    switch (event.type) {
      case "events.iterate.com/mind/create-requested":
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
      case "events.iterate.com/mind/created":
        return { ...state, creation: { status: "created", offset: event.offset } };
      case "events.iterate.com/mind/create-failed":
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
      case "events.iterate.com/mind/worker-updated": {
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
      case "events.iterate.com/mind/worker-update-failed": {
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
    MindState,
    ConsumedEvent<typeof MindContract>,
    EmittedEventInput<typeof MindContract>
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
        // The template's update waited for this drain, and the drain's own outcome was delivered
        // while it still ran: no later delivery is owed, so it starts here.
        await this.#followTemplateOnce(append);
      });
    }
    // A NEWER TEMPLATE, once per incarnation (`#followTemplateOnce`): now when nothing is owed, else
    // at the end of the publication above. A deploy restarts the root, whose next wake is
    // delivered here.
    if (this.#templateMayFollow()) runInBackground(() => this.#followTemplateOnce(append));
    // A failed creation is asked for again, once per incarnation: only the root's birth writes the
    // request, so a failure that stood would leave the mind with no site for good.
    if (state.creation?.status === "failed" && !this.#retriedFailedCreation) {
      this.#retriedFailedCreation = true;
      const configRepoTemplate = state.creation.configRepoTemplate;
      runInBackground(() =>
        append({
          type: "events.iterate.com/mind/create-requested",
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
          type: "events.iterate.com/mind/created",
          payload: {},
          idempotencyKey: "mind/created",
        });
      } catch (error) {
        await append({
          type: "events.iterate.com/mind/create-failed",
          payload: { error: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        this.#creating = false;
      }
    });
  }

  async #seed(state: MindState, publisher: MindPublisher): Promise<void> {
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
      const changes = await pinDependencies(this.#templateFilesOf(reference || "minimal"));
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
      // A main born before this mind (its Artifacts repo outlived the deployment) has no fact on
      // this log for the follower to publish: `announceTip` lands one.
      commitOid = (await call(configRepoCall("announceTip"))) as string | null;
      if (!commitOid) throw error;
      console.info({
        event: "mind.seed-on-born-main",
        namespace: "mind",
        message:
          "the seed threw with main born — the repo is older than this mind, or an earlier attempt seeded it, or a commit got there first (the seed refused itself), or the seed landed without its answer: main's tip is the mind's config, announced for publication",
        commitOid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!commitOid) throw new Error("the config repo's seed left main unborn");
  }

  // Created, nothing owed, no publication running, and not compared yet in this incarnation.
  #templateMayFollow(): boolean {
    return (
      this.#newestState?.creation?.status === "created" &&
      !this.#nextOwed() &&
      !this.#publishing &&
      !this.#templateFollowed
    );
  }

  // A config repo is seeded once, and this code bundles the template it was built with: a mind
  // seeded from an older one gets what that adds (template-update.ts). Never throws.
  async #followTemplateOnce(
    append: (...events: EmittedEventInput<typeof MindContract>[]) => Promise<unknown>,
  ): Promise<void> {
    if (!this.#templateMayFollow()) return;
    this.#templateFollowed = true;
    try {
      const followed = await this.#followTemplate();
      if (!followed) return;
      if (followed.fact) await append(followed.fact);
      await this.kept.keepTemplate(followed.kept);
    } catch (error) {
      // the next incarnation tries again: a commit made meanwhile only moved the tip
      console.info({
        event: "mind.template-not-followed",
        namespace: "mind",
        message: "the config repo was not compared with the bundled template",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // What to keep, and the fact to append when there is something to say. Compared once for each
  // set of bundled templates. Nothing is kept when the commit is refused: the next incarnation
  // compares again.
  async #followTemplate() {
    const hash = await sha256Hex(JSON.stringify(this.templates));
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
    // the platform's record of what it wrote; a mind older than the record starts from its seed
    const seed = kept?.written ? undefined : seedOf(log, PLATFORM_AUTHOR.email);
    const seeded = seed && (seed.oid === tip ? current : await filesAt(seed.oid));
    const written = kept?.written || (seeded ? await hashesOf(seeded) : {});
    const manifest = typeof current["package.json"] === "string" ? current["package.json"] : "";
    const name =
      kept?.template ||
      seed?.template ||
      /"name":\s*"@iterate-com\/config-([\w-]+)"/.exec(manifest)?.[1] ||
      "";
    if (!Object.hasOwn(this.templates, name)) return { kept: { ...kept, hash }, fact: undefined };
    const template = await pinDependencies(this.#templateFilesOf(name));
    const now = await hashesOf(current);
    const untouched = new Set(
      Object.keys(written).filter(
        (path) => Object.hasOwn(now, path) && now[path] === written[path],
      ),
    );
    const { changes, added, replaced, platforms, leftAlone, putBack } = templateChanges({
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
    if (commit?.commitOid) this.#templateCommit = { commitOid: commit.commitOid, template: name };
    const contents = new Map(template.map((file) => [file.path, file.content]));
    const nowWritten = Object.fromEntries(
      await Promise.all(
        platforms.map(async (path) => [path, await sha256Hex(contents.get(path)!)] as const),
      ),
    );
    return {
      kept: {
        hash,
        template: name,
        written: { ...written, ...nowWritten },
        commit: commit?.commitOid || kept?.commit,
      },
      fact:
        changes.length || leftAlone.length
          ? {
              type: "events.iterate.com/mind/template-applied" as const,
              idempotencyKey: `mind/template-applied:${hash.slice(0, 16)}:${tip}`,
              payload: {
                template: name,
                commitOid: commit?.commitOid || null,
                added,
                replaced,
                leftAlone,
                putBack,
              },
            }
          : undefined,
    };
  }

  // The template that `commitOid` applied, when it is the platform's last template commit: this
  // incarnation's, or the one the record keeps from an earlier incarnation.
  async #templateOf(commitOid: string): Promise<string | undefined> {
    if (this.#templateCommit?.commitOid === commitOid) return this.#templateCommit.template;
    const kept = await this.kept.template();
    return kept?.commit === commitOid ? kept.template : undefined;
  }

  #templateFilesOf(name: string) {
    const files = Object.hasOwn(this.templates, name) ? this.templates[name] : undefined;
    if (!files)
      throw new Error(
        `no config template ${JSON.stringify(name)}: this build bundles ${Object.keys(this.templates).join(", ")} (core/configs)`,
      );
    return files;
  }

  #nextOwed(): MindState["unpublishedCommits"][number] | undefined {
    return this.#unpublished.find(({ offset }) => offset > this.#handledThrough);
  }

  // The pointer and `mind/worker-updated` land in one batch, so no state of `/` holds either
  // without the other. True once the outcome landed, false after a give-up.
  async #publish(
    commit: { commitOid: string; offset: number },
    publisher: MindPublisher,
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
        const refused: StreamEventInput[] = [
          {
            type: "events.iterate.com/mind/worker-update-failed",
            idempotencyKey: `mind/publication:${generation}`,
            payload: { commitOid, generation, error: attempt.error },
          },
        ];
        // THE PLATFORM'S OWN COMMIT DOES NOT LOAD: a fact of its own, in the same batch. The mind
        // goes on with the commit published before, so nothing looks broken and a deploy ends
        // well: a deploy's check reads this fact. The commit is not undone: its tree and this
        // fact are how the cause is found.
        const template = attempt.superseded ? undefined : await this.#templateOf(commitOid);
        if (template)
          refused.push({
            type: "events.iterate.com/mind/template-not-published",
            idempotencyKey: `mind/template-not-published:${generation}`,
            payload: { template, commitOid, error: attempt.error },
          });
        await landOnce(publisher, ...refused);
        return true;
      }
      const { mainModule, manifest } = attempt;
      const pointer = configPointer(commitOid, mainModule, manifest);
      const outcome = {
        type: "events.iterate.com/mind/worker-updated",
        idempotencyKey: `mind/publication:${generation}`,
        payload: { commitOid, generation, modules: manifest.modules },
      };
      // A mind being created gets its ingress in this batch too, so creation waits out one fence.
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
      type: "events.iterate.com/mind/worker-update-failed",
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
    publisher: MindPublisher,
  ): Promise<PublicationAttempt> {
    const head = await publisher.head();
    if (head !== commitOid)
      return {
        kind: "refused",
        superseded: true,
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
async function landOnce(publisher: MindPublisher, ...events: StreamEventInput[]): Promise<void> {
  try {
    await publisher.appendAsPlatform(...events);
  } catch (error) {
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  }
}
