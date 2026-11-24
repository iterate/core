// collection.ts — `itx.agents` over one base (api.ts `AgentsApi`): `list`, `create`, `delete`, and
// `get(path)` with `message` and `recent`.
//
// AN AGENT IS ANY CONTEXT UNDER `/agents` (catalog.ts), AND THE PLATFORM RUNS NONE OF THEM.
// - THE MIND'S OWN AGENT is code in the mind's config repo. The config hands this collection the
//   facts that start it (`OwnAgent`, catalog.ts `AgentCollectionDurableObject.agent`). `create`
//   appends them to the agent's context, and the facets that they enable are the agent.
// - ANY OTHER KIND (a coding session that a bridge appends to, say) has nothing here: its own
//   subscription delivers what lands on its context to whatever runs it.
// A message to an agent of any kind is ONE `agent/message-received` on its context (message.ts).
// No verb calls a facet of an agent.
//
// A DELETED AGENT IS NOT STARTED AGAIN. Its death is a row of the catalog on `/agents`, and every
// verb reads the catalog first: a dead agent's context is not even called.
//
// A ROW OF THE KIND `iterate` (`FORMER_KIND`) is a context that an agent of the platform ran, which
// the platform no longer has. The mind's own agent takes such a context over at its next `create`
// or message: `ownStart` says how.
import { RpcTarget } from "cloudflare:workers";
import type { StreamEvent, StreamEventInput } from "../stream/processor.ts";
import { codedError, errorCode, resolveContextPath } from "../lib.ts";
import type { IterateContextApi } from "../api.ts";
import type { AgentHandleApi, AgentsApi } from "./api.ts";
import type { AgentCatalogState } from "./catalog.ts";
import { appendMessage } from "./message.ts";
import { agentRecent } from "./recent.ts";
import { AGENTS_PATH } from "./install.ts";

/** THE MIND'S OWN AGENT (catalog.ts `AgentCollectionDurableObject.agent`). Its code is in the
 *  mind's config repo, and the platform runs none of it: the collection only appends its facts.
 *  - `kind`: what the agent's own start writes on `/agents` as its kind.
 *  - `startEvents(path, { parent })`: the facts that make the context at `path` run the agent, each
 *    with an idempotency key, so appending them again writes nothing. With `parent`, they hold the
 *    link from the context's `itx` to that context; without, they hold none. */
export type OwnAgent = {
  kind: string;
  startEvents(
    path: string,
    options: { parent?: string },
  ): Promise<StreamEventInput[]> | StreamEventInput[];
};

/** The kind of a context that an agent of the platform ran (the header). */
const FORMER_KIND = "iterate";

/** The rows that copied such an agent's facts to `/agents`. The mind's own agent has rows of its
 *  own for that, under other names. */
const FORMER_ROWS = ["catalog-kind", "catalog-summary", "catalog-first-words", "catalog-status"];

/** The catalog on `/agents` (catalog.ts) through the log's head, and the offset it is folded to. */
export type CatalogRead = () => Promise<{ offset: number; state: AgentCatalogState }>;

/** How long `create` waits for a new agent to be listed: its context announces itself to
 *  `/agents` when it first wakes, which `create` has just made it do. */
const LISTED_WAIT_MS = 10_000;

/** `itx.agents` (api.ts `AgentsApi`) over one base: the root's at `/`, an agent's own at its
 *  path (`at(base)`, catalog.ts). */
export class AgentCollectionRpcTarget extends RpcTarget implements AgentsApi {
  private readonly getItx: () => IterateContextApi & Disposable;
  private readonly catalogRead: CatalogRead;
  private readonly base: string;
  private readonly own: OwnAgent | undefined;

  constructor(
    getItx: () => IterateContextApi & Disposable,
    catalog: CatalogRead,
    base = "/",
    own?: OwnAgent,
  ) {
    super();
    this.getItx = getItx;
    this.catalogRead = catalog;
    this.base = base;
    this.own = own;
  }

  private async catalog() {
    return (await this.catalogRead()).state;
  }

  get(path: string) {
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    return new AgentReference(this.getItx, path, () => this.catalog(), this.base, this.own);
  }

