// agent-kinds/acp.ts — any coding agent that speaks the Agent Client Protocol (opencode, Codex,
// Claude Code, Gemini CLI, …) as a kind of agent. Copy this file to a mind's config repo as
// `agent-kinds/acp.ts` and name it in worker.ts's `agentKinds`; this one
// (internal-packages/acp-bridge) is the source of truth.
//
// A RUNNER runs the agents: `itx.acp.<name>`, with `deliverEvent` and `start` (README.md). A
// computer's is lent with `iterate provide` (`acp.zaktop`, say); the sandbox's, `acp.sandbox`, is
// the config repo's own and runs each session in a sandbox of its own. A session lives at
// `/agents/acp/<id>`:
//
//   someone appends `acp/session-start-requested { agent, runner }` (the Agents app's New agent,
//   through this file's `newAgent`, or a runner's `start`)
//   → this file's `processEvent` gives the context its rows: a delivery row to that runner, and the
//     copy rows that list it in the catalog
//   → the delivery row hands the request to the runner, which spawns the agent and appends
//     `acp/session-started`
//   → each `agent/message-received` (`itx.agents.get(path).message()`) is delivered too, and the
//     runner sends it as `session/prompt`. What the agent says streams back as ephemeral
//     `acp/update-frame`s, and every other `session/update` (tool calls, plans) and each finished
//     piece of text lands as a durable `acp/update-received`. `acp/turn-ended` closes the turn.
//   → a `session/request_permission` is `acp/permission-requested`; this file's view answers it
//     with `acp/permission-settled`, delivered back to the runner.
//   → an event the runner never takes (away for the platform's whole retry ladder) is the row's
//     `itx/subscription-delivery-failed`: the runner isn't answering.
//
// The view folds that log into a chat: what was said (streaming as it is written), thoughts, tool
// calls updated in place by `toolCallId`, the latest plan, permission asks with a button per
// option, and what the agent is doing now.
import type {
  AgentKind,
  AgentKindViewKit,
  AgentKindViewProps,
} from "@iterate-com/ui/agent-kind-view";

/** Every event type of a session's log, by its short name. */
export const ACP = {
  sessionStartRequested: "events.iterate.com/acp/session-start-requested",
  sessionStarted: "events.iterate.com/acp/session-started",
  sessionStartFailed: "events.iterate.com/acp/session-start-failed",
  updateFrame: "events.iterate.com/acp/update-frame",
  updateReceived: "events.iterate.com/acp/update-received",
  turnEnded: "events.iterate.com/acp/turn-ended",
  turnCancelRequested: "events.iterate.com/acp/turn-cancel-requested",
  permissionRequested: "events.iterate.com/acp/permission-requested",
  permissionSettled: "events.iterate.com/acp/permission-settled",
  sessionEndRequested: "events.iterate.com/acp/session-end-requested",
  sessionEnded: "events.iterate.com/acp/session-ended",
  /** A step of the runner's own start, copied from the sandbox's log (acp-sandbox/runner.ts
   *  `progressRow`): `{ step: "sandbox-created" | "sandbox-started" | "command-started" |
   *  "command-finished", from?, command?, exitCode?, durationMs?, said? }`. */
  runnerProgressed: "events.iterate.com/acp/runner-progressed",
  /** The session's agent committed to the mind's config repo with its `commit` tool
   *  (sandbox-tools/mind-tools.ts): `{ commitOid, paths, published, error? }`. Its `run` tool leaves
   *  the platform's own `itx/run-requested` and how it settled on the session's log. */
  mindCommitted: "events.iterate.com/acp/mind-committed",
} as const;
const MESSAGE_RECEIVED = "events.iterate.com/agent/message-received";
const DELIVERY_FAILED = "events.iterate.com/itx/subscription-delivery-failed";
/** The delivery row's name (`deliveryRow`), which its dead letters carry. */
const DELIVERY_ROW = "acp-delivery";

/** The agents a runner's launch table has (src/agents.ts), for New agent. */
export const AGENTS = ["claude", "codex", "opencode"];

/** THE MODELS EACH AGENT MAY RUN, which New agent offers as a list, the first the one it opens
 *  with. The launch table's own (src/agents.ts `models`; a test compares them): a runner refuses a
 *  start that names any other. To offer another model, add it in both. */
export const MODELS: Record<string, string[]> = {
  claude: ["haiku", "sonnet", "opus"],
  codex: ["gpt-6.1-terra", "gpt-6.1-sol"],
  opencode: ["gpt-6.1-terra", "gpt-6.1-sol"],
};

/** What New agent says under the Runner field: how to lend a computer as the runner typed. The
 *  kind can't see which computers are lent now, so it says how either way. */
