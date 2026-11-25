// feed.js — THE TASK CHANGE FEED: one event for each task file that a commit to a repo of the mind
// changed, on ONE log for each repo, so an agent or a page follows a task, or a whole board,
// without polling and without any worker sending updates. Pure data: no agent and no context for a
// file, no model call, and no state of its own. every-event.ts hands `taskChangesEvent` every event of
// the mind.
//
// WHICH REPOS. Every repo of the mind, /repos/<name>: its task files are the Markdown files under
// tasks/ (tasks-model.js `TASKS_DIR`), as the board reads them. The tasks repo, /repos/tasks
// (`TASKS_REPO`), is the one that a call follows when it names no repo. A repo with no tasks/
// costs nothing here: a commit that names its files and no task file is not read.
//
// THE LOG of a repo is `/task-files/<repo name>`: `/task-files/tasks` for /repos/tasks. (`/tasks/`
// was taken: /tasks/native-indexing means something else.) Each event there is
// `events.iterate.com/tasks/task-changed`:
//   { repo, file, change: "added" | "modified" | "deleted", moved, commitOid, beforeOid,
//     commitOffset, committedAt, message, by, page, via, before, after, summary, diff,
//     diffOmitted? }
// `before` and `after` are the card (`cardOf`: title, status, tags, owner, agent, blockedOn,
// humanAsk), null when there is no such file. `moved` names what the change moved (`MOVES`: the
// card's fields, or "text" when it moved none). `summary` is one line that says what changed: each
// field of the card that moved, and an ask that was answered with its answer. `diff`
// is a line diff of at most MAX_DIFF_BYTES, else null with `diffOmitted`. `by` is who made the
// commit, by the platform's stamp on its fact: the person who asked (an address), else the agent
// whose turn caused it (its path), else null. `page` is where that person acted, by the same
// stamp: an app's page ("tasks.iterate.com": the person's own act on the board), or null for a
// script through the person's sign-in. `via` is the commit message's own `Via:` line, or
// null: an agent's session that commits through a person's sign-in is stamped as that person, and
// this line is where it says who it is.
//
// HOW AN AGENT FOLLOWS (`followTasks`, below). From its own script:
//   await itx.config.followTasks({ file: "tasks/a-task.md" })   // or no `file`: every task
// From a member's script or the MCP `run` tool, name the agent: `{ file, agent: "/agents/…" }`.
// For a task of another repo, name it: `{ file, repo: "<name>" }`. For some changes and no other:
// `{ only: ["status", "blocked-on", "human-ask"] }` (a manager's follow: no note wakes it).
// Each change then reaches the agent as a message, with the summary and the diff.
// `itx.config.unfollowTasks(…)` ends it and `itx.config.taskFollowers()` lists who follows what.
// A follower is one durable row on the log (`followRowOf`): the platform copies each event the row
// takes to the agent as `agent/message-received`, with the row's own retries. A page listens to
// the log for as long as its session lives:
//   itx.cd("/task-files/tasks").subscribe({ consumes: [TASK_CHANGED], target: (events) => … })
//
// WHAT "BEFORE" IS. The repo's own log holds one `repo/commit-completed` for each update of main,
// in order. "Before" is the commit of the fact before this one on that log. So an event says
// exactly what one update of main changed, whether that was one commit or a pull of several, and
// two commits that arrive here at once, or the wrong way round, cannot mix. The files that changed
// are read from the folder at the two commits, never from the fact's `changedPaths`: a `git push`
// to the repo lands a fact that names no file.
//
// ORDER. The hook gets events in no order, so two commits a second apart can be told the other
// way round. Each event is exact by itself, and `commitOffset` (the fact's offset on the repo's
// log) says which is newer.
//
// BOUNDS. At most MAX_FILES events for one fact; past it one `tasks/feed-truncated` names the rest.
// A diff over MAX_DIFF_BYTES, or of a file over MAX_FILE_BYTES, is left out with a flag.
//
// WHY IT CANNOT LOOP. It reads the repo and appends to /task-files/…; it never commits, and no code
// acts on the types it appends. A fact that is delivered twice adds nothing: an event's key is the
// fact's place in the repo's log and the file.
import { answersOf, parseTask, TASKS_DIR, TASKS_REPO } from "./public/tasks-model.js";

