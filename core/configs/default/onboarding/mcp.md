# The mind as a tool for their other AI

The owner should come away with: their own Claude or Codex can use the mind, and the first thing it did was teach the mind about them.

## Ready today

- The mind is an MCP server at `https://<control-plane hostname>/mcp`, with one tool, `run`: a script,
  `async (itx) => { … }`, run at the mind's root as the person signed in. Every run is logged.
  Opening `https://<control-plane hostname>/mcp` in a browser shows the Claude and Claude Code
  connect commands (the Dash no longer has an `/mcp` page).
- Claude (the app or claude.ai): Settings, Connectors, "Add custom connector", with that address.
- Claude Code: `claude mcp add --transport http <name> https://<control-plane hostname>/mcp`, where
  `<name>` is the control-plane hostname with a hyphen for each dot (`iterate-example-com` for
  `iterate.example.com`). Then, inside
  Claude Code: `/mcp`, pick `<name>`, Authenticate.
- Codex CLI: `codex mcp add <name> --url https://<control-plane hostname>/mcp`, then
  `codex mcp login <name>`. The owner signs in to the mind the first time their assistant uses it.

## Not ready

- ChatGPT: not known whether it connects. Do not offer it.
- Nothing tells you when their assistant is done: ask them to say so.

## How

Give the one command, or the steps, for the assistant they use. To check, ask them to have it run
`async (itx) => itx.whoami()` and tell you what it answered.

Then "customise me": this prompt, with `<zone>` filled in, for them to paste into it:

> You are connected to my iterate mind at <zone> through its MCP tool `run`. Please write down
> what you know about me, so that my mind knows me too: who I am, my work, the people I mention,
> my preferences (how I like to be written to, my tools, my hours), and the projects I have open.
> Mark anything you inferred, rather than heard from me, with "(inferred)". Leave out passwords,
> keys, health, and anything you would not say in front of me. Write short plain statements, at
> most 30 lines. Then, with ONE call of `run`, append them to the file `mind.md` in the repo
> `/repos/config`, under a new heading `## From <your name>, <today's date>`, in one commit:
> `const repo = itx.repos.get("/repos/config"); const tip = await repo.tip(); const before =
(await repo.readFile("mind.md", { commitOid: tip })) ?? "";` then
> `await repo.commitFiles({ message: "mind.md: what <your name> knows about me\n\nVia: <your name>", parent: tip, changes: [{ path: "mind.md", content: before.trimEnd() + "\n\n" + section + "\n" }] })`.
> Change no other file. Return the commit id, and show me what you wrote.

When they say it is done, find that commit and read what it added:

```ts
const repo = itx.repos.get("/repos/config");
const commit = (await repo.log({ limit: 10 })).find((c) => c.message.startsWith("mind.md: what "));
if (!commit) return null;
return {
  message: commit.message,
  now: await repo.readFile("mind.md", { commitOid: commit.oid }),
  was: await repo.readFile("mind.md", { commitOid: commit.parents[0] }),
};
```

Tell them in a few lines what was added; offer to take any of it out (`/agents/onboarding/mind-md`).

## Say

- "Your Claude can use your mind too. Paste this into Claude Code: <the command>."
- "Your Claude added 14 lines about you: your studio, your two partners, and that you like short
  mails. Shall I take any of it out?"