export function describeRunner(runner: string, mind: string): string | null {
  if (runner === "acp.sandbox") return "In a sandbox of its own, made for this session.";
  if (!RUNNER_NAME.test(runner))
    return "A runner's name starts `acp.`: `acp.sandbox`, or a computer's, `acp.<name>`.";
  return `On a computer lent as ${runner}. To lend one, run this on it, from the root of a checkout of iterate/private: \`ACP_RUNNER=${runner} ITERATE_MIND=${mind} internal-packages/acp-bridge/run.sh\`. Its agents work in that folder; \`ACP_RUNNER_CWD\` names another.`;
}

/** The message that turns Remote Control on in a Claude Code session. */
const REMOTE_CONTROL = "/remote-control";
/** WHETHER NEW AGENT'S START SENDS `REMOTE_CONTROL` FIRST: Claude alone, with its box ticked, on
 *  a computer's runner. Never in a sandbox. Claude Code's Remote Control needs a claude.ai login
 *  (https://code.claude.com/docs/en/remote-control: "API keys are not supported", and a
 *  `CLAUDE_CODE_OAUTH_TOKEN` "can only make model requests"), and a sandbox's Claude signs in
 *  with one of those two (acp-sandbox/runner.ts). The box says the same to the picker (`offWhen`
 *  below), which draws it unticked and disabled there. This rule is for a page that does not
 *  know that key and still hands the box in ticked. */
const asksRemoteControl = (choice: string, fields: Record<string, string>) =>
  choice === "claude" && fields.remoteControl === "on" && fields.runner !== "acp.sandbox";

/** What New agent says under the picker: where the agent runs (`describeRunner`), and for Claude
 *  what its Remote control box does on that runner, or why it is off there. */
function describeNewAgent(input: {
  choice: string;
  fields: Record<string, string>;
  mind: string;
}): string | null {
  const runner = describeRunner(input.fields.runner || "", input.mind);
  if (input.choice !== "claude") return runner;
  const say = (remote: string) => [runner, remote].filter(Boolean).join(" ");
  if (input.fields.runner === "acp.sandbox")
    return say(
      "Remote control is off in a sandbox: it needs a claude.ai login, which a sandbox has not.",
    );
  if (!asksRemoteControl(input.choice, input.fields)) return runner;
  return say(
    `Remote control: the agent gets \`${REMOTE_CONTROL}\` before your message, and its answer says where to follow the session.`,
  );
}

/** A session's context. */
export const SESSION_PATH = /^\/agents\/acp\/[A-Za-z0-9_-]{1,64}$/;
/** A runner's name: `acp.` and one identifier, and nothing else, since it is written into the
 *  delivery row's target, which can then only ever be under `itx.acp`. */
export const RUNNER_NAME = /^acp\.[A-Za-z_$][\w$]*$/;

type Event = AgentKindViewProps["context"]["events"][number];

