// cards.js — A TASK'S CARD, KEPT BY AN AGENT: three calls of `itx.config` (api.ts) that do what
// a person does on the board, so that an agent never writes a task's frontmatter by hand.
//
//   taskOpen    a new card: its title, its text (the ask in the person's own words), who asked
//   taskUpdate  one commit that moves a card: status, who has it, what holds it, a new ask, a note
//   taskAssign  gives a card to an agent. The card is the brief: the agent gets ONE message that
//               says where the card is and how to keep it true (`briefOf`)
//
// Each writes through the board's own functions (public/tasks-model.js), on the tip it read, and
// ends its commit's message with `Via: <the calling agent>`, so the change feed (feed.js) says
// whose work a change is. With these and `answerTask` (asks.js), `followTasks` (feed.js) and
// `taskBoard` (board.js), an agent does everything on the board that a person does.
//
// AN AGENT THAT IS NAMED FOR A CARD: one that ended takes no card. The call refuses the agent
// that it can prove gone, and the one with no turn for half a day that it cannot prove alive
// (`goneOf`); for the rest the board says whether the agent took its card (board.js
// `agentFollows`: an agent follows its card as its first act, `briefOf` step 2).
//
// WHAT A MIND ADDS OF ITS OWN, through `deps` (api.ts `taskDeps`). Each is optional, and a mind
// that names none has the plain calls:
//   - `linkNote(itx, note)`: the note as the card keeps it (a mind that mirrors its code to
//     GitHub makes a link of each commit id);
//   - `briefRules({ repo, file, agent, worker })`: the mind's own rules for an agent that gets a
//     card, as lines after `briefOf`'s own steps (who merges, who deploys, who reviews);
//   - `startWorker(itx, { worker, by, file, repo })`: starts a NEW agent for `taskAssign({ file,
//     worker })` and answers `{ agent, model?, effort?, running? }`. A mind without it starts none;
//   - `sessionState(itx, agent, row)`: what the mind can prove of a coding session that is named:
//     `"runs"`, or why it is gone, in words; undefined when it cannot tell.
import { repoOf } from "./feed.js";
import {
  commitOf,
  decisionFault,
  isTaskPath,
  messageOf,
  newTask,
  parseTask,
  TASKS_DIR,
} from "./public/tasks-model.js";

const oneLine = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nameOf = (repo) => repo.split("/").at(-1);
/** `, repo: "<name>"` for a call's example: always named, since a mind chooses which repo a call
 *  with none means (api.ts `TASKS_BOARD_REPO`). */
const repoArg = (repo) => `, repo: ${JSON.stringify(nameOf(repo))}`;
const wordsOf = (error) => String(error?.message || error).slice(0, 300);

/** The card on the board, for a person. */
async function linkOf(itx, repo, file) {
  const query = `repo=${encodeURIComponent(nameOf(repo))}&task=${encodeURIComponent(file)}`;
  return `https://tasks.${new URL(await itx.url()).hostname}/?${query}`;
}

/** Who makes a change: the agent that the call names (`by`), else the agent whose context the
 *  call came from; null for neither (a member's own script). */
function callerOf(input, { callerPath }) {
  if (oneLine(input.by)) return oneLine(input.by);
  let caller;
  try {
    caller = callerPath();
  } catch {
    caller = undefined;
  }
  return typeof caller === "string" && caller.startsWith("/agents/") ? caller : null;
}

/** What a caller wants to see of a card after its change. */
function cardOf(file, source) {
  const { title, status, owner, agent, model, effort, tags, blockedOn, humanAsk } = parseTask(
    file,
    source,
  );
  return {
    title,
    status,
    owner,
    agent,
    model,
    effort,
    tags,
    blockedOn: blockedOn || null,
    humanAsk,
  };
}

/** ONE COMMIT OF `changes` TO A TASK FILE, as the repo has it now (tasks-model.js `applyChange`).
 *  Made again on the new tip, once, when another commit overtook it. It answers the commit, whether
 *  the file changed, and the file's text after it. A file that the repo does not have is refused. */