/** A repo's feed: the repo, the folder whose Markdown files are its tasks (tasks-model.js names it,
 *  for the board too), and the context that the feeds' logs are under. */
export const feedOf = (repo) => ({ repo, dir: TASKS_DIR, root: "/task-files" });
/** The feed of the tasks repo: what a call follows when it names no repo. */
export const TASK_FEED = feedOf(TASKS_REPO);
/** A repo of the mind, by its path. */
const REPO_PATH = /^\/repos\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const TASK_CHANGED = "events.iterate.com/tasks/task-changed";
export const FEED_TRUNCATED = "events.iterate.com/tasks/feed-truncated";
const COMMIT_COMPLETED = "events.iterate.com/repo/commit-completed";
const ROW_CONFIGURED = "events.iterate.com/itx/subscription-configured";
export const MAX_FILES = 20;
export const MAX_DIFF_BYTES = 4096;
export const MAX_FILE_BYTES = 65536;
/** A line diff compares at most this many pairs of lines; past it the changed middle is one block. */
const MAX_DIFF_CELLS = 250_000;
/** How many unchanged lines a diff shows around a change. */
const DIFF_CONTEXT = 2;
/** The platform's bound on a row's expression (core/itx/src/stream/event-expressions.ts). */
const MAX_EXPRESSION_CHARS = 1024;
/** The names of the rows that make an agent a follower begin with this. */
const FOLLOW_ROW = "task-follow-";

const bytes = (text) => new TextEncoder().encode(text).length;
const isMarkdown = (path) => /\.(?:md|markdown)$/i.test(path);

/** Whether `path` of the repo is a task file of this feed. */
export const isTaskFile = (feed, path) =>
  (!feed.dir || path.startsWith(`${feed.dir}/`)) && isMarkdown(path);

/** The feed's log: `/task-files/tasks` for /repos/tasks. */
export const boardPathOf = (feed) => `${feed.root}/${feed.repo.split("/").at(-1)}`;

/** What a reader of the feed wants of one version of a task file; null when there is none. */
function cardOf(file, source) {
  if (source === null || source === undefined) return null;
  const task = parseTask(file, source);
  return {
    title: task.title,
    status: task.status,
    tags: task.tags,
    owner: task.owner,
    agent: task.agent,
    blockedOn: task.blockedOn || null,
    humanAsk: task.humanAsk.length > 0 ? task.humanAsk : null,
  };
}

// ── the diff ──

/** The changed middle of two lists of lines as steps: " " kept, "-" removed, "+" added. The
 *  longest common run of lines is kept; two lists too long to compare are one block each. */
function stepsOf(a, b) {
  if (a.length * b.length > MAX_DIFF_CELLS)
    return [...a.map((line) => ["-", line]), ...b.map((line) => ["+", line])];
  const width = b.length + 1;
  // common[i * width + j]: how many lines the longest common run of a[i..] and b[j..] has
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      common[i * width + j] =
        a[i] === b[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
  const steps = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      steps.push([" ", a[i]]);
      i += 1;
      j += 1;
    } else if (
      j >= b.length ||
      (i < a.length && common[(i + 1) * width + j] >= common[i * width + j + 1])
    ) {
      steps.push(["-", a[i]]);
      i += 1;
    } else {
      steps.push(["+", b[j]]);
      j += 1;
    }
  }
  return steps;
}

/** A small unified diff of two texts: each changed stretch with DIFF_CONTEXT lines around it, under
 *  a `@@ -line,count +line,count @@` header. Empty when the texts are equal. */