export default {
  kind: "acp",
  processEvent,
  // the Agents app's New agent: "opencode (acp)" and the rest, on the runner named beside them,
  // with the model picked from the agent's own list (`MODELS`: one list field for each agent);
  // Claude has a box more, ticked at first, which sends a computer's Claude `/remote-control`
  // before the person's own message; the sandbox turns the box off (`asksRemoteControl`)
  newAgent: {
    choices: AGENTS.map((agent) => ({ id: agent, label: agent })),
    fields: [
      { name: "runner", label: "Runner", defaultValue: "acp.sandbox" },
      ...AGENTS.map((agent) => ({
        name: "model",
        label: "Model",
        type: "select" as const,
        options: MODELS[agent]!,
        defaultValue: MODELS[agent]![0]!,
        choices: [agent],
      })),
      {
        name: "remoteControl",
        label: "Remote control",
        type: "checkbox",
        defaultValue: "on",
        choices: ["claude"],
        offWhen: { field: "runner", is: "acp.sandbox" },
      },
    ],
    start: ({ choice, fields, path }) => {
      if (!RUNNER_NAME.test(fields.runner || ""))
        throw new Error(`A runner's name starts acp., as in acp.<name>: not "${fields.runner}"`);
      // A page from before the list draws the model as a line of text, where anything can be
      // typed. None named (a script, an older page): the runner runs the agent's first.
      const model = fields.model || undefined;
      if (model && !MODELS[choice]?.includes(model))
        throw new Error(`${choice} runs ${(MODELS[choice] || []).join(", ")}, not ${model}`);
      // keyed by the path: a second start of the same agent lands nothing
      return [
        {
          type: ACP.sessionStartRequested,
          idempotencyKey: `acp/session-start-requested:${path}`,
          payload: { agent: choice, runner: fields.runner, model },
        },
        // a message as a person's: the runner prompts it once the session opens, as its first turn
        ...(asksRemoteControl(choice, fields)
          ? [
              {
                type: MESSAGE_RECEIVED,
                idempotencyKey: `acp/remote-control:${path}`,
                payload: { message: REMOTE_CONTROL },
              },
            ]
          : []),
      ];
    },
    describe: describeNewAgent,
  },
  // every durable event (the Events tab is the whole log) and, named, the frames of the text being
  // written, which a wildcard never matches
  ephemeralEvents: [ACP.updateFrame],
  view: ({ html, useMemo, ui }: AgentKindViewKit) => {
    const append = (props: AgentKindViewProps, event: Record<string, unknown>) =>
      props.onAppend?.([event]);

    const ToolRow = ({ row, props }: { row: ToolRow; props: AgentKindViewProps }) => {
      const marks = { pending: "…", in_progress: "…", completed: "✓", failed: "✗" };
      return html`
        <button
          type="button"
          className="flex w-full items-baseline gap-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick=${() => props.onStateChange({ view: "events", event: row.updatedAt })}
        >
          <span className="rounded bg-muted px-1 font-mono uppercase">${row.toolKind}</span>
          <span className="truncate font-mono">${row.title}</span>
          <span>${marks[row.status]}</span>
          <span className="truncate">${row.output}</span>
        </button>
      `;
    };

    /** The runner's start, a line a step: a spinner while a command runs, then how it ended. */
    const ProgressSteps = ({ steps }: { steps: ProgressStep[] }) => html`
      <ul className="ml-5 mt-1 flex flex-col gap-0.5">
        ${steps.map((step, index) => html`<${ProgressStepRow} key=${index} step=${step} />`)}
      </ul>
    `;

    const WhatItSaid = ({ text }: { text: string }) => html`
      <details>
        <summary className="cursor-pointer">What it said</summary>
        <pre className="whitespace-pre-wrap break-all pt-1">${text}</pre>
      </details>
    `;

    const ProgressStepRow = ({ step }: { step: ProgressStep }) => {
      const mark = step.pending
        ? html`<${ui.Spinner} className="size-3" />`
        : step.failed
          ? "✗"
          : "✓";
      const command = step.command
        ? html` <code className="text-2xs opacity-70">${step.command}</code>`
        : null;
      const said = step.detail ? html`<${WhatItSaid} text=${step.detail} />` : null;
      return html`
        <li className=${step.failed ? "text-destructive" : ""}>
          <span className="inline-flex items-center gap-1">${mark} ${step.text}</span>
          ${command} ${said}
        </li>
      `;
    };

    const PlanRow = ({ row }: { row: PlanRow }) => {
      const marks = { pending: "○", in_progress: "◐", completed: "●" };
      return html`
        <div className="my-1 rounded border px-3 py-2 text-xs">
          <p className="mb-1 font-medium text-muted-foreground">Plan</p>
          ${row.entries.map(
            (entry, index) => html`
              <p
                key=${index}
                className=${entry.status === "completed" ? "text-muted-foreground line-through" : ""}
              >
                ${marks[entry.status]} ${entry.content}
              </p>
            `,
          )}
        </div>
      `;
    };

    const PermissionRow = ({ row, props }: { row: PermissionRow; props: AgentKindViewProps }) => {
      const choose = (optionId: string) =>
        append(props, {
          type: ACP.permissionSettled,
          // the first answer wins: a second click is the same key with another payload, refused
          idempotencyKey: `acp/permission-settled:${row.offset}`,
          payload: { requestOffset: row.offset, outcome: { outcome: "selected", optionId } },
        });
      const button = (option: PermissionRow["options"][number]) => html`
        <${ui.Button}
          key=${option.optionId}
          size="sm"
          variant=${option.kind.startsWith("allow") ? "default" : "outline"}
          disabled=${!props.onAppend}
          onClick=${() => choose(option.optionId)}
        >
          ${option.name}
        </${ui.Button}>
      `;
      const answer = row.chosen
        ? html`<p className="text-xs text-muted-foreground">→ ${row.chosen}</p>`
        : html`<div className="flex flex-wrap gap-2">${row.options.map(button)}</div>`;
      return html`
        <div className="my-2 rounded border border-amber-500/50 px-3 py-2 text-sm">
          <p className="mb-2">May it run <span className="font-mono">${row.title}</span>?</p>
          ${answer}
        </div>
      `;
    };

    const Row = ({ row, props }: { row: AcpRow; props: AgentKindViewProps }) => {
      switch (row.kind) {
        case "said":
          return html`
            <${ui.MessageBubble}
              from=${row.from}
              text=${row.text}
              footer=${row.streaming ? "…" : undefined}
            />
          `;
        case "thought":
          return html`
            <details className="py-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Thinking${row.streaming ? "…" : ""}</summary>
              <p className="whitespace-pre-wrap pt-1">${row.text}</p>
            </details>
          `;
        case "tool":
          return html`<${ToolRow} row=${row} props=${props} />`;
        case "plan":
          return html`<${PlanRow} row=${row} />`;
        case "permission":
          return html`<${PermissionRow} row=${row} props=${props} />`;
        case "notice":
          return html`
            <div className="py-1 text-xs text-muted-foreground">
              <p className="flex items-center gap-2">
                ${row.pending ? html`<${ui.Spinner} className="size-3" />` : null}${row.text}
              </p>
              ${row.steps?.length ? html`<${ProgressSteps} steps=${row.steps} />` : null}
            </div>
          `;
      }
    };

    return function AcpChat(props: AgentKindViewProps) {
      const { rows, status, working } = useMemo(
        () => eventsToRows(props.context.events),
        [props.context.events],
      );
      const stop = html`
        <div className="mb-2 flex justify-end">
          <${ui.Button}
            size="sm"
            variant="outline"
            disabled=${!props.onAppend}
            onClick=${() => append(props, { type: ACP.turnCancelRequested, payload: {} })}
          >
            Stop
          </${ui.Button}>
        </div>
      `;
      const footer = html`
        ${working ? stop : null}
        <${ui.Composer} onMessage=${props.onMessage} placeholder="Message this agent" />
      `;
      return html`
        <${ui.AgentShell} ...${props} status=${status} renderers=${renderers}>
          <${ui.Feed}
            rows=${rows}
            older=${props.context.older}
            empty=${html`<p className="py-16 text-center text-sm text-muted-foreground">Nothing said yet.</p>`}
            renderRow=${(row: AcpRow) => html`<${Row} row=${row} props=${props} />`}
            footer=${footer}
          />
        </${ui.AgentShell}>
      `;
    };
  },
} satisfies AgentKind;

