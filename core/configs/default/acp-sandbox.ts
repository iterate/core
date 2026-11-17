// acp-sandbox.ts — `itx.acp.sandbox`, the sandbox runner (acp-sandbox/runner.ts says what it does).
// A root rule loads this module from the published config (acp-sandbox/runner.ts `install`), as a
// lend would be: a session's delivery row targets its `deliverEvent`, which on a config entrypoint
// is the platform's delivery hook, and runs `processEvent` with the mind's scope. At the repo's
// root, where the rule's `mainModule` names it.
import { IterateConfigEntrypoint, type IterateConfigProcessEventArgs } from "iterate/sdk";
import { deliverEvent, start } from "./acp-sandbox/runner.ts";

export default class AcpSandbox extends IterateConfigEntrypoint {
  /** One event from a session's delivery row, to the host in its sandbox. */
  async processEvent({ event, itx }: IterateConfigProcessEventArgs) {
    await deliverEvent(itx, event);
  }

  /** Start a session of `agent` (claude, codex, opencode) in a sandbox of its own: its path.
   *  `model`: one of the agent's own models; none: its first. */
  async start(agent: string, model?: string) {
    using itx = this.getItx();
    return await start(itx, agent, model);
  }
}