export function lineDiff(before, after) {
  if (before === after) return "";
  // the line end of the last line is no line of its own, unless only one of the texts has it
  const sameEnd = before === "" || after === "" || before.endsWith("\n") === after.endsWith("\n");
  const linesOf = (text) =>
    text === "" ? [] : (sameEnd ? text.replace(/\n$/, "") : text).split("\n");
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const steps = [
    ...a.slice(0, head).map((line) => [" ", line]),
    ...stepsOf(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((line) => [" ", line]),
  ];
  // each step's line number in the two texts
  const lineOfA = [];
  const lineOfB = [];
  let atA = 1;
  let atB = 1;
  for (const [kind] of steps) {
    lineOfA.push(atA);
    lineOfB.push(atB);
    if (kind !== "+") atA += 1;
    if (kind !== "-") atB += 1;
  }
  // the stretches to show: each change with its context, two that touch as one
  const stretches = [];
  steps.forEach(([kind], at) => {
    if (kind === " ") return;
    const from = Math.max(0, at - DIFF_CONTEXT);
    const to = Math.min(steps.length, at + 1 + DIFF_CONTEXT);
    const last = stretches.at(-1);
    if (last && from <= last.to) last.to = to;
    else stretches.push({ from, to });
  });
  return stretches
    .map(({ from, to }) => {
      const shown = steps.slice(from, to);
      const countA = shown.filter(([kind]) => kind !== "+").length;
      const countB = shown.filter(([kind]) => kind !== "-").length;
      // as `diff -u` writes a side with no line: the line before it
      const header = `@@ -${countA ? lineOfA[from] : lineOfA[from] - 1},${countA} +${countB ? lineOfB[from] : lineOfB[from] - 1},${countB} @@`;
      return [header, ...shown.map(([kind, line]) => kind + line)].join("\n");
    })
    .join("\n");
}

// ── one file's change ──

const cut = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

/** One line that says what changed, for a follower: who (on which page, when the person acted on
 *  one, and through which agent's session, when the commit says so), and each field of the card
 *  that moved. An ask that left `human-ask:` with
 *  an answer in the text (`answers`: the text's `## Answers`, tasks-model.js `answersOf`) is told
 *  with its answer, since that is the news. */
function summaryOf(file, change, before, after, { by, page, via }, answers) {
  const who = `${by ? ` by ${by}${page ? ` on ${page}` : ""}` : ""}${via ? ` via ${via}` : ""}`;
  if (change === "added")
    return `${file} added${who}: "${after.title}", status ${after.status || "none"}`;
  if (change === "deleted") return `${file} deleted${who}: "${before.title}"`;
  const said = [];
  const tell = (label, was, is) => {
    if (was !== is) said.push(`${label} ${was || "none"} → ${is || "none"}`);
  };
  tell("status", before.status, after.status);
  if (before.title !== after.title) said.push(`title "${before.title}" → "${after.title}"`);
  tell("owner", before.owner, after.owner);
  tell("agent", before.agent, after.agent);
  tell("tags", before.tags.join(", "), after.tags.join(", "));
  tell("blocked-on", before.blockedOn, after.blockedOn);
  const asked = before.humanAsk || [];
  const asks = after.humanAsk || [];
  const added = asks.filter((ask) => !asked.includes(ask)).length;
  const gone = asked.filter((ask) => !asks.includes(ask));
  const answered = gone.map((ask) => answers.findLast((each) => each.ask === ask)).filter(Boolean);
  for (const each of answered)
    said.push(
      `answered "${cut(each.ask, 70)}": ${cut(each.answer || "(no words)", 160)}${each.by === by ? "" : ` (${each.by})`}`,
    );
  const removed = gone.length - answered.length;
  if (added || removed) said.push(`human-ask +${added} -${removed} (now ${asks.length})`);
  // none of the card's fields moved: the text below the frontmatter did
  if (said.length === 0) said.push("its text");
  return `${file} changed${who}: ${said.join("; ")}`;
}

/** WHAT A CHANGE CAN MOVE, by name: a file that came or went; for a file that changed, each field
 *  of its card; and "text" for a change that moved no field (a note, an edit of the body). An
 *  event's `moved` lists them, and a follower that asks for some (`followTasks({ only })`) is told
 *  of those changes alone: a manager hears of a status, a blocker or an ask, and not of each note. */
export const MOVES = [
  "added",
  "deleted",
  "status",
  "title",
  "owner",
  "agent",
  "tags",
  "blocked-on",
  "human-ask",
  "text",
];

function movedOf(change, before, after) {
  if (change !== "modified") return [change];
  const differ = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  const moved = [
    before.status !== after.status && "status",
    before.title !== after.title && "title",
    before.owner !== after.owner && "owner",
    before.agent !== after.agent && "agent",
    differ(before.tags, after.tags) && "tags",
    before.blockedOn !== after.blockedOn && "blocked-on",
    differ(before.humanAsk, after.humanAsk) && "human-ask",
  ].filter(Boolean);
  return moved.length > 0 ? moved : ["text"];
}

/** One file's change in one update of main, as the event's payload. `fact` says which update
 *  (`{ commitOid, beforeOid, commitOffset, committedAt, message, by, page, via }`); `before` and `after` are
 *  the file's text at its two commits (null: no such file). */
export function taskChangeOf({ feed, fact, file, before, after }) {
  const change = after === null ? "deleted" : before === null ? "added" : "modified";
  const cards = { before: cardOf(file, before), after: cardOf(file, after) };
  const payload = {
    repo: feed.repo,
    file,
    change,
    moved: movedOf(change, cards.before, cards.after),
    ...fact,
    ...cards,
    summary: summaryOf(
      file,
      change,
      cards.before,
      cards.after,
      fact,
      after === null ? [] : answersOf(after),
    ).slice(0, 400),
    diff: null,
  };
  if (bytes(before || "") > MAX_FILE_BYTES || bytes(after || "") > MAX_FILE_BYTES)
    return { ...payload, diffOmitted: "file-too-large" };
  const diff = lineDiff(before || "", after || "");
  return bytes(diff) > MAX_DIFF_BYTES
    ? { ...payload, diffOmitted: "diff-too-large" }
    : { ...payload, diff };
}

// ── a commit, told ──

const isFactOf = (feed, event) =>
  event?.type === COMMIT_COMPLETED &&
  event.path === feed.repo &&
  event.payload?.path === feed.repo &&
  Boolean(event.payload.commitOid);

/** Who made the commit, by the platform's stamp on its fact: the person who asked (an address),
 *  else the context whose event caused it (an agent's path, without the event's offset), else null. */
function byOf(source) {
  const who = source?.principal || source?.onBehalfOf?.principal;
  if (who?.email || who?.actor) return who.email || who.actor;
  const cause = source?.cause?.parent;
  return typeof cause === "string" && cause.startsWith("/") ? cause.replace(/@\d+$/, "") : null;
}

/** Where the person acted, by the platform's stamp: the page of an app ("tasks.iterate.com" for
 *  an edit or an answer on the board). Null for a script through a person's sign-in (the MCP `run`
 *  tool, the CLI: an agent's session, or the person's own script) and for an agent's own turn. So
 *  a change `by` an address with a page is that person's own act, and one with no page is not
 *  proven to be. */
function pageOf(source) {
  const page = source?.onBehalfOf?.via?.appPage;
  return typeof page === "string" && page ? page.slice(0, 120) : null;
}

/** Whose session made the commit for that person, in the commit's own words: its `Via:` line (the
 *  mind's rule for a commit that an agent makes through a person's sign-in, where the platform's
 *  stamp names the person alone). The agent's word, not the platform's. Null when it has none. */
const viaOf = (message) =>
  /^Via: (.+)$/m
    .exec(message || "")?.[1]
    .trim()
    .slice(0, 120) || null;

/** The commit that main was at before the fact at `offset` of the repo's log: the commit of the
 *  newest earlier fact there. Null when the log has none (the repo's first commit). It reads the
 *  log just below `offset`, and further back only when that stretch holds no fact. */
async function tipBefore(log, feed, offset) {
  for (let reach = 64; ; reach *= 8) {
    const start = Math.max(0, offset - 1 - reach);
    let found = null;
    for (let after = start; after < offset - 1;) {
      const page = await log.readEvents(after, 200);
      for (const event of page.events)
        if (event.offset < offset && isFactOf(feed, event)) found = event;
      const through = Math.max(page.scannedThroughOffset ?? 0, page.events.at(-1)?.offset ?? 0);
      if (through <= after) break;
      after = through;
    }
    if (found) return found.payload.commitOid;
    if (start === 0) return null;
  }
}

/** The task files at a commit, by their path in the repo; none for no commit. A file that is not
 *  text is left out (`repo.modules`). */
async function folderAt(repo, feed, commitOid) {
  if (!commitOid) return {};
  const under = await repo.modules({ commitOid, dir: feed.dir || undefined });
  const prefix = feed.dir ? `${feed.dir}/` : "";
  return Object.fromEntries(
    Object.entries(under)
      .filter(([path]) => isMarkdown(path))
      .map(([path, text]) => [prefix + path, text]),
  );
}

/** Append, and take a second landing of the same key as done. */
async function appendOnce(log, event) {
  await log.append(event).catch((error) => {
    if (
      (error?.code ?? error?.data?.code) !== "IDEMPOTENCY_CONFLICT" &&
      !/IDEMPOTENCY_CONFLICT/.test(String(error))
    )
      throw error;
  });
}

async function tellChanges(itx, event, feed) {
  const commit = event.payload;
  const beforeOid = await tipBefore(itx.cd(feed.repo), feed, event.offset);
  // the same tip, announced again (`repo.announceTip`)
  if (beforeOid === commit.commitOid) return;
  const repo = itx.repos.get(feed.repo);
  const [was, now] = await Promise.all([
    folderAt(repo, feed, beforeOid),
    folderAt(repo, feed, commit.commitOid),
  ]);
  const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])]
    .filter((file) => was[file] !== now[file])
    .sort();
  if (changed.length === 0) return;
  const fact = {
    commitOid: commit.commitOid,
    beforeOid,
    commitOffset: event.offset,
    committedAt: event.createdAt ?? null,
    message: (commit.message || "").split("\n")[0].slice(0, 200),
    by: byOf(event.source),
    page: pageOf(event.source),
    via: viaOf(commit.message),
  };
  const at = `${feed.repo}@${event.offset}`;
  const events = changed.slice(0, MAX_FILES).map((file) => ({
    type: TASK_CHANGED,
    idempotencyKey: `tasks/task-changed:${at}:${file}`,
    payload: taskChangeOf({
      feed,
      fact,
      file,
      before: was[file] ?? null,
      after: now[file] ?? null,
    }),
  }));
  const skipped = changed.slice(MAX_FILES);
  if (skipped.length > 0)
    events.push({
      type: FEED_TRUNCATED,
      idempotencyKey: `tasks/feed-truncated:${at}`,
      payload: {
        repo: feed.repo,
        commitOid: commit.commitOid,
        commitOffset: event.offset,
        total: changed.length,
        sent: MAX_FILES,
        skipped: skipped.slice(0, 100),
      },
    });
  // one after the other, so the log has them in the files' order; a file that fails holds no other
  const log = itx.cd(boardPathOf(feed));
  let failure;
  for (const each of events) await appendOnce(log, each).catch((error) => (failure ??= error));
  if (failure) throw failure;
}