async function writeTask(itx, tool, { repo, file, changes, via }) {
  const handle = itx.repos.get(repo);
  for (let attempt = 0; ; attempt += 1) {
    const tip = await handle.tip();
    const source = tip ? await handle.readFile(file, { commitOid: tip }) : null;
    if (source === null) throw new Error(`${tool}: ${repo} has no ${file}.`);
    // changes that depend on what the file holds now (which ask a caller means) are made from it
    const list = typeof changes === "function" ? changes(source) : changes;
    const [written] = commitOf({ [file]: source }, list);
    if (!written) return { commitOid: tip, changed: false, source };
    try {
      const message = `${messageOf(list)}${via ? `\n\nVia: ${via}` : ""}`;
      const { commitOid } = await handle.commitFiles({ message, changes: [written], parent: tip });
      return { commitOid, changed: true, source: written.content };
    } catch (error) {
      // main moved between the read and the commit: read again, once
      if (attempt > 0) throw error;
    }
  }
}

/** WHAT AN ASK MUST BRING (Jonas, 25 Nov 2026: "we need to make absolutely sure that when we are
 *  presented with a choice, the different options are explored and a recommendation is given").
 *  A call that adds an ask names `decision: { options: [{ name, tradeoff }, …], recommend, why }`
 *  for it, or `noChoice: "<why>"` for an ask that is no choice between options (a thing only the
 *  person can do or see: "open the link and say whether the page shows"). With neither, the ask
 *  is TAKEN and the call's answer holds `warning`, these words (`ASK_WARNING`): for three quarters
 *  of an hour on 25 Nov 2026 such a call was refused, and Jonas chose "Only warn" on the card
 *  (tasks/decision-asks-options-recommendation-and-model-provenance.md, 11:28 UTC). A decision
 *  that is given and is not whole is still refused: the agent meant one, and reads what it lacks.
 *  One call, one ask with a decision. `askRuleOf` answers the decisions to write; `askWarningOf`
 *  the warning, or undefined. */
const ASK_WARNING =
  'This ask has no options. An ask that is a choice names them: add decision: { options: [{ name: "…", tradeoff: "what it costs or gives" }, …at least two], recommend: "<the name of one>", why: "<why that one>" } to the call that adds the ask. The person then sees the options, your recommendation and, from your own log, which model made it. For an ask that is no choice between options (a thing that only the person can do or see), add noChoice: "<why>" instead. To add them to this ask now: take it off (withdraw) and add it again with its decision. tasks.md of /repos/config, "Asks and answers".';
const askWarningOf = (input) =>
  [input.ask ?? []].flat().map(oneLine).some(Boolean) &&
  input.decision === undefined &&
  !oneLine(input.noChoice)
    ? ASK_WARNING
    : undefined;
function askRuleOf(tool, input) {
  const asks = [input.ask ?? []].flat().map(oneLine).filter(Boolean);
  const decided = Object.hasOwn(input, "decision") && input.decision !== undefined;
  if (asks.length === 0) {
    if (decided || oneLine(input.noChoice))
      throw new Error(`${tool}: decision and noChoice go with an ask, and this call adds none.`);
    return [];
  }
  if (decided) {
    if (asks.length !== 1)
      throw new Error(
        `${tool}: a decision is of ONE ask. Add each ask that is a choice in a call of its own.`,
      );
    const fault = decisionFault(input.decision);
    if (fault) throw new Error(`${tool}: ${fault}`);
    if (asks[0].includes("**")) throw new Error(`${tool}: an ask with a decision holds no "**".`);
    return [{ ask: asks[0], ...input.decision }];
  }
  return [];
}

/** `itx.config.taskOpen({ title, text?, status?, owner?, agent?, tags?, ask?, decision?, noChoice?,
 *  repo?, by? })`: a new card in the tasks repo (or in the repo `repo` names). `text` is the task's text under its
 *  title: the ask in the person's own words, and where it came from. `owner` is the person who
 *  asked; `ask` is one question for a person, or a list of them, with `decision` or `noChoice`
 *  (`askRuleOf`). Its file is named by the title.
 *  It answers `{ repo, file, commitOid, link }`. */