// ── the fold ──

type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
type ToolRow = {
  key: string;
  offset: number;
  kind: "tool";
  toolKind: string;
  title: string;
  status: ToolStatus;
  output: string;
  /** The offset of the newest update: the Events tab opens there. */
  updatedAt: number;
};
type PlanRow = {
  key: string;
  offset: number;
  kind: "plan";
  entries: { content: string; status: "pending" | "in_progress" | "completed" }[];
};
type PermissionRow = {
  key: string;
  offset: number;
  kind: "permission";
  title: string;
  options: { optionId: string; name: string; kind: string }[];
  /** The option chosen, by name, or "Cancelled". */
  chosen?: string;
};

/** One row of the chat. */
export type AcpRow =
  | {
      key: string;
      offset: number;
      kind: "said";
      from: "user" | "agent";
      text: string;
      /** Still being written: frames so far, the finished text not yet on the log. */
      streaming?: boolean;
    }
  | { key: string; offset: number; kind: "thought"; text: string; streaming?: boolean }
  | ToolRow
  | PlanRow
  | PermissionRow
  | NoticeRow;

/** A line about the session. `pending` while what it says is under way (a start), with a spinner. */
type NoticeRow = {
  key: string;
  offset: number;
  kind: "notice";
  text: string;
  pending?: true;
  /** The runner's start, step by step (`runner-progressed`), under a start's notice. */
  steps?: ProgressStep[];
};

/** A line under a start's notice. A command's line is pending (a spinner) from its start until it
 *  finishes, when its finish replaces it. */
type ProgressStep = {
  text: string;
  command?: string;
  pending?: boolean;
  failed?: boolean;
  detail?: string;
};

/** One `runner-progressed` as a line under the start's notice. */
function progressStep(p: Record<string, unknown>): ProgressStep {
  const said = str(p.said).trim();
  const command = str(p.command) || undefined;
  const lastLine = said.split("\n").filter(Boolean).at(-1) || "";
  const seconds =
    typeof p.durationMs === "number" ? ` (${(p.durationMs / 1000).toFixed(1)} s)` : "";
  if (p.step === "sandbox-created" || p.step === "created") return { text: "Sandbox created" };
  if (p.step === "sandbox-started" || p.step === "started")
    return { text: `Sandbox started from ${p.from === "image" ? "its image" : "its saved disk"}` };
  if (p.step === "command-started") return { text: "Starting the host", command, pending: true };
  if (p.exitCode === 0)
    return { text: `Host running${seconds}`, command, detail: said || undefined };
  if (p.exitCode === 75)
    return {
      text: `Host still starting${seconds}${lastLine ? `: ${lastLine}` : ""}`,
      command,
      detail: said || undefined,
    };
  return {
    text: `Host failed (exit ${String(p.exitCode)})${seconds}`,
    command,
    failed: true,
    detail: said,
  };
}

type Status = { text: string; tone: "live" | "amber" | "muted"; detail?: string };