/** every-event.ts's hook: an update of a repo's main, as the repo's own copy of its fact (the root has
 *  a copy too, at an offset of the root's log). The feed is the repo's own, by the event's path.
 *  One more try after a failure: a run that is repeated adds nothing twice. */
export async function taskChangesEvent(itx, event) {
  if (event?.type !== COMMIT_COMPLETED || !REPO_PATH.test(event.path || "")) return;
  const feed = feedOf(event.path);
  if (!isFactOf(feed, event)) return;
  // a commit that names its files and names no task file: nothing to read
  const named = event.payload.changedPaths || [];
  if (named.length > 0 && !named.some((path) => isTaskFile(feed, path))) return;
  await tellChanges(itx, event, feed).catch(() =>
    new Promise((done) => setTimeout(done, 300)).then(() => tellChanges(itx, event, feed)),
  );
}

// ── followers ──

/** A short hash of a string (FNV-1a, 32 bits): a row's name only has to differ when its row does. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** THE ROW THAT MAKES `agent` A FOLLOWER of one task file, or with no `file` of every task: a copy
 *  row on the feed's log. The platform copies each `task-changed` the row takes to the agent's own
 *  context as `agent/message-received`, the one input every kind of agent reads, so the agent is
 *  told as if someone wrote to it. `wake: false`: the words are context only (`trigger: false`).
 *  The agent is not told of a commit that it made itself: one that its own turn caused (`by` is
 *  then its path), or one whose message names it (`via`, a session's `Via: <its path>`).
 *  `only`: some of MOVES; the row then takes the changes that moved one of them, and no other.
 *  One row for each (agent, file): following again writes the same row, with the new `only`. */
