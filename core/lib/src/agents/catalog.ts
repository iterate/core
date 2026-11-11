import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ConsumedEvent,
  type ReduceArgs,
  type ProcessorState,
} from "../stream/processor.ts";
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { AgentHandleApi, AgentsRootApi } from "./api.ts";
import { AgentContract } from "./contract.ts";
import { AgentCollectionRpcTarget } from "./collection.ts";
import { AGENTS_MODULE, AGENTS_PATH } from "./install.ts";

/** The core's announcement that a context exists below this one (core/os
 *  iterate-context-durable-object.ts `announceToAncestors`): what makes a row. The core owns it, so
 *  the catalog names it here, as `RunEventCatalog` names the run events. */
const ChildCreatedEventCatalog = {
  events: {
    "events.iterate.com/itx/child-created": {
      description:
        "A context under this one exists: every context appends it to each ancestor up to its root when it first wakes, keyed by the child's path.",
      payloadSchema: z.object({ childPath: z.string().min(1) }),
    },
  },
};

/** What an agent is doing, the same words for every kind of agent. */
const AgentStatus = z.enum(["working", "idle", "waiting", "ended"]);

/** The fields a copy sets one by one, each the newest the agent's log has said (`fieldAtOffset`).
 *  `title` is not one of them: it has rules of its own. */
const COPIED_FIELDS = ["kind", "host", "status", "activity", "description"] as const;

const AgentCatalogContract = defineProcessorContract({
  slug: "agents",
  version: "4",
  description:
    "The agents of this mind: every context under /agents, with what a list shows about each.",
  stateSchema: z.object({
    /** Every live agent by path: every context under `/agents`, at any depth, from its own
     *  `itx/child-created` (an agent never posts its birth here). Everything but `createdAt` and
     *  `parent` comes from copies of the agent's own events (collection.ts `CATALOG_ROWS` says how
     *  for an iterate agent; another kind of agent configures its own). `parent` is the nearest
     *  ancestor that is a row too. `title` is the name the agent gave itself or, failing that, the
     *  first line a person sent it, and then `titleFromWords` is true. Copies can land in any order,
     *  so `titleAtOffset` and `fieldAtOffset` record which event on the agent's log each field came
     *  from. */
    agents: z
      .record(
        z.string(),
        z.object({
          createdAt: z.string(),
          parent: z.string().optional(),
          /** What runs the agent: "iterate", "claude", "codex", "opencode", … */
          kind: z.string().optional(),
          /** The machine or sandbox it runs on, for an agent that runs on one. */
          host: z.string().optional(),
          status: AgentStatus.optional(),
          /** One line: what it is doing now. */
          activity: z.string().optional(),
          /** A few sentences: its purpose or conclusions. */
          description: z.string().optional(),
          title: z.string().optional(),
          titleAtOffset: z.number().optional(),
          titleFromWords: z.boolean().optional(),
          lastActivityAt: z.string().optional(),
          fieldAtOffset: z.record(z.string(), z.number()).optional(),
        }),
      )
      .default({}),
    /** Every agent that died, by path: its death certificate. Terminal — a deleted agent is not
     *  re-creatable — so a verb on one answers from this row and never hosts the agent's facet on
     *  its context again (collection.ts says why that matters). */
    deleted: z.record(z.string(), z.object({ deletedAt: z.string() })).default({}),
  }),
  events: {
    "events.iterate.com/agent/listing-updated": {
      description:
        "Something a list shows about an agent changed. It's a copy on /agents of one of the agent's own events, and `source.copiedFrom` says which one; that event's `createdAt` is when the agent was last active. `title` is the agent's title. `fromWords` means the title is only the first line a person sent, and any name the agent gives itself replaces it. `kind` is what runs the agent (`iterate`, `claude`, …), `host` the machine it runs on, `status` what it is doing (`working`, `idle`, `waiting` on someone, `ended`), `activity` one line on what it is doing now and `description` a few sentences on its purpose or conclusions. An empty `activity` or `description` clears it.",
      payloadSchema: z.object({
        title: z.string().optional(),
        fromWords: z.literal(true).optional(),
        kind: z.string().min(1).max(40).optional(),
        host: z.string().min(1).max(120).optional(),
        status: AgentStatus.optional(),
        activity: z.string().max(300).optional(),
        description: z.string().max(1_000).optional(),
      }),
    },
  },
  processorDeps: [AgentContract, ChildCreatedEventCatalog],
  consumes: [
    "events.iterate.com/itx/child-created",
    "events.iterate.com/agent/deleted",
    "events.iterate.com/agent/listing-updated",
  ],
  emits: [],
});
export type AgentCatalogState = ProcessorState<typeof AgentCatalogContract>;
export class AgentCatalogProcessor extends StreamProcessor<
  AgentCatalogState,
  ConsumedEvent<typeof AgentCatalogContract>
