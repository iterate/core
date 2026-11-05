// src/integrations/flows.ts — THE CONNECT FLOWS a deployment serves (connect-flow.ts): each one's
// callback is `GET /api/integrations/<name>/callback`, and its start link names it. Adding a flow is
// one entry here.
import type { ConnectFlow } from "./connect-flow.ts";
import { githubConnectFlow } from "./github.ts";

export const CONNECT_FLOWS: Record<string, ConnectFlow> = { github: githubConnectFlow };

/** The flow named `name`, refused for any other. */
export function connectFlowOf(name: unknown): ConnectFlow {
  const flow =
    typeof name === "string" && Object.hasOwn(CONNECT_FLOWS, name) ? CONNECT_FLOWS[name] : null;
  if (!flow) throw new Error(`no connect flow ${JSON.stringify(name)}`);
  return flow;
}