export async function taskOpen(itx, input, deps) {
  if (!isObject(input))
    throw new Error(
      "taskOpen takes { title, text?, status?, owner?, agent?, tags?, ask?, repo?, by? }.",
    );
  const title = oneLine(input.title);
  if (!title) throw new Error("taskOpen: title is a text, and it is not empty.");
  const decisions = askRuleOf("taskOpen", input);
  const repo = await repoOf("taskOpen", itx, input.repo);
  const by = callerOf(input, deps);
  const text = String(input.text ?? "").trim();
  const handle = itx.repos.get(repo);
  for (let attempt = 0; ; attempt += 1) {
    const tip = await handle.tip();
    const under = tip ? await handle.modules({ commitOid: tip, dir: TASKS_DIR }) : {};
    const made = newTask({
      title,
      status: oneLine(input.status) || "todo",
      taken: Object.keys(under).map((path) => `${TASKS_DIR}/${path}`),
    });
    const path = made.path;
    const [written] = commitOf({}, [
      { kind: "create", path, content: text ? `${made.content}\n${text}\n` : made.content },
      { kind: "field", path, field: "tags", value: [input.tags ?? []].flat() },
      { kind: "field", path, field: "owner", value: oneLine(input.owner) },
      { kind: "field", path, field: "agent", value: oneLine(input.agent) },
      ...[input.ask ?? []].flat().map((ask) => ({ kind: "ask", path, ask })),
      ...decisions.map((decision) => ({ kind: "decision", path, ...decision })),
    ]);
    try {
      const { commitOid } = await handle.commitFiles({
        message: `tasks: new ${path}${by ? `\n\nVia: ${by}` : ""}`,
        changes: [written],
        parent: tip,
      });
      const warning = askWarningOf(input);
      return {
        repo,
        file: path,
        commitOid,
        link: await linkOf(itx, repo, path),
        warning,
      };
    } catch (error) {
      // another commit took the tip, or the name: read again, once
      if (attempt > 0) throw error;
    }
  }
}

/** The changes that a call names, in the order they are written. */
function changesOf(path, input, by, now) {
  const named = (key) => Object.hasOwn(input, key) && input[key] !== undefined;
  return [
    ...(named("title") ? [{ kind: "title", path, title: input.title }] : []),
    ...(named("status") ? [{ kind: "status", path, status: oneLine(input.status) }] : []),
    ...(named("owner")
      ? [{ kind: "field", path, field: "owner", value: oneLine(input.owner) }]
      : []),
    ...(named("agent")
      ? [{ kind: "field", path, field: "agent", value: oneLine(input.agent) }]
      : []),
    ...(named("tags")
      ? [{ kind: "field", path, field: "tags", value: [input.tags ?? []].flat() }]
      : []),
    ...(named("model") ? [{ kind: "key", path, key: "model", value: input.model }] : []),
    ...(named("effort") ? [{ kind: "key", path, key: "effort", value: input.effort }] : []),
    ...(named("blockedOn") ? [{ kind: "blocked", path, blockedOn: input.blockedOn }] : []),
    ...[input.ask ?? []].flat().map((ask) => ({ kind: "ask", path, ask })),
    ...askRuleOf("taskUpdate", input).map((decision) => ({ kind: "decision", path, ...decision })),
    ...(oneLine(input.note)
      ? [{ kind: "note", path, note: input.note, by: by || "someone", at: now.toISOString() }]
      : []),
  ];
}

/** How much of an ask a note quotes. */
const beginOf = (ask) => (ask.length > 100 ? `${ask.slice(0, 99)}…` : ask);

/** The changes that keep a card's ASKS true, made from the file as it is now. `withdraw` takes an
 *  ask off that events overtook; `reword` writes one again in plain words. Each names its ask by
 *  the whole text or by its beginning, which must fit ONE ask of the card. Each leaves a line
 *  under `## Log` that says what happened to the ask, and why. */
