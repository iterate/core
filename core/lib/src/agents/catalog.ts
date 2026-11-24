import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ConsumedEvent,
  type ProcessEventArgs,
  type ReduceArgs,
  type ProcessorState,
} from "../stream/processor.ts";
import type { IterateContextApi } from "../api.ts";
import { errorCode, reportIssue } from "../lib.ts";
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { AgentHandleApi, AgentsRootApi } from "./api.ts";
import { AgentContract } from "./contract.ts";
import { AgentCollectionRpcTarget, type OwnAgent } from "./collection.ts";
import { AGENTS_MODULE, AGENTS_PATH } from "./install.ts";

/** The core's announcement that a context exists below this one
 *  (core/itx/src/iterate-context-durable-object.ts `announceToAncestors`): what makes a row. The
 *  core owns it, so the catalog names it here, as `RunEventCatalog` names the run events. */
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
  readonly #getItx: () => Pick<IterateContextApi, "cd"> & Disposable;
  /** The agents whose title could not be written, each reported once. */
  readonly #titleFaults = new Set<string>();

  /** `getItx`: the scope of `/agents`, which reaches each agent's own log (`processEvent`). */
  constructor(getItx: () => Pick<IterateContextApi, "cd"> & Disposable) {
    super();
    this.#getItx = getItx;
  }
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
      // Earlier words beat later ones. A copy of the same words again (a kind's row changed how it
      // makes a title) replaces them.
      if (fromWords && row.titleFromWords && from.offset > titleOffset) title = "";
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

  /** EVERY AGENT SAYS WHAT IT IS FOR in the mind's catalog of contexts (`itx.contexts.list`): when
   *  a copy changes an agent's line (`agentDescription`: its description, or with none its title or
   *  the first words a person sent it), the line goes onto the agent's own log as
   *  `events.iterate.com/itx/described`. Every kind of agent gets it, iterate's or a bridge's, and
   *  an activity or a status alone appends nothing. A copy row cannot do this: no copy is an
   *  `itx/*` event. The key is the copied event's, so a batch delivered again appends nothing. An
   *  agent whose line has not changed since this was deployed gets it at its next change. The
   *  newest description stands, so a person's own stands until the agent's line changes again. A
   *  failed append is reported, and waits for the agent's next change: it never holds the catalog.
   *
   *  AND ITS TITLE, as `metadata.title` of an `itx/described` of its own (`agentTitle`), when a
   *  copy changes the title the agent gave itself: the first words a person sent are no title. The
   *  append carries `metadata` only, so the description stays the purpose alone. `metadata` is one
   *  record, replaced whole, so the title is merged into the record the mind's catalog lists for
   *  the agent's context (`contextMetadata`); that row can be one wake behind the log, so a key a
   *  person wrote in the same wake can be lost. The newest stands: a title a person wrote in About
   *  stands until the agent's own title changes again, and then the agent's lands once. The same
   *  rules as for the description hold: keyed by the copied event, reported when it fails, never
   *  holding the catalog. */
  override processEvent({
    event,
    state,
    previousState,
    blockProcessorWhile,
  }: ProcessEventArgs<AgentCatalogState, ConsumedEvent<typeof AgentCatalogContract>>): undefined {
    if (event?.type !== "events.iterate.com/agent/listing-updated") return;
    const from = event.source.copiedFrom;
    if (!from) return;
    const description = agentDescription(state.agents[from.path]);
    if (description && description !== agentDescription(previousState.agents[from.path]))
      blockProcessorWhile(async () => {
        using itx = this.#getItx();
        await itx
          .cd(from.path)
          .append({
            type: "events.iterate.com/itx/described",
            idempotencyKey: describedKey(from.path, from.offset, description),
            payload: { description },
          })
          .catch((error: unknown) => {
            if (errorCode(error) === "IDEMPOTENCY_CONFLICT") return;
            reportIssue("agents.catalog.described", error, { path: from.path });
          });
      });
    const title = agentTitle(state.agents[from.path]);
    if (title && title !== agentTitle(previousState.agents[from.path]))
      blockProcessorWhile(async () => {
        using itx = this.#getItx();
        try {
          const metadata = { ...(await contextMetadata(itx, from.path)), title };
          // The mind's catalog keeps a record only while it prints this short
          // (core/itx/src/context/context-summary.ts): a longer one is dropped whole, so the
          // title is not written over metadata that would be lost with it.
          if (JSON.stringify(metadata).length > 4_000)
            throw new Error("The context's metadata is too long to take a title.");
          await itx.cd(from.path).append({
            type: "events.iterate.com/itx/described",
            idempotencyKey: `agents/titled:${from.path}@${String(from.offset)}`,
            payload: { metadata },
          });
        } catch (error) {
          if (errorCode(error) === "IDEMPOTENCY_CONFLICT") return;
          // once for each context, while this instance lives: a mind that refuses the read or
          // the write says so, and its issue log is not filled by every agent's every title
          if (this.#titleFaults.has(from.path)) return;
          this.#titleFaults.add(from.path);
          reportIssue("agents.catalog.titled", error, { path: from.path });
        }
      });
  }
}

/** The key of the `itx/described` that carries the line of the copy at `offset`: the copied event
 *  and the line's text. The same copy delivered again appends nothing, and the same event copied
 *  again with another line (a kind's row changed how it makes a title) appends that line once. */
export function describedKey(path: string, offset: number, text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `agents/described:${path}@${String(offset)}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** An agent's line in the mind's catalog of contexts: its description, which is its purpose, at
 *  most 2,000 characters (the schema of `itx/described`). An agent with no description has its
 *  title there, which may be only the first line a person sent (`titleFromWords`): it is the best
 *  line there is. A title is never added to a description: a context's purpose is not its name. */
function agentDescription(
  row: Pick<AgentCatalogState["agents"][string], "title" | "description"> | undefined,
): string | undefined {
  return (row?.description || row?.title)?.slice(0, 2_000);
}

/** An agent's title in the mind's catalog of contexts: only a title the agent gave itself, as the
 *  first words a person sent are no title, at most 80 characters (what a list shows). */
function agentTitle(
  row: Pick<AgentCatalogState["agents"][string], "title" | "titleFromWords"> | undefined,
): string | undefined {
  if (!row?.title || row.titleFromWords) return undefined;
  return row.title.slice(0, 80);
}

/** The metadata the mind's catalog of contexts lists for `path`, read from the first 50 rows under
 *  it, the most recently active first: one bounded read. A context with no row there has none. */
async function contextMetadata(itx: Pick<IterateContextApi, "cd">, path: string) {
  const listed = await itx.cd("/").contexts.list({ under: path, limit: 50 });
  return listed.find((context) => context.path === path)?.metadata;
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
  /** THE MIND'S OWN AGENT, whose code is in the mind's config repo: the kind its start writes on
   *  `/agents`, and the facts that make a context run it (collection.ts `OwnAgent`). A config sets
   *  it beside the export, and then `create` starts that agent and hosts no `AgentDurableObject`.
   *  None: `create` starts the platform's agent. */
  static agent: OwnAgent | undefined;

  processor = new AgentCatalogProcessor(() => this.getItx());
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
      (this.constructor as typeof AgentCollectionDurableObject).agent,
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
