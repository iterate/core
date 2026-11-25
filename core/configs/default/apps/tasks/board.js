// board.js — THE BOARD AS DATA, for an agent: `itx.config.taskBoard({ repo? })` (api.ts). One
// call answers what the board shows a person and what the change feed remembers, so that an agent
// with no history (a manager that starts cold, a worker that takes work over) can say what runs,
// what is stuck and what waits for a person, and then follow what it cares about (feed.js).
//
// WHAT IT HOLDS. Every task of the repo as its card (public/tasks-model.js `parseTask`: file,
// title, status, column, tags, priority, size, owner, agent, blockedOn, humanAsk), each with the
// newest answers that people gave to its asks (`answersOf`: the decisions made), its last change
// as the feed has it (when, by whom, one line), and, for a task that names an agent, that agent's
// row in the mind's catalog (`agentSeen`: whether it has work now, and when it last had) and
// whether that agent follows the card (`agentFollows`: false means that the agent never took the
// card); the files that need a person, in the page's order; the newest changes of the whole
// board; and who follows what.
//
// WHAT IT DOES NOT HOLD, so say so when you answer from it: the rest of a task's text (read the
// file); what a task's agent is doing (read its log, or ask it); work that nobody wrote into a
// task (open pull requests, the merge and deploy queue); and a change older than the feed's
// reach (`lastChange: null`).
import { boardPathOf, feedOf, repoOf, TASK_CHANGED, taskFollowers } from "./feed.js";
import { answersOf, needsAPerson, tasksOf, TASKS_DIR } from "./public/tasks-model.js";

/** How many of the board's newest changes are answered. */
const RECENT_CHANGES = 30;
/** How many of a task's newest answers are answered, each cut to this many characters. */
const ANSWERS = 5;
const ANSWER_CHARS = 500;
/** How far back the feed's log is read for the newest changes: its newest offsets. */
const LOG_REACH = 400;
/** How many of the catalog's most active agents are asked for. */
const CATALOG_ROWS = 500;

/** The feed's log of `repo`, read from its end: the changes, newest first; and who follows. None
 *  for a repo whose log does not exist yet: a read of it would make it (the catalog says so, and
 *  the catalog's rows lag, so a log that was made a moment ago reads as none). */
async function rememberedOf(itx, repo) {
  const path = boardPathOf(feedOf(repo));
  const listed = await itx.contexts.list({ under: feedOf(repo).root, limit: 200 });
  if (!listed.some((context) => context.path === path)) return { changes: [], followers: [] };
  const log = itx.cd(path);
  const head = (await log.readEvents(Number.MAX_SAFE_INTEGER, 1)).scannedThroughOffset ?? 0;
  const { events } = await log.readEvents(Math.max(0, head - LOG_REACH), LOG_REACH);
  const changes = events
    .filter((event) => event.type === TASK_CHANGED)
    .map(({ payload }) => ({
      at: payload.committedAt,
      by: payload.by,
      file: payload.file,
      change: payload.change,
      summary: payload.summary,
    }))
    .reverse();
  return { changes, followers: await taskFollowers(itx, { repo }) };
}

/** `itx.config.taskBoard({ repo? })`: the board of the tasks repo, or of the repo `repo` names, as
 *  data. It answers `{ repo, commitOid, board, tasks, needsAPerson, recentChanges, followers }`. */
export async function taskBoard(itx, input) {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input)))
    throw new Error("taskBoard takes { repo? }, or nothing for the tasks repo.");
  const repo = await repoOf("taskBoard", itx, input?.repo);
  const handle = itx.repos.get(repo);
  const commitOid = await handle.tip();
  const under = commitOid ? await handle.modules({ commitOid, dir: TASKS_DIR }) : {};
  const tasks = tasksOf(
    Object.fromEntries(Object.entries(under).map(([path, text]) => [`${TASKS_DIR}/${path}`, text])),
  );
  const { changes, followers } = await rememberedOf(itx, repo);
  const lastChangeOf = (file) => {
    const last = changes.find((change) => change.file === file);
    return last ? { at: last.at, by: last.by, summary: last.summary } : null;
  };
  // the agents that tasks name, as the mind's catalog has them: one call, and it wakes none. The
  // catalog answers its most active rows, so an agent that is long idle may not be among them.
  const named = tasks.some((task) => task.agent.startsWith("/agents/"));
  const catalog = new Map(
    (named ? await itx.contexts.list({ under: "/agents", limit: CATALOG_ROWS }) : []).map((row) => [
      row.path,
      row,
    ]),
  );
  const agentSeenOf = (agent) => {
    const row = catalog.get(agent);
    return row ? { awake: Boolean(row.awake), lastActivityAt: row.lastActivityAt ?? null } : null;
  };
  const name = repo.split("/").at(-1);
  return {
    repo,
    commitOid,
    /** the same board for a person */
    board: `https://tasks.${new URL(await itx.url()).hostname}/?repo=${encodeURIComponent(name)}`,
    tasks: tasks.map((task) => ({
      file: task.path,
      title: task.title,
      status: task.status,
      column: task.column,
      tags: task.tags,
      priority: task.priority,
      size: task.size,
      owner: task.owner,
      agent: task.agent,
      /** that agent in the mind's catalog: has it work now, when did it last; null: not among the catalog's rows (or no agent) */
      agentSeen: agentSeenOf(task.agent),
      /** whether that agent follows this card (or every card); null: no agent. An agent that is
       *  given a card follows it as its first act (cards.js `briefOf`), so a card in progress
       *  whose agent does not follow it was not taken: the agent may be gone. The catalog cannot
       *  say that (a session whose workspace was closed stays "idle" there). */
      agentFollows: task.agent
        ? followers.some(
            (each) =>
              each.agent === task.agent &&
              (each.follows === task.path || each.follows === "every task"),
          )
        : null,
      blockedOn: task.blockedOn || null,
      humanAsk: task.humanAsk,
      /** what people answered to its earlier asks, oldest first: the newest few */
      answers: answersOf(task.source)
        .slice(-ANSWERS)
        .map((each) => ({
          ...each,
          answer:
            each.answer.length > ANSWER_CHARS
              ? `${each.answer.slice(0, ANSWER_CHARS - 1)}…`
              : each.answer,
        })),
      lastChange: lastChangeOf(task.path),
    })),
    /** the files of the tasks that are not done and ask a person something */
    needsAPerson: needsAPerson(tasks).map((task) => task.path),
    recentChanges: changes.slice(0, RECENT_CHANGES),
    followers: followers.map(({ agent, follows, only }) => ({
      agent,
      follows,
      only,
    })),
  };
}
