// recent.ts — `itx.agents.get(path).recent()` (api.ts `AgentRecent`): what one agent did lately,
// folded from a slice of its own log. collection.ts reads the slice; this file only folds it, so a
// test needs no context. Every kind of agent is read the same way: an event type its log does not
// have is simply absent, and a field it cannot read (a raw log can hold any payload) is skipped.
import type { StreamEvent } from "../stream/processor.ts";
import type { AgentDidKind, AgentRecent } from "./api.ts";

/** A `did` line is cut to this many characters. */
const DID_CHARS = 300;

/** The window's lines and newest script, from `events` in offset order. `iterate` says which
 *  event is the words in: an iterate agent's own `context-added` (a person's words, mail, a
 *  schedule's input, all one type), or, for another kind, the `message-received` it is sent. */
export function agentRecent(
  events: Pick<StreamEvent, "offset" | "path" | "type" | "payload" | "createdAt" | "source">[],
  { since, limit, iterate }: { since: string; limit: number; iterate: boolean },
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
  /** The newest answer's call, which the next run the loop requests runs. */
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
        const role = text("role");
        const from = text("from") || (origin !== event.path && origin);
        // the loop's own mind-now note is no words in (processor.ts `#noteTheMind`)
        if (iterate && role === "user" && payload.mindSnapshot !== true)
          add(event.createdAt, "message-in", `${from ? `[from ${from}] ` : ""}${text("content")}`);
        const answer = fields(payload.call);
        if (role === "assistant" && textOf(answer, "script"))
          call = { status: textOf(answer, "status"), script: textOf(answer, "script") };
        break;
      }
      case "events.iterate.com/agent/message-received":
        if (!iterate)
          add(
            event.createdAt,
            "message-in",
            `${text("from") ? `[from ${text("from")}] ` : ""}${text("message")}`,
          );
        break;
      case "events.iterate.com/agent/web-message-sent":
        add(event.createdAt, "message-out", text("message"));
        break;
      // the loop's own run (the engine stamps it with the processor) runs the newest answer's call
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