> {
  readonly contract = AgentCatalogContract;
  /** Folds the contexts under `/agents` (each announces itself, `itx/child-created`) and the
   *  `agent/deleted` certificates posted here into the live and the dead agents. A birth counts
   *  once, and a death is terminal.
   *
   *  An `agent/listing-updated` copy updates a live agent's row, and makes it when the copy lands
   *  first. Only the platform can set `source.copiedFrom`, so an event without it is ignored:
   *  anyone can append to `/agents`, and a title is shown to people. Copies can land in any order, so an older copy never undoes a newer
   *  one, field by field. */
  reduce({
    state,
    event,
  }: ReduceArgs<AgentCatalogState, ConsumedEvent<typeof AgentCatalogContract>>) {
    if (event.type === "events.iterate.com/itx/child-created") {
      const path = event.payload.childPath;
      if (!path.startsWith(`${AGENTS_PATH}/`)) return; // the announcement is anyone's to append
      if (state.agents[path] || state.deleted[path]) return; // born once; dead is terminal
      return { ...state, agents: withRow(state.agents, path, event.createdAt) };
    }
    if (event.type === "events.iterate.com/agent/deleted") {
      const { path } = event.payload;
      if (state.deleted[path]) return;
      return {
        ...state,
        agents: withoutRow(state.agents, path),
        deleted: { ...state.deleted, [path]: { deletedAt: event.createdAt } },
      };
    }
    const from = event.source.copiedFrom;
    if (!from?.path.startsWith(`${AGENTS_PATH}/`) || state.deleted[from.path]) return;
    // A copy is proof its context exists (only the platform sets `copiedFrom`), and it can land
    // before the context's own announcement: the row is made here then, and the announcement
    // finds it born.
    const agents = state.agents[from.path]
      ? state.agents
      : withRow(state.agents, from.path, from.createdAt);
    const row = agents[from.path]!;
    // Copies can land in any order. So each field below is blanked when what the row already has
    // should win, and the row is left alone when all end up blank.
    const { fromWords } = event.payload;
    let title = event.payload.title;
    if (row.title) {
      const titleOffset = row.titleAtOffset || 0;
      // A name the agent gave itself beats a person's words.
      if (fromWords && !row.titleFromWords) title = "";
      // Earlier words beat later ones.
      if (fromWords && row.titleFromWords && from.offset >= titleOffset) title = "";
      // A newer name beats an older one.
      if (!fromWords && !row.titleFromWords && from.offset <= titleOffset) title = "";
    }
    // Every other field: the newest event the agent's log has said it in wins.
    const fields: Partial<AgentCatalogState["agents"][string]> = {};
    const fieldAtOffset = { ...row.fieldAtOffset };
    for (const field of COPIED_FIELDS) {
      const value = event.payload[field];
      // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty activity or description clears it; absent keeps it
      if (value === undefined || from.offset <= (fieldAtOffset[field] || 0)) continue;
      Object.assign(fields, { [field]: value });
      fieldAtOffset[field] = from.offset;
    }
    // Every copy means the agent was active when the original happened, unless the row already
    // has later activity.
    let lastActivityAt = from.createdAt;
    if (lastActivityAt <= (row.lastActivityAt || "")) lastActivityAt = "";
    if (!title && !lastActivityAt && Object.keys(fields).length === 0 && agents === state.agents)
      return;
    return {
      ...state,
      agents: {
        ...agents,
        [from.path]: {
          ...row,
          ...fields,
          ...(Object.keys(fields).length > 0 && { fieldAtOffset }),
          ...(title && { title, titleAtOffset: from.offset, titleFromWords: fromWords }),
          lastActivityAt: lastActivityAt || row.lastActivityAt,
        },
      },
    };
  }
}

