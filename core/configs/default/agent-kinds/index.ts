// agent-kinds/index.ts — THE KINDS OF AGENT THIS MIND RUNS (agent-kinds.md).
//
// Each kind is one file of this folder. Its `processEvent` runs beside the integration packages'
// (every-event.ts), and every publish tells the Dash where each kind's file is (init.ts):
// `kindsForTheDash`.
import type { IterateContextApi } from "iterate/api";
import { makeAgentKind } from "iterate/agents/kinds";
import { z } from "zod";

// The kinds of agent this mind runs (agent-kinds.md): one file each, named by its
// import, written exactly `() => import("./path/to/kind.ts")` (`makeAgentKind` reads the path from
// it, and resolves it against this file's `import.meta`).
/** The mind's own agent (agent-kinds.md, "The kind `agent`"). Its `processEvent` runs in every
 *  mind. The Dash is told where its file is in a new mind only (`kindsForTheDash`). */
const ownAgentKind = makeAgentKind(import.meta, () => import("./agent.ts"));

export const agentKinds = [makeAgentKind(import.meta, () => import("./iterate.ts")), ownAgentKind];

/** The mind's KV key of the choice below: "yes" or "no". */
const NEW_CHATS_KEY = "config:new-chats-are-the-agent";
/** Where the Dash reads each kind's file (iterate/agents/kinds `publishAgentKinds`), and what is
 *  there: each kind's name and its file's path. */
const KINDS_KEY = "agent-kinds";
const KindFiles = z.record(z.string(), z.string());

/** NEW MINDS ONLY: is a person's new chat in the Dash the kind `agent`? The Dash's New agent
 *  starts that kind where it knows the kind's file, and `kindsForTheDash` names the file only when
 *  this answers true. The choice is made ONCE, at the first publish that has this code, and kept
 *  in the mind's KV:
 *    - a mind that told the Dash its kinds before it had this kind existed before it: "no";
 *    - a mind at its first publish, and a mind that was born with this kind: "yes".
 *  An owner changes it with `itx.kv.put("config:new-chats-are-the-agent", "yes")` or `"no"`; the
 *  next publish tells the Dash. */
async function newChatsAreTheAgent(itx: Pick<IterateContextApi, "kv">): Promise<boolean> {
  const kept = await itx.kv.get(NEW_CHATS_KEY);
  if (kept === "yes" || kept === "no") return kept === "yes";
  const existedBefore = !toldOfTheAgent(await itx.kv.get(KINDS_KEY));
  await itx.kv.put(NEW_CHATS_KEY, existedBefore ? "no" : "yes");
  return !existedBefore;
}

/** The Dash was never told of a kind (the mind's first publish), or it was told of this one. */
function toldOfTheAgent(kinds: string | null): boolean {
  if (!kinds) return true;
  try {
    return Boolean(KindFiles.parse(JSON.parse(kinds)).agent);
  } catch {
    return false; // a list that cannot be read is an older mind's
  }
}

/** The kinds whose files the Dash is told of at a publish (init.ts): every kind, and the kind
 *  `agent` in a new mind only. */
export async function kindsForTheDash(itx: Pick<IterateContextApi, "kv">) {
  if (await newChatsAreTheAgent(itx)) return agentKinds;
  return agentKinds.filter((kind) => kind !== ownAgentKind);
}
