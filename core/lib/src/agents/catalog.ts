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

const AgentCatalogContract = defineProcessorContract({
  slug: "agents",
  version: "3",
  description: "The agents installed in this project by the userspace agents app.",
  stateSchema: z.object({
    /** Every live agent by path. Everything but `createdAt` comes from copies (collection.ts
     *  `CATALOG_ROWS` says how). `title` is the name the agent gave itself or, failing that, the
     *  first line a person sent it, and then `titleFromWords` is true. Copies can land in any order,
     *  so `titleAtOffset` records which event on the agent's log the title came from. */
    agents: z
      .record(
        z.string(),
        z.object({
          createdAt: z.string(),
          title: z.string().optional(),
          titleAtOffset: z.number().optional(),
          titleFromWords: z.boolean().optional(),
          lastActivityAt: z.string().optional(),
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
        "Something a list shows about an agent changed. It's a copy on / of one of the agent's own events, and `source.copiedFrom` says which one; that event's `createdAt` is when the agent was last active. `title` is the agent's title. `fromWords` means the title is only the first line a person sent, and any name the agent gives itself replaces it.",
      payloadSchema: z.object({
        title: z.string().optional(),
        fromWords: z.literal(true).optional(),
      }),
    },
  },
  processorDeps: [AgentContract],
  consumes: [
    "events.iterate.com/agent/created",
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
  /** Folds the `agent/created` and `agent/deleted` certificates on `/` (each agent posts its own,
   *  processor.ts) into the live and the dead agents. A birth counts once, and a death is terminal.
   *
   *  An `agent/listing-updated` copy updates a live agent's row. Only the platform can set
   *  `source.copiedFrom`, so an event without it is ignored: anyone can append to `/`, and a title
   *  is shown to people. Copies can land in any order, so an older copy never undoes a newer one. */
  reduce({
    state,
    event,
  }: ReduceArgs<AgentCatalogState, ConsumedEvent<typeof AgentCatalogContract>>) {
    if (event.type === "events.iterate.com/agent/created") {
      const { path } = event.payload;
      if (state.agents[path] || state.deleted[path]) return; // born once; dead is terminal
      return { ...state, agents: { ...state.agents, [path]: { createdAt: event.createdAt } } };
    }
    if (event.type === "events.iterate.com/agent/deleted") {
      const { path } = event.payload;
      if (state.deleted[path]) return;
      const { [path]: _deleted, ...agents } = state.agents;
      return {
        ...state,
        agents,
        deleted: { ...state.deleted, [path]: { deletedAt: event.createdAt } },
      };
    }
    const from = event.source.copiedFrom;
    const row = from && state.agents[from.path];
    if (!row) return;
    // Copies can land in any order. So each field below is blanked when what the row already has
    // should win, and the row is left alone when both end up blank.
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
    // Every copy means the agent was active when the original happened, unless the row already
    // has later activity.
    let lastActivityAt = from.createdAt;
    if (lastActivityAt <= (row.lastActivityAt || "")) lastActivityAt = "";
    if (!title && !lastActivityAt) return;
    return {
      ...state,
      agents: {
        ...state.agents,
        [from.path]: {
          ...row,
          ...(title && { title, titleAtOffset: from.offset, titleFromWords: fromWords }),
          lastActivityAt: lastActivityAt || row.lastActivityAt,
        },
      },
    };
  }
}

/** The agents app's collection facet — what the `itx.agents` rule names (install.ts): the
 *  published `AgentsRootApi` (api.ts) at the project's root, `AgentsApi` plus `at(base)`, the
 *  collection an agent's own `itx.agents` rule reaches. */
export class AgentCollectionDurableObject
  extends StreamProcessorDurableObject<AgentCatalogState>
  implements AgentsRootApi
{
  /** The processor's reads, and `itx.agents`: the collection's verbs and `at(base)` (collection.ts). */
  static override publicMethods = [...super.publicMethods, "list", "get", "create", "delete", "at"];

  processor = new AgentCatalogProcessor();
  at(base: string) {
    return new AgentCollectionRpcTarget(
      () => this.getItx(),
      // THROUGH THE LOG'S HEAD, not the last pushed batch (`snapshot()` alone answers from what the
      // delivery loop has pushed so far): a death is on `/` before `delete()` returns — the saga
      // posts it here before its own certificate — so a verb on the dead agent right after must see
      // it, or it would host the facet again (collection.ts).
      async () => {
        await this.catchUpFromLog();
        return (await this.snapshot()).state;
      },
      base,
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