export function followRowOf(feed, { agent, file, wake = true, only = [] }) {
  const what = `${file || "every task"}${only.length > 0 ? ` (only a change of: ${only.join(", ")})` : ""}`;
  const moves =
    only.length > 0
      ? ` and (${only.map((move) => `${JSON.stringify(move)} in payload.moved`).join(" or ")})`
      : "";
  // the call that ends it, with the repo's name: a mind chooses which repo a call with none means
  const named = {
    agent,
    file: file || undefined,
    repo: feed.repo.split("/").at(-1),
  };
  const stop = `await itx.config.unfollowTasks(${JSON.stringify(named)})`;
  const words = [
    `{ "message": "A task changed: " & payload.summary`,
    ` & (payload.diff ? "\\n\\n" & payload.diff : " (no diff here: " & payload.diffOmitted & "; read the file)")`,
    ` & ${JSON.stringify(`\n\nYou follow ${what} of ${feed.repo}. To stop: ${stop}`)}`,
    wake ? " }" : `, "trigger": false }`,
  ].join("");
  if (words.length > MAX_EXPRESSION_CHARS)
    throw new Error(
      `followTasks: the agent's path and the file's are too long together for one row (${words.length} of ${MAX_EXPRESSION_CHARS} characters).`,
    );
  return {
    name: `${FOLLOW_ROW}${fnv1a(`${agent}\n${file || ""}`)}`,
    consumes: [TASK_CHANGED],
    filter: `${file ? `payload.file = ${JSON.stringify(file)} and ` : ""}payload.by != ${JSON.stringify(agent)} and payload.via != ${JSON.stringify(agent)}${moves}`,
    target: { path: agent, type: "events.iterate.com/agent/message-received", payload: words },
  };
}

