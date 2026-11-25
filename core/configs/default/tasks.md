# Tasks

The task board is `apps/tasks/`, on `tasks.<domain>` for members. This file says how an agent
makes, moves, gives out, follows and answers a task, and how it reads the board.

## Where the tasks are

- Each Markdown file under `tasks/` of the mind's tasks repo is a card. `status:` in its
  frontmatter is its column: `backlog`, `todo`, `in-progress`, `in-review`, `done`.
- The tasks repo is ONE name, `TASKS_BOARD_REPO` in `api.ts`: the board shows it and the calls
  below use it when they name no repo. A new mind's is `/repos/onboarding`, where its onboarding
  cards are. To keep the tasks in a repo of their own, make it
  (`await itx.repos.create("/repos/tasks")`) and change that one name. A commit to a repo other
  than `/repos/config` publishes nothing.
- Any repo of the mind is a board: `tasks.<domain>/?repo=<name>` shows the files under its
  `tasks/`. The calls below take `repo: "<name>"`.
- For a trial, make a throwaway repo (`await itx.repos.create("/repos/<name>")`, then
  `itx.repos.delete`), never a trial card on the real board.
- A card opens the task in a sheet, where a member edits its title, its properties and its text,
  and comments on it. The text and the comments are the Docs app's doc of that file.
- A done task stays where it is: its status says that it is done. A file's path is the task's
  identity, so do not rename one.

## What a card holds

A status is enough to start. The frontmatter MAY also hold `tags:`, `owner:` (the person who
asked), `agent:` (the path of the agent that has the task), `priority:`, `blocked-on:` (one line:
what holds it) and `human-ask:` (what it waits for from a person: one `- ` line for each ask).
Keep reasoning, research and follow-up in the Markdown text. `apps/tasks/public/tasks-model.js`
says what the board reads.

## An agent keeps a card with three calls

Write no frontmatter by hand (`apps/tasks/cards.js`):

```ts
// a new card. `text`: the ask in the person's own words, and where it came from. `owner`: who asked
const { file, link } = await itx.config.taskOpen({ title, text, owner, tags });
// one commit that moves a card. Name only what changes
await itx.config.taskUpdate({
  file,
  status: "in-review",
  blockedOn: "the review",
  note: "Found the cause.",
});
// an ask that is a choice brings its options and your recommendation ("Asks and answers")
await itx.config.taskUpdate({
  file,
  ask: "Ship on Friday or on Monday?",
  decision: {
    options: [
      { name: "Friday", tradeoff: "Live two days sooner; nobody watches it over the weekend." },
      { name: "Monday", tradeoff: "Two days later; the team is there." },
    ],
    recommend: "Monday",
    why: "The change touches sign-in.",
  },
});
// give a card to an agent that runs
await itx.config.taskAssign({ file, agent: "/agents/…" });
```

- `taskUpdate`: `blockedOn: ""` takes the blocker away. `ask` is one more question for a person,
  with `decision` or `noChoice` ("Asks and answers"). `note` is one line under `## Log`, with your
  path and the time. It also takes `title`, `owner`, `agent`, `tags`.
- `taskAssign`: the card then names the agent and is in progress, and the agent gets ONE message
  that makes the card its brief: where the card is and how to keep it true. `message: "…"` adds
  your own words. The call refuses an agent that would not read the card: one that ended, and any
  agent but an iterate agent that had no turn for 12 hours.
- From the MCP `run` tool or a member's script add `by: "<your agent path>"` to each call. A
  commit through a person's sign-in is stamped as that person, and by this the change feed tells
  the others that it was you.
- To change a task's text, commit the file:
  `await itx.repos.get("<the tasks repo>").commitFiles({ message, changes: [{ path: "tasks/<name>.md", content }], parent })`
  (`parent`: the tip you read). End `message` with a line `Via: <your agent path>`.
- Close out your own card: `done` with what is done and how you proved it. What is left of the
  card's work keeps it open. A fault or a job that you found and that is no part of your card
  gets a card of its own before you close.

A mind adds its own rules to the brief, its own start of a new agent for a card and its own way
with a note by overriding `taskDeps` in `worker.ts`'s class (`api.ts`; `apps/tasks/cards.js`
lists the parts).

## Asks and answers