/** A session's chat, what it is doing now, and whether a turn is running (the Stop button). */
export function eventsToRows(events: readonly Event[]): {
  rows: AcpRow[];
  status: Status;
  working: boolean;
} {
  const rows: AcpRow[] = [];
  const tools = new Map<string, ToolRow>();
  // text by turn and piece (`<messageOffset>:<segment>`): frames add to it, the finished piece replaces it
  const pieces = new Map<string, Extract<AcpRow, { kind: "said" | "thought" }>>();
  const permissions = new Map<number, PermissionRow>();
  // turns whose answer is on the log as finished pieces
  const answered = new Set<number>();
  let plan: PlanRow | undefined;
  let agent = "The agent";
  let status: Status = { text: "Idle", tone: "muted" };
  let cost: string | undefined;
  let working = false;
  // from a start request until the session starts or fails: its row, and the first message sent
  // meanwhile, which runs once it has started
  let starting: { row: NoticeRow; agent: string; waiting?: string } | undefined;
  const stopStarting = () => {
    if (starting) rows.splice(rows.indexOf(starting.row), 1);
    const waiting = starting?.waiting;
    starting = undefined;
    return waiting;
  };

  for (const event of events) {
    const key = String(event.offset);
    const p = record(event.payload);
    switch (event.type) {
      case ACP.sessionStartRequested: {
        // the runner spawns the agent, which may first be fetched (npx), in a sandbox that may
        // first be made: often most of a minute with nothing else on the log
        const row: NoticeRow = {
          key,
          offset: event.offset,
          kind: "notice",
          text: `Starting ${str(p.agent)} on ${str(p.runner)}…`,
          pending: true,
        };
        stopStarting();
        starting = { row, agent: str(p.agent) };
        rows.push(row);
        status = { text: `Starting ${str(p.agent)}…`, tone: "live" };
        break;
      }
      case ACP.runnerProgressed: {
        // a step of a start under way; one after the start (a parked sandbox woken) is the status
        const step = progressStep(p);
        if (starting) {
          const steps = (starting.row.steps ||= []);
          // a finish replaces its command's pending line
          const running =
            step.command && !step.pending
              ? steps.findIndex((each) => each.pending && each.command === step.command)
              : -1;
          if (running >= 0) steps[running] = step;
          else steps.push(step);
        }
        if (starting || step.failed)
          status = {
            text: `${starting ? `Starting ${starting.agent}` : "Waking the sandbox"} · ${step.text}`,
            tone: step.failed ? "amber" : "live",
          };
        // a host that runs after a wake's failure (a retry, or an old failure copied late) ends it
        else if (
          status.text.startsWith("Waking the sandbox") &&
          step.text.startsWith("Host running")
        )
          status = working ? { text: "Working", tone: "live" } : { text: "Idle", tone: "muted" };
        break;
      }
      case ACP.sessionStarted: {
        const info = record(p.agent);
        agent = str(info.title) || str(info.name) || agent;
        const host = str(record(p.runner).host);
        rows.push({
          key,
          offset: event.offset,
          kind: "notice",
          // a runner that restarted, or a sandbox that slept, loads the session again
          // (`session/load`) when it is next sent words
          text: p.loaded
            ? `The runner on ${host} loaded the session again`
            : `${agent}${info.version ? ` ${str(info.version)}` : ""} on ${host}, in ${str(p.cwd)}`,
        });
        // a message sent while it started is its first turn, now running
        const waiting = stopStarting();
        status = waiting
          ? { text: `Working · ${waiting}`, tone: "live" }
          : { text: "Idle", tone: "muted" };
        working = Boolean(waiting);
        break;
      }
      case ACP.sessionStartFailed:
        stopStarting();
        rows.push({
          key,
          offset: event.offset,
          kind: "notice",
          text: `Didn't start: ${str(p.error)}`,
        });
        status = { text: "Ended", tone: "muted" };
        working = false;
        break;
      case MESSAGE_RECEIVED:
        rows.push({ key, offset: event.offset, kind: "said", from: "user", text: str(p.message) });
        if (p.trigger === false) break;
        if (starting) {
          // it waits for the start: the runner prompts it once the session opens
          starting.waiting ||= firstLine(p.message, 80);
          status = { text: `Starting ${starting.agent}… then: ${starting.waiting}`, tone: "live" };
          break;
        }
        status = { text: `Working · ${firstLine(p.message, 80)}`, tone: "live" };
        working = true;
        break;
      case ACP.updateFrame:
      case ACP.updateReceived: {
        const update = record(p.update);
        const kind = str(update.sessionUpdate);
        if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
          const content = record(update.content);
          if (content.type !== "text") break;
          const id = `${String(p.messageOffset)}:${String(p.segment)}`;
          const finished = event.type === ACP.updateReceived;
          let row = pieces.get(id);
          if (!row) {
            row =
              kind === "agent_message_chunk"
                ? { key, offset: event.offset, kind: "said", from: "agent", text: "" }
                : { key, offset: event.offset, kind: "thought", text: "" };
            pieces.set(id, row);
            rows.push(row);
          }
          if (finished) {
            Object.assign(row, { text: str(content.text), streaming: false });
            if (row.kind === "said") answered.add(Number(p.messageOffset));
          } else if (row.streaming !== false) {
            Object.assign(row, { text: row.text + str(content.text), streaming: true });
          }
          break;
        }
        if (kind === "tool_call" || kind === "tool_call_update") {
          const id = str(update.toolCallId);
          let row = tools.get(id);
          if (!row) {
            row = {
              key,
              offset: event.offset,
              kind: "tool",
              toolKind: "other",
              title: "",
              status: "pending",
              output: "",
              updatedAt: event.offset,
            };
            tools.set(id, row);
            rows.push(row);
          }
          if (update.kind) row.toolKind = str(update.kind);
          if (update.title) row.title = str(update.title);
          if (update.status) row.status = str(update.status) as ToolStatus;
          const output = toolOutput(update);
          if (output) row.output = output;
          row.updatedAt = event.offset;
          if (working)
            status =
              row.status === "completed" || row.status === "failed"
                ? { text: "Working", tone: "live" }
                : { text: row.title || row.toolKind, tone: "live" };
          break;
        }
        if (kind === "plan") {
          const entries = Array.isArray(update.entries) ? update.entries.map(record) : [];
          if (!plan) {
            plan = { key, offset: event.offset, kind: "plan", entries: [] };
            rows.push(plan);
          }
          plan.entries = entries.map((entry) => ({
            content: str(entry.content),
            status: str(entry.status) as PlanRow["entries"][number]["status"],
          }));
          break;
        }
        if (kind === "usage_update") {
          const amount = record(update.cost).amount;
          if (typeof amount === "number") cost = `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
        }
        break;
      }
      case ACP.permissionRequested: {
        const toolCall = record(p.toolCall);
        const row: PermissionRow = {
          key,
          offset: event.offset,
          kind: "permission",
          title: str(toolCall.title) || str(toolCall.kind) || "a tool",
          options: (Array.isArray(p.options) ? p.options : []).map((option) => {
            const o = record(option);
            return { optionId: str(o.optionId), name: str(o.name), kind: str(o.kind) };
          }),
        };
        permissions.set(event.offset, row);
        rows.push(row);
        status = { text: `Waiting for you · ${row.title}`, tone: "amber" };
        break;
      }
      case ACP.permissionSettled: {
        const row = permissions.get(Number(p.requestOffset));
        if (!row || row.chosen) break;
        const outcome = record(p.outcome);
        row.chosen =
          outcome.outcome === "selected"
            ? row.options.find((option) => option.optionId === outcome.optionId)?.name ||
              str(outcome.optionId)
            : "Cancelled";
        if (working) status = { text: "Working", tone: "live" };
        break;
      }
      case ACP.turnEnded: {
        const messageOffset = Number(p.messageOffset);
        // the finished pieces are the answer; with none on the log (they failed to land), the
        // turn's own copy of the text stands in
        if (!answered.has(messageOffset) && str(p.text))
          rows.push({ key, offset: event.offset, kind: "said", from: "agent", text: str(p.text) });
        for (const row of pieces.values()) if (row.streaming) row.streaming = false;
        if (p.error)
          rows.push({
            key: `${key}:error`,
            offset: event.offset,
            kind: "notice",
            text: `Failed: ${str(p.error)}`,
          });
        else if (p.stopReason && p.stopReason !== "end_turn")
          rows.push({
            key: `${key}:stop`,
            offset: event.offset,
            kind: "notice",
            text: STOP_REASONS[str(p.stopReason)] || str(p.stopReason),
          });
        status = { text: "Idle", tone: "muted" };
        working = false;
        break;
      }
      case DELIVERY_FAILED:
        if (p.name !== DELIVERY_ROW) break;
        // a start the runner never took isn't under way
        stopStarting();
        rows.push({
          key,
          offset: event.offset,
          kind: "notice",
          text: `The runner isn't answering, so it never got this: ${str(p.error)}`,
        });
        status = { text: "The runner isn't answering", tone: "amber" };
        working = false;
        break;
      case ACP.mindCommitted:
        rows.push({
          key,
          offset: event.offset,
          kind: "notice",
          text: `Committed ${str(p.commitOid).slice(0, 7)} to the mind's config repo: ${
            p.published ? "published" : `not published (${str(p.error)})`
          }`,
        });
        break;
      case ACP.sessionEnded:
        rows.push({
          key,
          offset: event.offset,
          kind: "notice",
          text: `The session ended${p.reason ? `: ${str(p.reason)}` : ""}`,
        });
        status = { text: "Ended", tone: "muted" };
        working = false;
        break;
    }
  }
  return { rows, status: cost ? { ...status, detail: cost } : status, working };
}