/** The repo a call is about, by its path: the one it names (`"tasks"` or `"/repos/tasks"`), else
 *  the tasks repo. A repo that the mind does not have is refused: a row on its log would wait for
 *  ever, and a read of it would fail with other words. (asks.js uses it too.) */
export async function repoOf(tool, itx, named) {
  const repo =
    named === undefined
      ? TASKS_REPO
      : typeof named === "string" && named.startsWith("/")
        ? named
        : `/repos/${named}`;
  if (!REPO_PATH.test(repo))
    throw new Error(`${tool}: repo is a repo's name or its path, like "tasks" or "/repos/tasks".`);
  const repos = await itx.repos.list();
  if (!repos.some((each) => each.path === repo))
    throw new Error(`${tool}: the mind has no repo ${repo}.`);
  return repo;
}
const feedFor = async (tool, itx, named) => feedOf(await repoOf(tool, itx, named));

/** What a follower's row follows, read from its filter (`followRowOf` wrote it): the file that it
 *  names first, or every task. */
function followedOf(filter) {
  const named = /^payload\.file = ("(?:[^"\\]|\\.)*")/.exec(filter || "");
  return named ? JSON.parse(named[1]) : "every task";
}
/** The moves that a follower's row is for, read from its filter; null: every change. */
function onlyOf(filter) {
  const moves = [...(filter || "").matchAll(/"([a-z-]+)" in payload\.moved/g)].map(
    (found) => found[1],
  );
  return moves.length > 0 ? moves : null;
}