function askChangesOf(path, source, { withdraw, reword }, by, now) {
  const asked = parseTask(path, source).humanAsk;
  const whole = (given) => {
    const found = asked.filter((ask) => ask === given || ask.startsWith(given));
    if (found.length === 1) return found[0];
    const has =
      asked.length > 0 ? asked.map((ask) => JSON.stringify(beginOf(ask))).join(", ") : "nothing";
    throw new Error(
      `taskUpdate: ${found.length === 0 ? "no ask" : `${found.length} asks`} of ${path} ${found.length === 0 ? "begins" : "begin"} with ${JSON.stringify(beginOf(given))}. It asks: ${has}.`,
    );
  };
  const note = (words) => ({
    kind: "note",
    path,
    note: words,
    by: by || "someone",
    at: now.toISOString(),
  });
  return [
    ...withdraw.flatMap(({ ask, why }) => {
      const text = whole(ask);
      return [
        { kind: "withdraw", path, ask: text },
        note(
          `An ask was taken off, with no answer: ${oneLine(why)} It began: ${JSON.stringify(beginOf(text))}`,
        ),
      ];
    }),
    ...reword.flatMap(({ ask, to }) => {
      const text = whole(ask);
      return [
        { kind: "reword", path, ask: text, to: oneLine(to) },
        note(`An ask was written again in plain words. It began: ${JSON.stringify(beginOf(text))}`),
      ];
    }),
  ];
}

/** `itx.config.taskUpdate({ file, status?, title?, owner?, agent?, tags?, model?, effort?,
 *  blockedOn?, ask?, withdraw?, reword?, note?, repo?, by? })`: one commit that changes what the
 *  call names, and leaves every other byte of the file. `blockedOn`: what holds the task, one
 *  line; `""` takes it away. `ask`: one more question for a person (they answer on the board),
 *  with `decision: { options, recommend, why }`, or `noChoice: "<why>"` for an ask that is no
 *  choice (`askRuleOf`: an ask with neither is taken, and the answer holds `warning`).
 *  `withdraw: { ask, why }` takes an ask off that nobody has to answer any more (the pull request
 *  it asked about is merged), and `reword: { ask, to }` writes an ask again in plain words; each
 *  may be a list, and `ask` there is the ask's whole text or its beginning. `note`: one line under
 *  `## Log`, with who wrote it and when. `by`: the agent that makes the change, when the call
 *  comes from no agent's context (the MCP `run` tool). It answers
 *  `{ repo, file, commitOid, changed, card }`. */
export async function taskUpdate(itx, input, deps, now = new Date()) {
  if (!isObject(input))
    throw new Error(
      "taskUpdate takes { file, status?, title?, owner?, agent?, tags?, model?, effort?, blockedOn?, ask?, withdraw?, reword?, note?, repo?, by? }.",
    );
  const { file } = input;
  if (typeof file !== "string" || !isTaskPath(file))
    throw new Error('taskUpdate: file is a task\'s path, like "tasks/a-task.md".');
  if (Object.hasOwn(input, "status") && input.status !== undefined && !oneLine(input.status))
    throw new Error('taskUpdate: status is a word, like "in-progress" or "done".');
  const withdraw = [input.withdraw ?? []].flat();
  const reword = [input.reword ?? []].flat();
  if (!withdraw.every((one) => isObject(one) && oneLine(one.ask) && oneLine(one.why)))
    throw new Error(
      "taskUpdate: withdraw is { ask, why }, or a list of them: the ask (its beginning is enough) and why nobody has to answer it any more.",
    );
  if (!reword.every((one) => isObject(one) && oneLine(one.ask) && oneLine(one.to)))
    throw new Error(
      "taskUpdate: reword is { ask, to }, or a list of them: the ask (its beginning is enough) and its new words.",
    );
  const by = callerOf(input, deps);
  // the note as the card keeps it: a mind may make links in it (`deps.linkNote`)
  const plain = changesOf(
    file,
    oneLine(input.note) && deps.linkNote
      ? { ...input, note: await deps.linkNote(itx, input.note) }
      : input,
    by,
    now,
  );
  if (plain.length + withdraw.length + reword.length === 0)
    throw new Error(
      "taskUpdate: name what changes: status, title, owner, agent, tags, model, effort, blockedOn, ask, withdraw, reword or note.",
    );
  const repo = await repoOf("taskUpdate", itx, input.repo);
  // the asks first, then the rest: the call's own note is the last line of the log
  const changes = (source) => [
    ...askChangesOf(file, source, { withdraw, reword }, by, now),
    ...plain,
  ];
  const done = await writeTask(itx, "taskUpdate", { repo, file, changes, via: by });
  const warning = askWarningOf(input);
  return {
    repo,
    file,
    commitOid: done.commitOid,
    changed: done.changed,
    card: cardOf(file, done.source),
    warning,
  };
}

