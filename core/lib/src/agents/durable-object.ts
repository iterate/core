// durable-object.ts — one agent's facet, loaded into a project through the public SDK: the processor
// (processor.ts) and `message()`, a person's words.
import { codedError } from "../lib.ts";
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { AgentHandleApi } from "./api.ts";
import { type AgentInputGate, appendMessage } from "./message.ts";
import type { AgentState } from "./contract.ts";
import { type AgentConfigPatch, AgentProcessor } from "./processor.ts";

// Not `implements Pick<AgentHandleApi, "message">`: the facet's `message` takes the sender (the
// collection's base) between the published input and its options (collection.ts relays all three).
export class AgentDurableObject extends StreamProcessorDurableObject<AgentState> {
  /** The processor's reads, and a person's words (`message`) — `itx.agents.get(path).message(…)`
   *  reaches it through the collection (collection.ts). */
  static override publicMethods = [...super.publicMethods, "message"];

  /** The project's gate on words another agent sends without `trigger: false`, which the
   *  processor applies on the receiving side (message.ts `AgentInputGate`): a config repo's
   *  `agents.ts` sets it. None: every such message is a trigger, as before. */
  static messageGate: AgentInputGate | undefined;

  /** The Markdown files of the config repo an agent reads as standing instructions, which a
   *  config repo's `agents.ts` may change: it gets the agent's path and the default list
   *  (standing-instructions.ts) and answers the list to use. None: the default. */
  static standingFiles: ((path: string, files: string[]) => string[]) | undefined;

  /** The configuration every agent born in this project starts with, as an `agent/configured`
   *  patch (`llm.apiKeys` of a project that brings its own credentials, say). Appended at birth,
   *  before the certificate; an agent born earlier keeps what its log holds. None: the contract's
   *  defaults. */
  static defaultConfig: AgentConfigPatch | undefined;

  processor = new AgentProcessor({
    getItx: () => this.getItx(),
    messageGate: () => AgentDurableObject.messageGate,
    standingFiles: () => AgentDurableObject.standingFiles,
    defaultConfig: () => AgentDurableObject.defaultConfig,
  });

  /** The context this facet is hosted on IS the agent: its path is the one name it goes by, here
   *  and under `itx.files` (attachments are stored beneath it). Read once per incarnation. */
  #pathRead?: string;
  async #path(): Promise<string> {
    if (this.#pathRead) return this.#pathRead;
    using itx = this.getItx();
    const { path } = await itx.whoami();
    return (this.#pathRead = path);
  }

  /** A person's words: ONE `context-added`, the trigger of the next turn — with their attachments,
   *  each stored first under this agent's path (`itx.files`, `<path>/<8 of a uuid>-<name>`)
   *  and named on the event; an image among them is what the model will see. `from` is the
   *  collection's base, which it relays as the sender (collection.ts `AgentReference.message`).
   *  `{ trigger: false }` makes the words context only. Otherwise words from another agent pass the
   *  project's gate, if any, once they are in the log (processor.ts, `agent/input-gated`). The event
   *  is answered so a caller can wait for what follows it. */
  async message(
    input: Parameters<AgentHandleApi["message"]>[0],
    from?: string,
    options?: Parameters<AgentHandleApi["message"]>[1],
  ) {
    const path = await this.#created();
    return await appendMessage(
      () => this.getItx(),
      path,
      (itx) => itx,
      input,
      from,
      options,
    );
  }

  /** Every verb starts here: an agent whose certificate has not landed refuses, and so does one
   *  whose deletion has been asked for. Deletion can land at any moment, so the state is read on
   *  every call (in memory once the facet is caught up). */
  async #created(): Promise<string> {
    const path = await this.#path();
    const { state } = await this.snapshot();
    if (state.deletion) throw new Error(`agent ${path}: deleted`);
    if (state.creation?.status !== "created")
      throw codedError(
        "NOT_CREATED",
        `agent ${path}: not created — itx.agents.create(${JSON.stringify(path)}) first`,
        { path },
      );
    return path;
  }
}