/** Who a call is for: the agent it names, else the agent whose context it came from. */
async function followerOf(tool, input, { callerPath, isAgent }) {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input)))
    throw new Error(`${tool} takes { file?, agent?, repo? }.`);
  const asked = input ?? {};
  const only = asked.only === undefined ? [] : [asked.only].flat();
  if (only.some((move) => !MOVES.includes(move)) || (asked.only !== undefined && only.length === 0))
    throw new Error(`${tool}: only is a list of what a change moved, from: ${MOVES.join(", ")}.`);
  let caller;
  try {
    caller = callerPath();
  } catch {
    caller = undefined;
  }
  const agent =
    asked.agent ??
    (typeof caller === "string" && caller.startsWith("/agents/") ? caller : undefined);
  if (typeof agent !== "string" || !agent.startsWith("/agents/"))
    throw new Error(
      `${tool}: this call came from no agent's context: name the agent, { agent: "/agents/…" }.`,
    );
  // the one gate that says a path is an agent: a row for any other path would write to it
  if (!(await isAgent(agent)))
    throw new Error(`${tool}: ${agent} is no agent, or it has not said what it is yet.`);
  return { agent, file: asked.file, wake: asked.wake !== false, only: [...new Set(only)] };
}

/** `itx.config.followTasks({ file?, agent?, wake?, only?, repo? })`: from now on `agent` (the
 *  calling agent when not named) is told of each change of the task file `file`, or of every task,
 *  of the tasks repo or of the repo `repo` names. `only`: some of MOVES, for the changes that
 *  moved one of them and no other (`only: ["status", "blocked-on", "human-ask"]` leaves out each
 *  note and each edit of a text). It answers what is followed. A task that the repo does not have
 *  is refused: its row would wait for ever. */
export async function followTasks(itx, input, deps) {
  const { agent, file, wake, only } = await followerOf("followTasks", input, deps);
  const feed = await feedFor("followTasks", itx, input?.repo);
  if (file !== undefined) {
    if (typeof file !== "string" || !isTaskFile(feed, file))
      throw new Error(
        `followTasks: file is a task's path in ${feed.repo}, like "${feed.dir ? `${feed.dir}/` : ""}a-task.md".`,
      );
    if ((await itx.repos.get(feed.repo).readFile(file)) === null)
      throw new Error(`followTasks: ${feed.repo} has no ${file}.`);
  }
  const row = followRowOf(feed, { agent, file, wake, only });
  const log = boardPathOf(feed);
  await itx.cd(log).append({ type: ROW_CONFIGURED, payload: row });
  return {
    agent,
    follows: file ?? "every task",
    only: only.length > 0 ? only : null,
    repo: feed.repo,
    log,
    row: row.name,
  };
}

/** `itx.config.unfollowTasks({ file?, agent?, repo? })`: ends what `followTasks` with the same
 *  `file` (or with none) and the same repo began. It answers whether there was such a row. */
export async function unfollowTasks(itx, input, deps) {
  const { agent, file } = await followerOf("unfollowTasks", input, deps);
  const feed = await feedFor("unfollowTasks", itx, input?.repo);
  const { name } = followRowOf(feed, { agent, file });
  const log = itx.cd(boardPathOf(feed));
  const followed = (await log.subscriptions.list()).some((row) => row.name === name);
  if (followed) await log.append({ type: ROW_CONFIGURED, payload: { name, target: null } });
  return { agent, follows: file ?? "every task", repo: feed.repo, ended: followed };
}

/** `itx.config.taskFollowers({ repo? })`: who follows what in the tasks repo, or in the repo that
 *  `repo` names, read from the rows of its log. */
export async function taskFollowers(itx, input) {
  const feed = await feedFor("taskFollowers", itx, input?.repo);
  const rows = await itx.cd(boardPathOf(feed)).subscriptions.list();
  return rows
    .filter((row) => row.name.startsWith(FOLLOW_ROW) && row.copy)
    .map((row) => ({
      agent: row.copy.path,
      follows: followedOf(row.filter),
      only: onlyOf(row.filter),
      repo: feed.repo,
      row: row.name,
    }));
}