/** THE FIRST MESSAGE TO THE AGENT THAT GETS A CARD: where its brief is, and how it keeps the card
 *  true. The same words for every agent, so that every card is kept the same way. `rules`: the
 *  mind's own lines after these steps (`deps.briefRules`). */
export function briefOf({ repo, file, agent, by, words, rules = [] }) {
  const also = repoArg(repo);
  const from = by && by !== agent ? ` from ${by}` : "";
  return [
    `You have a task${from}. The card is your brief: ${file} in the repo ${repo} of this mind.`,
    "",
    `1. Read it with your \`run\` tool (in a Claude Code or Codex session: the iterate MCP tool \`run\`): async (itx) => await itx.repos.get(${JSON.stringify(repo)}).readFile(${JSON.stringify(file)}). Read tasks.md of /repos/config first: it has the rules for a card.`,
    `2. Follow your card, so that a person's answer reaches you as a message: async (itx) => await itx.config.followTasks({ file: ${JSON.stringify(file)}, agent: ${JSON.stringify(agent)}${also} }).`,
    `3. Keep the card true while you work, with one call: async (itx) => await itx.config.taskUpdate({ file: ${JSON.stringify(file)}, by: ${JSON.stringify(agent)}, note: "…"${also} }). The same call takes status ("in-progress", "in-review", "done"), blockedOn (what holds you; "" when it is gone) and ask (one question that a person answers in one line: they answer on the board, and the answer comes to you by your follow; name a thing as a Markdown link, [its name](https://…), when it has an address that is safe to share: tasks.md, "Asks and answers"). An ask that is a choice goes with decision: { options: [{ name, tradeoff }, …], recommend, why }: explore the options first, and recommend one. An ask that is no choice goes with noChoice: "<why>". The call takes an ask with neither, and its answer then holds a warning: read it.`,
    "4. Send no status messages: whoever needs your state reads the card or follows it.",
    '5. Close out your own card: ONE call with status "done" (or "in-review" when a person must look first) and a note that says what is done and how you proved it. What is left of THIS card\'s work keeps the card open: write it on the card. A fault or a job that you found and that is no part of this card gets a card of its own (taskOpen) BEFORE you close, and your last note names it.',
    ...rules,
    ...(words ? ["", `In the words of the agent that gives you the card: ${words}`] : []),
  ].join("\n");
}

/** An agent with no turn for longer than this is asked nothing, when the mind cannot prove that it
 *  runs: a new agent gets the card, with the old agent's path in the card's text. */
const IDLE_TOO_LONG_MS = 12 * 3_600_000;

/** WHY AN AGENT CANNOT TAKE A CARD NOW, in words, or null. `row` is its row in the mind's catalog
 *  on /agents (`kind`, `host`, `status`, `lastActivityAt`: the time of its last turn).
 *  WHAT IS PROVEN:
 *   - A row that says "ended" is gone.
 *   - An iterate agent runs: it is the mind's own loop, and a message wakes it.
 *   - What the mind itself can prove of a coding session (`deps.sessionState`): that it runs, or
 *     why it is gone. The catalog cannot say this: a session whose window a person closed sends
 *     no end, and its row stays "idle" for good.
 *  WHAT IS NOT PROVEN is decided by the time of the agent's last turn (`IDLE_TOO_LONG_MS`). A row
 *  with no time passes: for it, and for an agent that goes after it got the card, the board says
 *  whether the agent took the card (board.js `agentFollows`). */
async function goneOf(itx, agent, row, now, deps) {
  if (!row) return null;
  if (row.status === "ended") return "has ended";
  if (row.kind === "iterate") return null;
  const state = await deps.sessionState?.(itx, agent, row);
  if (state === "runs") return null;
  if (typeof state === "string" && state) return state;
  const last = Date.parse(row.lastActivityAt ?? "");
  if (!Number.isFinite(last) || now - last <= IDLE_TOO_LONG_MS) return null;
  return `has had no turn since ${new Date(last).toISOString().slice(0, 16).replace("T", " ")} UTC (more than ${IDLE_TOO_LONG_MS / 3_600_000} hours), and the mind cannot tell whether it still runs`;
}