- A human ask belongs to its parent task: add it with `taskUpdate({ file, ask })`, never as a new
  card. An ask is ONE plain sentence: who it is for, and the answer that you need ("Ada: delete
  the 5 old sign-ins, yes or no?"). The name before the colon is whom the board asks. No id and
  no offset in it: those belong in the card's text.
- An ask that is a choice brings its options and your recommendation. Before you ask, work the
  options out: what each one costs and gives. Then add
  `decision: { options: [{ name, tradeoff }, …at least two], recommend: "<one name>", why }` to the
  call that adds the ask. "Yes" and "no" are two options, each with what follows from it. The
  card keeps them under `## Decisions`, and the page shows them under the ask: a click on an
  option writes it into the answer box. An ask that is no choice (a thing that only the person
  can do or see) takes `noChoice: "<why>"`. An ask with neither is taken, and the call's answer
  holds `warning`: read it. One call adds one ask with a decision.
- Which model recommended is never yours to write. The page reads it from your own log, at the
  turn that asked (`itx.config.taskAskers`, `model`), and says "model unrecorded" when no event
  says. So add each ask with `taskUpdate` from your own turn, never by a hand-made commit.
- The board's "Needs a person" (`tasks.<domain>/?needs=person`) lists every task that is not done
  and has a `human-ask:`, in the order of what presses: a task's `priority:`, then the tasks
  whose work is held, then the longest wait. A person answers an ask there, or in the task's
  sheet, in the box beside it. A task that is held and asks nothing is not listed.
- Keep your asks true. When events overtake an ask, take it off, write it again, or record the
  answer:
  `await itx.config.taskUpdate({ file, withdraw: { ask: "<its beginning>", why: "…" } })`,
  `await itx.config.taskUpdate({ file, reword: { ask: "<its beginning>", to: "<the new sentence>" } })`,
  `await itx.config.answerTask({ file, ask, answer, by: "<the person's address>" })`.
  An ask of three days or more is marked "May be outdated", and "Still needed?" sends you a
  message from the person: check the ask then.
- Link what an ask names: write a thing that has an address as `[its name](https://…)`
  (`itx.config.dashLink` gives a Dash view). Open each address before you write it. NEVER put an
  address that holds a secret into an ask (a token, a signed or one-time link, an OAuth link with
  its `state`): every member and every agent reads an ask, and it stays in the repo's history.
- The format of an answer, whoever writes it: the ask's line leaves `human-ask:`, and
  `- **<the ask>** <the answer> (<who>, <YYYY-MM-DD HH:MM> UTC)` is added under `## Answers` at
  the end of the task's text.
- Who asked: "Needs a person" shows under each ask the agent that asked it, as a link to its chat
  in the Dash, with "the message" in which it asked and "Chat with …", which opens that chat in a
  sheet. `await itx.config.taskAskers()` answers the same as data:
  `{ file, ask, agent, by, page, at, message, model, assignee }` for each open ask. It is read
  from the change feed: the commit that added the ask, by its `Via:` line.
- Clear `blocked-on:` yourself when the thing that held the task is done.

## Follow a task; never poll one

```ts
await itx.config.followTasks({ file: "tasks/<name>.md" }); // no `file`: every task
```

- Each commit that changes the file then reaches you as a message, with what changed and a small
  diff. So a person's answer to your ask comes to you.
- From the MCP `run` tool or a member's script add `agent: "<your agent path>"`.
- `only: ["status", "blocked-on", "human-ask"]`: the changes that moved one of those fields and no
  other, so that no note wakes you. The names: `added`, `deleted`, `status`, `title`, `owner`,
  `agent`, `tags`, `blocked-on`, `human-ask`, `text`.
- You are not told of a commit that you made yourself: one of your own turn, or one whose message
  ends with `Via: <your agent path>` (the three calls write that line).
- `itx.config.unfollowTasks(…)` ends it. `itx.config.taskFollowers()` lists who follows what.
- The events are `events.iterate.com/tasks/task-changed` on the repo's log,
  `/task-files/<repo name>`. `apps/tasks/feed.js` says what one holds.

## The whole board in one call

`await itx.config.taskBoard()` (`{ repo: "<name>" }` for another repo) answers every task as its
card, with the answers people gave to its asks, its last change and whether the agent it names
has work now (`agentSeen`) and follows the card (`agentFollows`). An agent that is given a card
follows it first, so a card in progress with `agentFollows: false` was not taken. Then the tasks
that need a person, the board's newest changes and who follows what. It does not hold the rest
of a task's text (read the file) or work that nobody wrote into a task.
