# Coding agents in a sandbox

Codex, Claude Code or opencode, each session in a sandbox of its own with this mind's config repo
checked out. The code is `acp-sandbox.ts`, `acp-sandbox/`, `sandbox-tools/` and the kind
`agent-kinds/acp.ts`; `worker.ts` hosts it with `acpSandbox()`. Each publish makes the rule
`itx.acp.sandbox` and two secrets of the runner's own, `/secrets/acp-sandbox` and
`/secrets/acp-sandbox-egress`.

## Before a start

Look first. A start that lacks one of these fails, and its session says why.

- **The image.** The sandbox needs the agent's own program (`codex-acp` for Codex) and git. Run
  `codex --version` and `git --version` in a sandbox of this mind. Cloudflare's lean image has Node
  and npm alone: [sandbox-image.md](sandbox-image.md) says which image this mind's sandboxes start
  on.
- **A key.** Codex takes the owner's ChatGPT plan when the mind has `/secrets/chatgpt`
  (`npx iterate@latest chatgpt connect <the mind's domain>`), else an OpenAI API key at
  `/secrets/openai`. Claude Code takes a Claude plan's login when the mind has
  `/secrets/claude-current`, else an Anthropic API key at `/secrets/anthropic`. The mind's AI
  Gateway credit runs none of them.

## Start a session

```js
const { path } = await itx.acp.sandbox.start("codex"); // or "claude", "opencode"
await itx.agents.get(path).message("List the files in /work.");
```

- `path` is the session's agent, `/agents/acp/<id>`. Its sandbox is `<path>/box`. A person opens
  it in the Dash: `https://dash.<the mind's domain>/?agent=<path>`.
- The session's log says how it goes. `events.iterate.com/acp/runner-progressed`: a step of the
  start. `acp/session-started`: the agent is there. `acp/turn-ended`: an answer, with
  `payload.text` and `payload.stopReason` (`end_turn` for a good one). `acp/session-start-failed`
  and `acp/session-ended`: it did not start, or it is over.
- The first start of an image on a host pulls the image: that took four minutes once, and the
  turn itself six seconds. Start one session before a person waits for it.
- A session that is idle for five minutes parks with its disk saved. The next message wakes it.

## What a session may do

- **It has this mind's reach.** Each session gets two tools: `run`, a script against the mind
  with the root `itx`, and `commit`, which commits its working folder to `/repos/config` and so
  publishes the mind. That is what a member's own coding agent is for. Never start one for a
  person who is not a member, and never hand it a stranger's text as its task.
- To keep sessions to their own sandbox, write `acpSandbox({ mindTools: false })` in `worker.ts`.
- No secret of the mind is in a sandbox. A key is a placeholder that the mind's egress fills in
  on the way to its provider, and each sandbox holds a key of its own session alone.
- Nobody sits at a session, so an agent's own question ("may I run this?") is answered yes there.
  The sandbox is the boundary.
