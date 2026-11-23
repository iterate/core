// fragments.ts — PROMPT FRAGMENTS: what an agent is told about one thing it can do. A model learns a
// thing only when its fragment is in the agent's instructions. The mind's `worker.ts` joins the
// fragments the agent should know into `config.instructions` when the agent starts:
//
//   agent/configured { config: { instructions: [base, WEB_MESSAGES, AGENT_MESSAGES, SUBAGENTS].join("\n\n") } }
//
// EVERY FRAGMENT SHOWS THE APPEND. A script does each thing by `itx.append`, and the scope has no
// wrapper that hides a fact (script-envelope.ts). A channel's fragment is in the file of its channel:
// `SLACK_MESSAGES` in slack.ts, `WEB_MESSAGES` in the mind's agent-ui.ts. So an agent that only
// answers in Slack is not told of the web. The two here are for every agent: words to another agent,
// and a subagent.
//
// A question on the side (`llm-request/requested` of purpose `side`) has no fragment yet. The
// script's scope has `llmRequestOffset`, the offset that such a request names as its base.

/** Words for another agent, or any other context. */
export const AGENT_MESSAGES = [
  "To put words in the log of another agent, a script appends its one input to the context at its",
  "path. The agent there reads them after `[from <your path>]`:",
  "",
  "<codemode>",
  'itx.cd("<its path>").append({ type: "events.iterate.com/agent/context-added", payload: { role: "user", content: "<your words>" } });',
  "</codemode>",
  "",
  "Its answer arrives later, as words to you that start `[from <its path>]`. Do not wait for it in a",
  "script: end your turn, and read the answer when it comes.",
].join("\n");

/** A subagent: with a task only, or forked with everything this agent knows. */
export const SUBAGENTS = [
  "To start a subagent, a script appends one fact to your own log. Put it under your own path,",
  "and say in the brief how to report to you (words to `<your path>`, as above):",
  "",
  "<codemode>",
  'itx.append({ type: "events.iterate.com/agent/subagent-requested", payload: { path: "<your path>/<a name for the job>", brief: "<the whole task, and how to report>" } });',
  "</codemode>",
  "",
  'The payload may name a model: `model: "anthropic/claude-opus-5.5"`. Such a subagent knows',
  "nothing of your conversation: the brief is all it has. Send a later change of the same job to",
  "the same agent.",
  "",
  "`copyContext: true` makes a FORK: the subagent begins with a copy of your whole conversation as",
  "it is now, then the brief. Fork when it needs everything you know now: it reads your cache, so",
  "its first request costs little. When it needs only a task, do not fork. When a person asks you",
  "for a fork, make one.",
  "",
  "A note tells you when the subagent has started, or why it did not. A fork reads your results",
  "by your numbers.",
].join("\n");
