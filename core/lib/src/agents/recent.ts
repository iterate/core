// recent.ts — `itx.agents.get(path).recent()` (api.ts `AgentRecent`): what one agent did lately,
// folded from a slice of its own log. collection.ts reads the slice; this file only folds it, so a
// test needs no context. Every kind of agent is read the same way: an event type its log does not
// have is simply absent, and a field it cannot read (a raw log can hold any payload) is skipped.
import type { StreamEvent } from "../stream/processor.ts";
import type { AgentDidKind, AgentRecent } from "./api.ts";

/** A `did` line is cut to this many characters. */
const DID_CHARS = 300;

/** The script of an answer of a mind's own agent: everything between the first line, `<codemode>`,
 *  and the last `</codemode>` line. */
const CODEMODE_BLOCK = /^\s*<codemode>[ \t]*\n([\s\S]*)\n[ \t]*<\/codemode>\s*$/;

/** The window's lines and newest script, from `events` in offset order. `own` says which event
 *  is the words in: the input of the mind's own agent, `context-added` (a person's words, mail, a
 *  schedule's input, all one type), or, for another kind, the `message-received` it is sent. */
export function agentRecent(
  events: Pick<StreamEvent, "offset" | "path" | "type" | "payload" | "createdAt" | "source">[],
  { since, limit, own }: { since: string; limit: number; own: boolean },
): Pick<AgentRecent, "did" | "lastScript"> {
  const did: AgentRecent["did"] = [];
  const add = (at: string, what: AgentDidKind, text: string) => {
    if (at < since) return;
    const line = text.replace(/\s+/g, " ").trim();
    if (line)
      did.push({
        at,
        what,
        text: line.length > DID_CHARS ? `${line.slice(0, DID_CHARS - 1)}…` : line,
      });
  };
  /** The script of the newest answer, which the next run the agent requests runs. */
  let call: { status: string; script: string } | null = null;
  const scripts = new Map<number, NonNullable<AgentRecent["lastScript"]>>();
  let lastScript: AgentRecent["lastScript"] = null;
  // the events before `since` are read too: an answer's call may precede its run in the window
  for (const event of events) {
    const payload = fields(event.payload);
    const text = (key: string) => textOf(payload, key);
    const origin = textOf(fields(event.source), "origin");
    switch (event.type) {
      case "events.iterate.com/agent/summary-updated": {
        add(event.createdAt, "status", text("activity"));
        const waitingFor = text("waitingFor").replace("_", " ");
        add(
          event.createdAt,
          "summary",
          [text("title"), waitingFor && `waiting for ${waitingFor}`, text("description")]
            .filter(Boolean)
            .join(" — "),
        );
        break;
      }
      case "events.iterate.com/agent/context-added": {
        const from = text("from") || (origin !== event.path && origin);
        if (own && text("role") === "user")
          add(event.createdAt, "message-in", `${from ? `[from ${from}] ` : ""}${text("content")}`);
        break;
      }
      case "events.iterate.com/agent/message-received":
        if (!own)
          add(
            event.createdAt,
            "message-in",
            `${text("from") ? `[from ${text("from")}] ` : ""}${text("message")}`,
          );
        break;
      // words out: the words of the mind's own agent in the web or mobile UI
      case "events.iterate.com/agent-ui/message-sent":
        add(event.createdAt, "message-out", text("message"));
        break;
      // a mind's own agent answers with one `<codemode>` block, which the next run it requests runs
      case "events.iterate.com/llm-request/settled": {
        const script = CODEMODE_BLOCK.exec(textOf(fields(payload.result), "text"))?.[1];
        if (script?.trim()) call = { status: "", script };
        break;
      }
      // the agent's own run (the engine stamps it with the processor) runs the newest answer's script
      case "events.iterate.com/itx/run-requested": {
        if (textOf(fields(fields(event.source).processor), "slug") !== "agent" || !call) break;
        const ran = { at: event.createdAt, ...call };
        call = null;
        if (event.createdAt < since) break;
        add(event.createdAt, "script", ran.script.split("\n").find((line) => line.trim()) || "");
        scripts.set(event.offset, ran);
        lastScript = ran;
        break;
      }
      case "events.iterate.com/itx/run-settled": {
        const settlement = fields(payload.settlement);
        const script = scripts.get(Number(payload.requestOffset));
        if (script && settlement.status === "failed")
          script.error = textOf(settlement, "error") || "failed";
        break;
      }
    }
  }
  return { did: did.slice(-limit), lastScript };
}

/** A value's own fields when it is an object, else none: an event of a raw log may hold anything. */
function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value ? Object.fromEntries(Object.entries(value)) : {};
}

function textOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}
