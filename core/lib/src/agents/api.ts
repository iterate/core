// api.ts — `itx.agents`, the agents app's published type. A project installs the app (install.ts
// mounts the collection facet as the `itx.agents` rewrite rule), so iterate/api does not name it.
// Importing `iterate/agents` registers the root on iterate/api's `InstalledAppRoots`, and a caller
// that knows agents are installed writes `itx as IterateContextApiWith<"agents">`. catalog.ts and
// collection.ts implement it.
import type { StreamEvent } from "../stream/processor.ts";

/** What `agents.get(path).message(input)` takes: the words, or the words with attachments (each
 *  stored under the agent's path in `itx.files` and named on the event). */
export type AgentMessageInput =
  | string
  | {
      message: string;
      files?: { contentType: string; filename: string; data: Uint8Array | ArrayBuffer | string }[];
    };

/** How `message` delivers the words. `trigger: false` makes them context only: the agent reads
 *  them on its next turn but does not wake for them (an FYI that needs nothing now). The default,
 *  `trigger: true`, starts a turn, unless the project gates words between agents (message.ts). */
export type AgentMessageOptions = { trigger?: boolean };

/** `itx.agents.get(path)`: one agent. Anything else on its context is a plain
 *  `itx.cd(path).append(…)`, stamped with where it came from. */
export interface AgentHandleApi {
  /** A person's words: ONE `events.iterate.com/agent/message-received`, the input every kind of
   *  agent reads, answered so a caller can wait for what follows it. An iterate agent turns it into
   *  its own `context-added`, the trigger of its next turn (or, with `{ trigger: false }`, context
   *  it reads on that turn). Sent from another agent, the model reads them as
   *  `[from <sender's context>]` — the collection's base, which the sender's own `itx.agents` row
   *  pins (collection.ts); from anywhere else they read as a person's. To an agent that is not
   *  iterate's own, the same event is appended to its context, for its own subscription to
   *  deliver. A deleted agent refuses, and so does one never created (NOT_CREATED). */
  message(input: AgentMessageInput, options?: AgentMessageOptions): Promise<StreamEvent>;
}

/** One row of `itx.agents.list()`. */
export type AgentListing = {
  path: string;
  createdAt: string;
  parent: string | null;
  kind: string | null;
  host: string | null;
  status: "working" | "idle" | "waiting" | "ended" | null;
  activity: string | null;
  description: string | null;
  title: string | null;
  lastActivityAt: string | null;
};

/** `itx.agents` — installed by rewrite rule on the project's root and on each agent's context.
 *  `create` and `delete` are sagas on the agent's path (a deleted agent is not re-creatable; a
 *  `delete` of an agent never created refuses, NOT_CREATED). `delete` of an agent that is not
 *  iterate's own only records its death on `/agents`. */
export interface AgentsApi {
  /** Every agent, with what a list shows about it. An agent is any context under `/agents`, at any
   *  depth: an iterate agent `create` made, a coding session a bridge appends to, anything. `parent`
   *  is the nearest agent above it (null at the top). `kind` is what runs it (`"iterate"`,
   *  `"claude"`, …) and `host` the machine it runs on. `status` is `working`, `idle`, `waiting` (on
   *  someone) or `ended`; `activity` one line on what it is doing now, and `description` a few
   *  sentences on its purpose or conclusions. `title` is the name it gave itself, or else the first
   *  line a person sent it. `lastActivityAt` is when it was last active. Each is null until the
   *  agent has said it. It reads only `/agents` and wakes no agent, so use it to show many agents
   *  rather than reading each one. */
  list(): Promise<AgentListing[]>;
  get(path: string): AgentHandleApi;
  create(path: string): Promise<{ path: string }>;
  delete(path: string): Promise<{ path: string }>;
}

/** The root's own `itx.agents` (catalog.ts `AgentCollectionDurableObject`), as code holding the
 *  root's scope reaches it. */
export interface AgentsRootApi extends AgentsApi {
  /** The collection as the context `base` sees it: what it creates is linked to `base`, and a
   *  relative path means `base`'s (collection.ts). Each agent's own `itx.agents` row is the root's
   *  `at(<agent>)`; root code acting for another context passes that context, as voice's
   *  `setupVoiceAgent` does. */
  at(base: string): AgentsApi;
}

declare module "iterate/api" {
  interface InstalledAppRoots {
    agents: AgentsApi;
  }
}