  /** Every agent, by path: every context under `/agents`, with what a list shows about it. It reads
   *  only the catalog on `/agents` (catalog.ts); reading the agents themselves would wake every
   *  one. */
  async list() {
    return Object.entries((await this.catalog()).agents).map(([path, row]) => ({
      path,
      createdAt: row.createdAt,
      parent: row.parent || null,
      kind: row.kind || null,
      host: row.host || null,
      status: row.status || null,
      activity: row.activity || null,
      description: row.description || null,
      title: row.title || null,
      lastActivityAt: row.lastActivityAt || null,
    }));
  }

  /** Until the catalog lists `path`, a context under `/agents`: its own announcement lands there
   *  when it first wakes, a moment after the call that woke it. Bounded: one that has not landed by
   *  LISTED_WAIT_MS is logged and left to land on the context's next wake (core/itx's
   *  `announceToAncestors` retries it then), so the agent `create` made is not refused for it. */
  async #untilListed(path: string) {
    if (!path.startsWith(`${AGENTS_PATH}/`)) return;
    const { offset, state } = await this.catalogRead();
    if (state.agents[path] || state.deleted[path]) return;
    using itx = this.getItx();
    try {
      await itx.cd(AGENTS_PATH).waitForEvent({
        type: "events.iterate.com/itx/child-created",
        payload: { childPath: path },
        afterOffset: offset,
        timeoutMs: LISTED_WAIT_MS,
      });
    } catch (error) {
      if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
      console.warn({
        event: "agent-collection.not-listed",
        message: "the agent's context has not announced itself to /agents yet",
        path,
        waitedMs: LISTED_WAIT_MS,
      });
    }
  }

  /** START THE MIND'S OWN AGENT at `path`: its start facts and this collection's row for it, in
   *  ONE append. Every fact has a key, so a second create writes nothing. Nothing is waited for
   *  but the listing: the agent runs once its facts are in the log. A deleted agent is not
   *  re-creatable, and a mind whose config names no agent has none to start: both are thrown. Data
   *  back, never the handle: `itx.agents.get(path)` addresses it. */
  async create(path: string) {
    using itx = this.getItx();
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    // The parent link goes to this collection's base — the context whose own `itx.agents` row
    // reached it — and never to a context `create` names. The base itself is still the caller's
    // to choose through the public `at(base)`, and the root's is `/` for every context linked to
    // it. The link does NOT bind the child to the creator's masks: the child's own `cd` and roots
    // of every context answer from its own table, so only a bare `itx => null` on the child holds
    // its code (core/itx/src/context/parent-rule-and-child.test.ts).
    const creator = resolveContextPath("/", this.base);
    // Writing a parent link on an ancestor would point back down to its child.
    if (creator.startsWith(`${path}/`))
      throw codedError("FORBIDDEN", "An agent cannot create its own ancestor");
    if (!this.own)
      throw new Error(
        "this mind's config names no agent to start: its agents.ts sets `AgentCollectionDurableObject.agent = { kind, startEvents }` (core/configs/default/agents.ts)",
      );
    const catalog = await this.catalog();
    if (catalog.deleted[path]) throw new Error(`agent ${path}: deleted — not re-creatable`);
    const kind = catalog.agents[path]?.kind || null;
    await itx.cd(path).append(...(await ownStart(this.own, path, kind, creator)));
    await this.#untilListed(path);
    return { path };
  }

  /** Take the agent at `path` out of being. Its death goes on `/agents` first, so a verb that
   *  follows refuses. Then, for the mind's own agent, every row that its start enables goes, and
   *  each facet with its storage. An agent of another kind hosts nothing here: its death is the
   *  certificate alone. Idempotent: a second delete finds the rows that are left. An agent under
   *  `/agents` that the catalog never listed has nothing to delete: thrown. Terminal: a deleted
   *  agent is not re-creatable. */
  async delete(path: string) {
    using itx = this.getItx();
    path = resolveContextPath(this.base, path);
    if (path === "/") throw new Error("An agent needs its own context path");
    const catalog = await this.catalog();
    const row = catalog.agents[path];
    if (!catalog.deleted[path] && !row && path.startsWith(`${AGENTS_PATH}/`))
      throw codedError("NOT_CREATED", `agent ${path}: not created — nothing to delete`, { path });
    // Unkeyed: the catalog's fold of a death is idempotent.
    if (!catalog.deleted[path])
      await itx
        .cd(AGENTS_PATH)
        .append({ type: "events.iterate.com/agent/deleted", payload: { path } });
    if (!this.own || (row?.kind && row.kind !== this.own.kind && row.kind !== FORMER_KIND))
      return { path };
    const context = itx.cd(path);
    const started = new Set((await this.own.startEvents(path, {})).flatMap(rowNameOf));
    // Over the loopback stub the list's answer types as an RPC result, not the rows the context
    // declares; the wire copied it.
    const hosted = (await context.processors.list()) as unknown as { name: string }[];
    for (const { name } of hosted) if (started.has(name)) await context.processors.disable(name);
    return { path };
  }
}