/** `itx.config.taskAssign({ file, agent?, worker?, message?, repo?, by? })`: gives the card to an
 *  agent. `agent`: the path of an agent that runs (one that provably does not is refused:
 *  `goneOf`). `worker`: what the mind's own `deps.startWorker` takes to start a NEW agent for the
 *  card; a mind without one refuses it. The card then names the agent (and for a new one its
 *  model and effort, when the start names them), is in progress, and has a note of it; and the
 *  agent gets ONE message, `briefOf`, with `message` added as the caller's own words.
 *  It answers `{ repo, file, agent, model, effort, starting, running, card }`. `starting`: a new
 *  agent was asked for; `running`: what the start said of how many run beside it, or null. */
export async function taskAssign(itx, input, deps, now = new Date()) {
  if (!isObject(input) || (input.agent === undefined) === (input.worker === undefined))
    throw new Error(
      "taskAssign takes { file, agent } for an agent that runs, or { file, worker } for a new one; and message?, repo?, by?.",
    );
  const { file, worker } = input;
  if (typeof file !== "string" || !isTaskPath(file))
    throw new Error('taskAssign: file is a task\'s path, like "tasks/a-task.md".');
  if (worker !== undefined && !isObject(worker))
    throw new Error(
      "taskAssign: worker is what this mind's start of a new agent takes, as an object.",
    );
  if (worker !== undefined && !deps.startWorker)
    throw new Error(
      "taskAssign: this mind starts no new agent for a card. Give the card to an agent that runs: { file, agent }.",
    );
  const repo = await repoOf("taskAssign", itx, input.repo);
  const by = callerOf(input, deps);
  const handle = itx.repos.get(repo);
  const tip = await handle.tip();
  const before = tip ? await handle.readFile(file, { commitOid: tip }) : null;
  if (before === null)
    throw new Error(`taskAssign: ${repo} has no ${file}. Open the card first (taskOpen).`);

  let agent = oneLine(input.agent);
  let model = "";
  let effort = "";
  let running = null;
  if (worker) {
    const started = await deps.startWorker(itx, { worker, by, file, repo });
    agent = started.agent;
    model = oneLine(started.model);
    effort = oneLine(started.effort);
    running = started.running ?? null;
  } else if (!agent.startsWith("/agents/") || !(await deps.isAgent(agent))) {
    throw new Error(
      `taskAssign: ${agent || "that"} is no agent, or it has not said what it is yet.`,
    );
  } else {
    const gone = await goneOf(itx, agent, await deps.agentRow?.(agent), now.getTime(), deps);
    if (gone)
      throw new Error(
        `taskAssign: ${agent} ${gone}. Nobody would read the card. Give it to an agent that runs; name ${agent} in the card's text when its log helps the new one.`,
      );
  }

  // the card first: the message points to it
  const open = ["backlog", "todo"].includes(parseTask(file, before).column);
  // for a new agent the note says what is true now: it was asked for, and is not yet up
  const note = worker
    ? `A new worker was asked for: ${agent}${model ? ` (${[model, effort].filter(Boolean).join(", ")})` : ""}.`
    : `Given to ${agent}.`;
  const change = {
    agent,
    model: model || undefined,
    effort: effort || undefined,
    ...(open && { status: "in-progress" }),
    note,
  };
  const again = `call taskAssign again with { file: ${JSON.stringify(file)}, agent: ${JSON.stringify(agent)} }`;
  const done = await writeTask(itx, "taskAssign", {
    repo,
    file,
    via: by,
    changes: changesOf(file, change, by, now),
  }).catch((error) => {
    throw new Error(
      `taskAssign: the card was not written (${wordsOf(error)}).${worker ? ` The worker ${agent} was asked for: ${again}.` : ""}`,
    );
  });
  const rules = (await deps.briefRules?.({ repo, file, agent, worker: Boolean(worker) })) ?? [];
  await itx.agents
    .get(agent)
    .message(briefOf({ repo, file, agent, by, words: oneLine(input.message), rules }))
    .catch((error) => {
      throw new Error(
        `taskAssign: the card names ${agent}, and the message to it failed (${wordsOf(error)}): ${again}.`,
      );
    });
  return {
    repo,
    file,
    agent,
    model: model || null,
    effort: effort || null,
    starting: Boolean(worker),
    running,
    card: cardOf(file, done.source),
  };
}
