// agent-kinds/index.ts — THE KINDS OF AGENT THIS MIND RUNS (agent-kinds.md).
//
// Each kind is one file of this folder. Its `processEvent` runs beside the integration packages'
// (every-event.ts), and every publish tells the Dash where each kind's file is (init.ts).
import { makeAgentKind } from "iterate/agents/kinds";

// The kinds of agent this mind runs (agent-kinds.md): one file each, named by its
// import, written exactly `() => import("./path/to/kind.ts")` (`makeAgentKind` reads the path from
// it, and resolves it against this file's `import.meta`).
export const agentKinds = [makeAgentKind(import.meta, () => import("./iterate.ts"))];