/** The rows with `path` added: its parent the nearest ancestor that is a row, and every row below it
 *  whose parent is further up (its announcement landed first) now its child. */
function withRow(agents: AgentCatalogState["agents"], path: string, createdAt: string) {
  const parent = ancestorsOf(path).find((ancestor) => agents[ancestor]);
  const next: AgentCatalogState["agents"] = {};
  for (const [other, row] of Object.entries(agents))
    next[other] =
      other.startsWith(`${path}/`) && (row.parent || "").length < path.length
        ? { ...row, parent: path }
        : row;
  next[path] = { createdAt, parent };
  return next;
}

/** The rows without `path`: each of its children now the child of its parent. */
function withoutRow(agents: AgentCatalogState["agents"], path: string) {
  const { [path]: gone, ...rest } = agents;
  if (!gone) return rest;
  const next: AgentCatalogState["agents"] = {};
  for (const [other, row] of Object.entries(rest)) {
    if (row.parent !== path) next[other] = row;
    else {
      const { parent: _parent, ...orphan } = row;
      next[other] = gone.parent ? { ...orphan, parent: gone.parent } : orphan;
    }
  }
  return next;
}

/** `path`'s ancestors below `/agents`, nearest first: `/agents/a/b/c` → `/agents/a/b`, `/agents/a`. */
function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  for (let at = path.lastIndexOf("/"); at > AGENTS_PATH.length; at = path.lastIndexOf("/", at - 1))
    ancestors.push(path.slice(0, at));
  return ancestors;
}

/** The agents app's collection facet — what the `itx.agents` rule names (install.ts): the
 *  published `AgentsRootApi` (api.ts) at the mind's root, `AgentsApi` plus `at(base)`, the
 *  collection an agent's own `itx.agents` rule reaches. */
export class AgentCollectionDurableObject
  extends StreamProcessorDurableObject<AgentCatalogState>
  implements AgentsRootApi
{
  /** The processor's reads, and `itx.agents`: the collection's verbs and `at(base)` (collection.ts). */
  static override publicMethods = [...super.publicMethods, "list", "get", "create", "delete", "at"];
  /** The module of the mind's published config that exports this class and
   *  `AgentDurableObject`: each agent's facet is started from it. A config that keeps them in
   *  another module sets it there, beside the export. */
  static module = AGENTS_MODULE;

  processor = new AgentCatalogProcessor();
  at(base: string) {
    return new AgentCollectionRpcTarget(
      () => this.getItx(),
      // THROUGH THE LOG'S HEAD, not the last pushed batch (`snapshot()` alone answers from what the
      // delivery loop has pushed so far): a death is on `/agents` before `delete()` returns — the
      // saga posts it here before its own certificate — so a verb on the dead agent right after
      // must see it, or it would host the facet again (collection.ts).
      async () => {
        await this.catchUpFromLog();
        return await this.snapshot();
      },
      base,
      (this.constructor as typeof AgentCollectionDurableObject).module,
    );
  }
  #collection = this.at("/");
  list() {
    return this.#collection.list();
  }
  // oxlint-disable-next-line iterate/mechanical-class-impl -- the published declarations name the handle by its interface: the inferred class is collection.ts's own
  get(path: string): AgentHandleApi {
    return this.#collection.get(path);
  }
  create(path: string) {
    return this.#collection.create(path);
  }
  delete(path: string) {
    return this.#collection.delete(path);
  }
}