/** THE FACTS THAT START THE MIND'S OWN AGENT at `path`, whose row on `/agents` says `kind`, with
 *  this collection's own row for it: `itx.agents` as that agent sees it, so a message it sends
 *  names it as the sender.
 *  - A path with no kind is a birth: the facts hold the link from its `itx` to `parent`.
 *  - A path with the mind's own kind, or the former kind (a take-over), has its link since its
 *    birth. None is written, so no later call links an agent to another parent.
 *  - A path where another kind of agent runs is refused.
 *
 *  A TAKE-OVER needs nothing more than the start facts and four rows switched off. The start's
 *  row for the agent has the name the former agent's row had (`agent`), so it replaces that row.
 *  The former copy rows have other names than the own agent's: they go, or each summary and each
 *  first word would be copied to `/agents` twice. The mind's own agent reads nothing of the log
 *  that stands before its start (core/configs/default/agent/contract.ts). */
async function ownStart(
  own: OwnAgent,
  path: string,
  kind: string | null,
  parent?: string,
): Promise<StreamEventInput[]> {
  if (kind && kind !== own.kind && kind !== FORMER_KIND)
    throw codedError("FORBIDDEN", `agent ${path}: an agent of the kind ${kind} runs there`, {
      path,
    });
  return [
    ...(kind === FORMER_KIND
      ? FORMER_ROWS.map((name) => ({
          type: "events.iterate.com/itx/subscription-configured",
          idempotencyKey: `agent-row-off:${name}:${path}`,
          payload: { name, target: null },
        }))
      : []),
    ...(await own.startEvents(path, kind ? {} : { parent })),
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      idempotencyKey: `agent-collection:${path}`,
      payload: { match: "itx.agents", target: `itx.cd('/').agents.at(${JSON.stringify(path)})` },
    },
  ];
}