const STOP_REASONS: Record<string, string> = {
  cancelled: "Stopped",
  max_tokens: "Stopped: the answer hit its length limit",
  max_turn_requests: "Stopped: the turn made too many model requests",
  refusal: "The agent refused",
};

/** A tool call's output in a line: its first text content, or a terminal's output. */
function toolOutput(update: Record<string, unknown>): string {
  const content = Array.isArray(update.content) ? update.content.map(record) : [];
  for (const item of content) {
    if (item.type === "content") {
      // Claude's adapter fences a command's output: the first line inside the fence is the one
      const line = firstLine(str(record(item.content).text).replace(/^\s*```\w*\n/, ""));
      if (line) return line;
    }
    if (item.type === "diff") return `edited ${str(item.path)}`;
  }
  if (typeof update.rawOutput === "string") return firstLine(update.rawOutput);
  return "";
}

/** The Events tab's sentence for each event. */
const renderers = {
  [ACP.updateReceived]: (event: Event) => {
    const update = record(record(event.payload).update);
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return `said: ${firstLine(record(update.content).text)}`;
      case "agent_thought_chunk":
        return `thought: ${firstLine(record(update.content).text)}`;
      case "tool_call":
        return `${str(update.kind)}: ${str(update.title)}`;
      case "tool_call_update":
        return `${str(update.title) || str(update.toolCallId)} ${str(update.status)}`.trim();
      default:
        return str(update.sessionUpdate);
    }
  },
  [ACP.permissionRequested]: (event: Event) =>
    `asks: ${str(record(record(event.payload).toolCall).title)}`,
  [ACP.turnEnded]: (event: Event) =>
    `turn ended: ${str(record(event.payload).stopReason) || "failed"}`,
};

// ── the server half: each session's rows ──

/** A copy row: each matching event on this context becomes an `agent/listing-updated` on `/agents`. */
type CopyRow = {
  name: string;
  consumes: string[];
  filter?: string;
  /** 0: the row reads the whole log once, so it also copies what came before it was set up. A
   *  copy is a fold of fields, so copying again is harmless. With none, it starts from now. */
  afterOffset?: 0;
  target: { path: string; type: string; payload: string };
};

/** The first non-blank line of `field`, at most 120 characters: a row's one line. */
const firstLineOf = (field: string) =>
  `$substring(($split(${field}, "\\n").$trim($))[$ != ""][0], 0, 120)`;

/** The title when nothing names the agent, as in agent-kinds/claude.ts. */
const fallbackTitle = (field: string) =>
  `($n := $split(path, "/")[-1]; $l := ($split(${field}, "\\n").$trim($))[$ != ""][0]; $l := $substring($l, 0, 1) = "[" and $contains($l, "] ") ? $trim($substringAfter($l, "] ")) : $l; $l := $contains($l, ". ") ? $substringBefore($l, ". ") : $l; $l := $length($l) <= 40 ? $l : ($c := $reduce($split($l, " "), function($a, $w) { $substring($a, -1) = "|" ? $a : $length($a) + 1 + $length($w) <= 40 ? $a & " " & $w : $a & "|" }, ""); $c := $trim($replace($c, "|", "")); $c = "" ? $substring($l, 0, 40) : $c); $count($split($n, "")[$ >= "0" and $ <= "9"]) = 0 ? $uppercase($substring($n, 0, 1)) & $replace($substring($n, 1), "-", " ") : $l)`;

/** The agent's own `agent/summary-updated`, as in agent-kinds/claude.ts. */
export function summaryRow(kind: string): CopyRow {
  return {
    name: `${kind}-catalog-summary`,
    consumes: ["events.iterate.com/agent/summary-updated"],
    filter: `$type(payload.title) = "string" or $type(payload.activity) = "string" or $type(payload.description) = "string"`,
    afterOffset: 0,
    target: {
      path: "/agents",
      type: "events.iterate.com/agent/listing-updated",
      payload: `{ "kind": "${kind}", "title": $type(payload.title) = "string" and $trim(payload.title) != "" ? $substring($trim(payload.title), 0, 120), "activity": $type(payload.activity) = "string" ? $substring(payload.activity, 0, 200), "description": $type(payload.description) = "string" ? $substring(payload.description, 0, 500) }`,
    },
  };
}

/** What the catalog shows about a session. Every row says the kind. The title is the first thing a
 *  person said, until the agent names the session itself (`session_info_update`, which Claude and
 *  Codex send): a name beats words in the catalog. The agent and machine are its description.
 *
 *  `REMOTE_CONTROL` IS NEVER A TITLE. New agent's box sends it before the person's own message,
 *  and in the catalog earlier words beat later ones, so as a title it would name every such agent
 *  "/remote-control". It still shows as what the agent does. */
export function sessionRows(): CopyRow[] {
  const row = (name: string, consumes: string, fields: string, filter?: string): CopyRow => ({
    name: `acp-catalog-${name}`,
    consumes: [consumes],
    filter,
    afterOffset: 0,
    target: {
      path: "/agents",
      type: "events.iterate.com/agent/listing-updated",
      payload: `{ "kind": "acp"${fields} }`,
    },
  });
  const agentName = `($exists(payload.agent.title) ? payload.agent.title : payload.agent.name)`;
  const isWords = `($trim(payload.message) != "${REMOTE_CONTROL}")`;
  return [
    row(
      "start-requested",
      ACP.sessionStartRequested,
      `, "status": "working", "activity": "Starting " & payload.agent`,
    ),
    row(
      "started",
      ACP.sessionStarted,
      `, "status": "idle", "host": payload.runner.host, "activity": ${agentName} & " is ready", "description": ${agentName} & " " & payload.agent.version & " on " & payload.runner.host & " (" & payload.runner.name & "), through ACP, in " & payload.cwd`,
    ),
    row(
      "start-failed",
      ACP.sessionStartFailed,
      `, "status": "ended", "activity": ${firstLineOf("payload.error")}`,
    ),
    row(
      "prompted",
      MESSAGE_RECEIVED,
      // a key whose value is nothing (a `?` with no `:`) is left out of the object
      // a person's words start a turn and clear what the last one did
      `, "status": "working", "activity": "", "title": ${isWords} ? ${fallbackTitle("payload.message")}, "fromWords": ${isWords} ? true`,
      // JSONata's `!=` with a missing field is false, so `trigger` absent is `$not(… = false)`
      `$not(payload.trigger = false) and $trim(payload.message) != ""`,
    ),
    row("answered", ACP.turnEnded, `, "status": "idle"`),
    row(
      "asked",
      ACP.permissionRequested,
      `, "status": "waiting", "activity": "Asks to run " & $substring(payload.toolCall.title, 0, 100)`,
    ),
    row("permitted", ACP.permissionSettled, `, "status": "working"`),
    row(
      "titled",
      ACP.updateReceived,
      `, "title": $substring(payload.update.title, 0, 120)`,
      `payload.update.sessionUpdate = "session_info_update" and $type(payload.update.title) = "string" and payload.update.title != ""`,
    ),
    // what it does now: the title the agent gives each tool call, from now on only
    {
      ...row(
        "tool",
        ACP.updateReceived,
        `, "activity": $substring(payload.update.title, 0, 120)`,
        `payload.update.sessionUpdate = "tool_call" and $type(payload.update.title) = "string" and payload.update.title != ""`,
      ),
      afterOffset: undefined,
    },
    row("ended", ACP.sessionEnded, `, "status": "ended"`),
    row(
      "not-answering",
      DELIVERY_FAILED,
      `, "status": "idle", "activity": "The runner isn't answering: " & ${firstLineOf("payload.error")}`,
      `payload.name = "${DELIVERY_ROW}"`,
    ),
    summaryRow("acp"),
  ];
}

/** The subscription that hands a session's inputs to the runner that runs it: the start request
 *  itself (it starts from just before it), the words sent to it, permission answers, stop and end.
 *  Fan-out, as a row to a runner has to be to be retried by the platform (an ordered row to a lend is a
 *  push the receiver heals itself); the runner puts what it gets in order. An event it never takes
 *  is dead-lettered after the ladder (`itx/subscription-delivery-failed`), which the copy rows and
 *  the view read as "not answering". The runner is a rule on the mind's root, which a context's
 *  own rules don't reach: hence `cd('/')`. */
export function deliveryRow(runner: string, startOffset: number) {
  return {
    name: DELIVERY_ROW,
    consumes: [
      ACP.sessionStartRequested,
      MESSAGE_RECEIVED,
      ACP.permissionSettled,
      ACP.turnCancelRequested,
      ACP.sessionEndRequested,
    ],
    ordered: false as const,
    afterOffset: Math.max(0, startOffset - 1),
    target: `itx.cd('/').${runner}.deliverEvent`,
  };
}

/** The `subscription-configured` events that set up a session's context. Each key carries a hash
 *  of its row, so setting up again appends nothing, and a session started again (a new request on
 *  the same path) configures the new delivery row under the same name. */
export function setupEvents(
  path: string,
  input: { runner: string; startOffset: number },
): { type: string; idempotencyKey: string; payload: Record<string, unknown> }[] {
  const rows: { name: string }[] = [...sessionRows(), deliveryRow(input.runner, input.startOffset)];
  return rows.map((row) => ({
    type: "events.iterate.com/itx/subscription-configured",
    idempotencyKey: `acp/row:${path}:${row.name}:${fnv1a(JSON.stringify(row))}`,
    payload: row,
  }));
}

/** A short hash of a string (FNV-1a, 32 bits): the worker has no node:crypto, and a key only needs
 *  to change when its row does. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A start request sets up its session's context. The request names the runner, which only the
 *  starter knows. */
async function processEvent({ event, itx }: Parameters<NonNullable<AgentKind["processEvent"]>>[0]) {
  if (event.type !== ACP.sessionStartRequested || !SESSION_PATH.test(event.path)) return;
  const runner = str(record(event.payload).runner);
  if (!RUNNER_NAME.test(runner)) return;
  await itx
    .cd(event.path)
    .append(
      ...(setupEvents(event.path, { runner, startOffset: event.offset }) as Parameters<
        ReturnType<typeof itx.cd>["append"]
      >),
    );
}

// ── reading payloads ──

function record(value: unknown): Record<string, unknown> {
  return value instanceof Object ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The first line of a text, cut for a row. */
function firstLine(value: unknown, max = 160): string {
  const line = str(value).trim().split("\n")[0] || "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
