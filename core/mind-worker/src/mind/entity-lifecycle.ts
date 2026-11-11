// Not in contract.ts: the mind contract imports the entity contracts, and a contract importing
// this back would evaluate a cycle.
import { z } from "zod";
import { codedError } from "iterate/lib";
import {
  type ProcessEventArgs,
  type ProcessorContract,
  type ReduceArgs,
  StreamProcessor,
} from "iterate/stream/processor";
import type { ItxEntrypointScope } from "core-itx";

export type EntitySlug = "repo" | "workspace" | "sandbox";

const PLURALS = {
  repo: "repos",
  workspace: "workspaces",
  sandbox: "sandboxes",
} as const;

export function entityPlural<const Slug extends EntitySlug>(slug: Slug): (typeof PLURALS)[Slug] {
  return PLURALS[slug];
}

export const EntityCreationAndDeletionState = z.object({
  creation: z
    .object({
      status: z.enum(["requested", "created", "failed"]),
      offset: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  deletion: z
    .object({
      status: z.enum(["requested", "deleted"]),
      offset: z.number().int().positive(),
    })
    .nullable()
    .default(null),
});
export type EntityCreationAndDeletionState = z.infer<typeof EntityCreationAndDeletionState>;

const NoPayload = z.object({});
const PathPayload = z.object({ path: z.string().min(1) });
const FailurePayload = z.object({ error: z.string() });
type LifecycleEvent<Schema> = { description: string; payloadSchema: Schema };

export function entityLifecycle<const Slug extends EntitySlug>(slug: Slug) {
  const type = <const Fact extends string>(fact: Fact) =>
    `events.iterate.com/${slug}/${fact}` as const;
  const events = {
    [type("create-requested")]: {
      description: `Someone asked for this ${slug} (\`itx.${entityPlural(slug)}.create(path)\`). No payload: the context it lands on IS the ${slug}. The collection writes the child's parent link \`itx ⇒ itx.builtins.cd(creator)\` before this request, the creator being the context that called, so the link is part of the birth and nothing re-points a born context. The processor provisions what the ${slug} needs (a repo's Artifacts repo; a workspace, nothing; a sandbox, nothing: its container starts on first use; a deployment, nothing: a run deploys it) and lands created or create-failed; a request after a failure is a new attempt, one after the certificate a harmless fact.`,
      payloadSchema: NoPayload,
    },
    [type("created")]: {
      description: `The birth certificate: on the ${slug}'s path, and cross-posted to / for the mind catalog — hence it names the path.`,
      payloadSchema: PathPayload,
    },
    [type("create-failed")]: {
      description: "What the creation attempt reported. Terminal until a new request.",
      payloadSchema: FailurePayload,
    },
    [type("delete-requested")]: {
      description: `Someone asked for this ${slug} to go (\`itx.${entityPlural(slug)}.delete(path)\`). No payload: the context it lands on IS the ${slug}. The processor tears down what it provisioned and lands deleted; a request after the certificate is a harmless fact.`,
      payloadSchema: NoPayload,
    },
    [type("deleted")]: {
      description: `The death certificate: on the ${slug}'s path, and cross-posted to / for the mind catalog, which drops the entry — hence it names the path. Terminal: a deleted ${slug} is not re-creatable.`,
      payloadSchema: PathPayload,
    },
    // Computed keys widen to a string index: the literal keys are restated for derived types.
  } as Record<
    `events.iterate.com/${Slug}/${"create-requested" | "delete-requested"}`,
    LifecycleEvent<typeof NoPayload>
  > &
    Record<
      `events.iterate.com/${Slug}/${"created" | "deleted"}`,
      LifecycleEvent<typeof PathPayload>
    > &
    Record<`events.iterate.com/${Slug}/create-failed`, LifecycleEvent<typeof FailurePayload>>;
  return {
    slug,
    stateSchema: EntityCreationAndDeletionState,
    events,
    consumes: [
      type("create-requested"),
      type("created"),
      type("create-failed"),
      type("delete-requested"),
      type("deleted"),
    ] as const,
    emits: [type("created"), type("create-failed"), type("deleted")] as const,
  };
}

// Runs again after every eviction: the certificates are keyed, and each effect tolerates its own
// earlier success (a repo that already exists, one already gone).
export class EntityLifecycleProcessor<
  State extends EntityCreationAndDeletionState = EntityCreationAndDeletionState,
> extends StreamProcessor<State> {
  readonly contract: ProcessorContract<State>;
  private readonly getItx: () => ItxEntrypointScope & Disposable;
  // Read off the host's props.
  private readonly path: () => string;
  private readonly effects: {
    provision?: (path: string) => Promise<unknown>;
    teardown?: (path: string) => Promise<unknown>;
  };

  constructor(
    contract: ProcessorContract<State>,
    getItx: () => ItxEntrypointScope & Disposable,
    path: () => string,
    effects: EntityLifecycleProcessor["effects"] = {},
  ) {
    super();
    this.contract = contract;
    this.getItx = getItx;
    this.path = path;
    this.effects = effects;
  }

  // per incarnation; the durable ground is the state
  #creating = false;
  #deleting = false;

  override reduce({ state, event }: ReduceArgs<State>): State | undefined {
    const at = `events.iterate.com/${this.contract.slug}/`;
    switch (event.type) {
      case `${at}create-requested`:
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "requested", offset: event.offset } };
      case `${at}created`:
        return { ...state, creation: { status: "created", offset: event.offset } };
      case `${at}create-failed`:
        // an attempt whose own-path append lost its answer
        return state.creation?.status === "created"
          ? undefined
          : { ...state, creation: { status: "failed", offset: event.offset } };
      case `${at}delete-requested`:
        return state.deletion?.status === "deleted"
          ? undefined
          : { ...state, deletion: { status: "requested", offset: event.offset } };
      case `${at}deleted`:
        return { ...state, deletion: { status: "deleted", offset: event.offset } };
      default:
        return undefined;
    }
  }

  override processEvent({
    state,
    delivery,
    append,
    runInBackground,
  }: ProcessEventArgs<State>): undefined {
    if (!delivery.caughtUp) return;
    const { slug } = this.contract;
    // `/` first: this path's certificate closes the obligation.
    const certify = async (fact: "created" | "deleted", path: string) => {
      const certificate = {
        type: `events.iterate.com/${slug}/${fact}`,
        payload: { path },
        idempotencyKey: `${slug}/${fact}:${path}`,
      };
      using itx = this.getItx();
      await itx.cd("/").append(certificate);
      await append(certificate);
    };
    if (state.creation?.status === "requested" && !this.#creating) {
      this.#creating = true;
      runInBackground(async () => {
        try {
          const path = this.path();
          await this.effects.provision?.(path);
          await certify("created", path);
        } catch (error) {
          await append({
            type: `events.iterate.com/${slug}/create-failed`,
            payload: { error: error instanceof Error ? error.message : String(error) },
          });
        } finally {
          this.#creating = false;
        }
      });
      return;
    }
    // A throw appends nothing: the next at-head pass is the retry.
    if (
      state.creation?.status === "created" &&
      state.deletion?.status === "requested" &&
      !this.#deleting
    ) {
      this.#deleting = true;
      runInBackground(async () => {
        try {
          const path = this.path();
          await this.effects.teardown?.(path);
          await certify("deleted", path);
        } finally {
          this.#deleting = false;
        }
      });
    }
  }
}

export function assertCreated(
  slug: EntitySlug,
  path: string,
  { creation, deletion }: EntityCreationAndDeletionState,
): void {
  if (deletion) throw new Error(`${slug} ${path}: deleted`);
  if (creation?.status !== "created")
    throw codedError(
      "NOT_CREATED",
      `${slug} ${path}: not created — itx.${entityPlural(slug)}.create(${JSON.stringify(path)}) first`,
      { path },
    );
}