/** The name of the row that a start fact configures, if it configures one. */
function rowNameOf(event: StreamEventInput): string[] {
  if (event.type !== "events.iterate.com/itx/subscription-configured") return [];
  const name = (event.payload as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? [name] : [];
}

/** `recent()`'s window: 5 minutes by default, at most a day. */
const RECENT_MINUTES = { default: 5, max: 1_440 };
/** `recent()`'s lines: 30 by default, at most 200. */
const RECENT_LINES = { default: 30, max: 200 };
/** `recent()` reads from this many offsets before the newest one the catalog copied from the
 *  agent's log (an ephemeral frame takes an offset too, and is not read), in pages of 1,000
 *  durable events, at most four of them. */
const RECENT_LOOKBACK = 3_000;

/** `itx.agents.get(path)` (api.ts `AgentHandleApi`): the agent at one path, reached from the
 *  collection's base. */
class AgentReference extends RpcTarget implements AgentHandleApi {
  private readonly getItx: () => IterateContextApi & Disposable;
  private readonly path: string;
  private readonly catalog: () => Promise<AgentCatalogState>;
  private readonly base: string;
  private readonly own: OwnAgent | undefined;

  constructor(
    getItx: () => IterateContextApi & Disposable,
    path: string,
    catalog: () => Promise<AgentCatalogState>,
    base: string,
    own?: OwnAgent,
  ) {
    super();
    this.getItx = getItx;
    this.path = path;
    this.catalog = catalog;
    this.base = base;
    this.own = own;
  }

  /** Words for the agent: ONE `agent/message-received` appended to its context (message.ts
   *  `appendMessage`), for every kind. A dead agent refuses from the catalog, and so does a path
   *  under `/agents` that it does not list: neither context is called. The sender rides in the
   *  payload as the base, which the sender's own `itx.agents` row pins
   *  (`itx.cd('/').agents.at(<sender>)`, written by `create`); `/`, every context that reaches the
   *  root's collection, is no sender. The attachments go to the mind's files by the two rows
   *  `installAgents` writes on `/agents`.
   *
   *  THE MIND'S OWN AGENT GETS ITS START FACTS IN THE SAME APPEND, before the words. So a context
   *  of the former kind is taken over here, and a publish of new agent code reaches an agent at
   *  its next message. An agent of another kind gets the words alone, and its own subscription
   *  delivers them. */
  async message(...[input, options]: Parameters<AgentHandleApi["message"]>) {
    const path = this.path;
    const catalog = await this.catalog();
    if (catalog.deleted[path]) throw new Error(`agent ${path}: deleted`);
    const row = catalog.agents[path];
    if (!row && path.startsWith(`${AGENTS_PATH}/`))
      throw codedError(
        "NOT_CREATED",
        `agent ${path}: not created — itx.agents.create(${JSON.stringify(path)}) first`,
        { path },
      );
    const kind = row?.kind;
    const start =
      this.own && (kind === this.own.kind || kind === FORMER_KIND)
        ? await ownStart(this.own, path, kind)
        : [];
    return await appendMessage(
      this.getItx,
      path,
      (itx) => itx.cd(path),
      input,
      this.base === "/" ? undefined : this.base,
      options,
      start,
    );
  }

  /** What the agent did lately (api.ts `AgentRecent`): its catalog row, and a slice of its log
   *  folded by recent.ts. The log has no read from its end, so the slice starts RECENT_LOOKBACK
   *  offsets before the newest offset the catalog copied from it (its last status, activity or
   *  title, near the head for an agent at work) and reads forward to the head, at most four pages
   *  of 1,000 events. It reads the log alone: no agent wakes, only its context. A dead or unlisted
   *  agent refuses, as `message` does. */
  async recent(options: Parameters<AgentHandleApi["recent"]>[0] = {}) {
    const path = this.path;
    const catalog = await this.catalog();
    if (catalog.deleted[path]) throw new Error(`agent ${path}: deleted`);
    const row = catalog.agents[path];
    if (!row && path.startsWith(`${AGENTS_PATH}/`))
      throw codedError("NOT_CREATED", `agent ${path}: not created`, { path });
    const bounded = (value: number | undefined, { default: fallback, max }: typeof RECENT_LINES) =>
      Math.min(Math.max(1, Math.floor(value ?? fallback)), max);
    const minutes = bounded(options.minutes, RECENT_MINUTES);
    const limit = bounded(options.limit, RECENT_LINES);
    const newest = Math.max(0, row?.titleAtOffset || 0, ...Object.values(row?.fieldAtOffset || {}));
    const events: StreamEvent[] = [];
    let after = Math.max(0, newest - RECENT_LOOKBACK);
    using itx = this.getItx();
    for (let page = 0; page < 4; page += 1) {
      const read = await itx.cd(path).readEvents(after, 1_000);
      events.push(...read.events);
      if (read.atHead || read.events.length === 0) break;
      after = read.scannedThroughOffset;
    }
    return {
      path,
      title: row?.title || null,
      status: row?.status || null,
      activity: row?.activity || null,
      description: row?.description || null,
      ...agentRecent(events, {
        since: new Date(Date.now() - minutes * 60_000).toISOString(),
        limit,
        // the mind's own agent reads its words in as `context-added`; a context of the former
        // kind is its own at the next message
        own: row?.kind === FORMER_KIND || (!!this.own && row?.kind === this.own.kind),
      }),
    };
  }
}
