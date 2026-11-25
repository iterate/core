// askers.js — WHO ASKED: `itx.config.taskAskers({ repo? })` (api.ts) answers, for each ask that a
// task still has (a line of its `human-ask:`), the agent that added it. The board's "Needs a
// person" shows that agent beside the ask as a link to its chat in the Dash (public/app.js `Ask`),
// so that a person can ask it why before they answer. Misha asked for this on 20 Nov 2026
// (tasks/link-human-asks-to-the-agent-that-asked.md).
//
// WHERE THE ANSWER COMES FROM: THE CHANGE FEED, not git's author. Each commit to a repo of tasks
// is one `tasks/task-changed` event for each file on the repo's feed log (feed.js), with the card
// before and after it and who made the commit: `via`, the commit message's own `Via:` line (the
// three card calls write it: cards.js), and `by`, the platform's stamp (an agent's path for an
// agent's own turn, a person's address for a commit through their sign-in). The newest event in
// which an ask is in the card after and not in the card before is the commit that asked it: what
// `git blame` of the ask's line would say, with no blame call (the repo has none) and with the
// agent named even when the commit was made through a person's sign-in. Git's author is not used:
// an agent has no address to be an author with, and the platform stamps a commit's person itself.
//
// WHAT IT CANNOT SAY. An ask that is older than the feed's log (the log of /repos/tasks begins on
// 20 Nov 2026), that a person wrote by hand, or whose commit named no agent has `agent: null`.
// `by` then still names the person, when the feed has the commit. The page shows the task's own
// agent for such an ask, and says that it is the task's agent and not the asker.
//
// THE MESSAGE THAT ASKED (Jonas, 25 Nov 2026: link "the exact ask where available"). A row's
// `message` is `{ path, offset, words }`: the event of the asker's own log in which it asked, which the
// Dash's raw view of a context opens (public/tasks-model.js `eventPath`). It is found in two ways
// (`locateAsk`):
//   - an agent's own turn: the commit's fact on the repo's log names the event that caused it
//     (`source.cause.parent`, "/agents/x@123"). That is exact. It is the turn that wrote the ask
//     when the event holds the ask's words (`words: true`). When it does not, the ask was
//     written by code that an event set off (a request to be let in), and the event is what led
//     to the ask (`words: false`): the page says so, and does not call it the message;
//   - a coding session through a person's sign-in (the MCP `run` tool): the commit names no
//     event. The session's hooks land on the agent's log, and the tool call that made the commit
//     holds the ask's words: the LAST event of the two minutes before the commit whose payload
//     has the ask's beginning AND a call that writes an ask (`WRITES`). So an event that only
//     quotes the ask (a person's prompt, a message about the card) is not taken, and an ask that
//     the session wrote twice is the later call's. Nothing such: no message, and the page shows
//     the conversation alone. A match of words is never called more than "the message".
// A lookup reads the asker's log (a search by time, then one page), so its answer is kept: one
// `tasks/ask-located` event on the feed's log for each ask, read back with the changes. At most
// MAX_LOCATE asks are looked up in one call; the rest at the next. An ask with no message keeps
// `message: null`, and the page then links the asker's chat alone, as before.
//
// WHICH MODEL ASKED (Jonas, 25 Nov 2026: "it is mentioned which model has recommended this"). A
// row's `model` is `{ name, from }`, read from the asker's own log at the message that asked
// (`modelOf`), and from nothing else:
//   - `from: "llm-request"`: the turn is an LLM request of an iterate agent, and the request's
//     own event names the model that the platform called. That is the model of that turn;
//   - `from: "session-start"`: the turn is a Claude Code session's, and the newest SessionStart
//     hook before it names the model that the session started with. A person can change a
//     session's model later, and no event says so: the page says "at its session's start".
// A card's `model:` key is what a worker was ASKED to run on, and an agent's own words about its
// model are a claim: neither is read. With no such event, `model` is null and the page says
// "model unrecorded". ACP and Codex sessions have no such event today.
//
// THE AGENT'S BLOCKING MESSAGE (Jonas, 25 Nov 2026: "showing the last agent message is far more
// useful now than showing some tiny summary question"; the design and his yes are on the card
// tasks/link-tasks-asks-to-the-exact-message-in-dash.md). A row's `blocking` is `{ path, offset,
// text }`: the agent's own last words of the turn in which it asked, which the page shows under
// the question with no chat opened (`blockingOf`):
//   - an iterate agent: the text of the LLM request's result at the message that asked, without
//     its scripts;
//   - a Claude Code session: `last_assistant_message` of the first Stop hook AFTER the message
//     that asked. That event lands when the turn ends, so a read before then finds none yet
//     and the next read looks again. A new prompt before any Stop, or a day with neither, ends
//     the search: the ask then has no blocking message.
// The summary line in `human-ask:` stays the ask's identity: answers and decisions name an ask by
// its text. The text is a copy of at most BLOCKING_MAX characters, kept with the pointer on the
// feed's log. ACP and Codex sessions have no such event: `blocking` is null, and the page shows
// the summary alone.
import { boardPathOf, feedOf, repoOf, TASK_CHANGED } from "./feed.js";
import { tasksOf, TASKS_DIR } from "./public/tasks-model.js";

/** How many offsets of the feed's log one read takes. */
const PAGE = 200;

/** The feed's event that keeps where an ask's message is: `{ file, ask, commitOid, path, offset }`,
 *  `offset: null` when a lookup found none. */
export const ASK_LOCATED = "events.iterate.com/tasks/ask-located";
/** How many asks one call looks up, how near the commit (ms) the message must be. "No message" is
 *  kept once its commit is 5 minutes old (a session's hook can land after its commit). */
const MAX_LOCATE = 8;
const NEAR = 120_000;
/** A commit's time is the mind's, an event's is its own arrival: an event this much (ms) after the
 *  commit still counts as before it. */
const SLACK = 2_000;
/** What an event of a session must hold beside the ask's words: a call that writes an ask. */
const WRITES = /taskUpdate|taskOpen|commitFiles|human-ask/;
/** The rule that a kept answer was found by. A kept answer of an older rule is looked up again. */
const RULE = 4;
/** How many pages back from the message a session's start is looked for. */
const START_PAGES = 15;

/** The most of a blocking message that is kept. A session's Stop is looked for 3 pages after the
 *  ask, and after a day with no Stop the search ends. */
const BLOCKING_MAX = 4000;

const cutOf = (text) => {
  const said = String(text ?? "")
    .replace(/<codemode>[\s\S]*?(?:<\/codemode>|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return said.length > BLOCKING_MAX
    ? `${said.slice(0, BLOCKING_MAX).replace(/\s+\S*$/, "")} …`
    : said;
};

/** THE AGENT'S BLOCKING MESSAGE for the ask whose turn is at `message` (`{ path, offset }`):
 *  `{ path, offset, text }`; null when there is none and none will come; undefined when it may
 *  still come (the turn has not ended). `askedAt`: when the ask was filed, an ISO time. */
export async function blockingOf(itx, message, askedAt, now = Date.now()) {
  if (!message || !Number.isInteger(message.offset)) return null;
  const log = itx.cd(message.path);
  const at = (await log.readEvents(message.offset - 1, 1)).events[0];
  if (at?.offset !== message.offset) return null;
  if (endsWith(at, "/llm-request/settled")) {
    const text = cutOf(at.payload?.result?.text);
    return text ? { path: message.path, offset: at.offset, text } : null;
  }
  if (!endsWith(at, "/claude-code/hook-received")) return null;
  for (let after = message.offset, pages = 0; pages < 3; pages += 1) {
    const { events } = await log.readEvents(after, PAGE);
    for (const event of events) {
      if (!endsWith(event, "/claude-code/hook-received")) continue;
      if (event.payload?.hook_event_name === "Stop") {
        const text = cutOf(event.payload.last_assistant_message);
        return text ? { path: message.path, offset: event.offset, text } : null;
      }
      // the person spoke again before the turn ended: the turn's last words never came
      if (event.payload?.hook_event_name === "UserPromptSubmit") return null;
    }
    if (events.length < PAGE) break;
    after = events.at(-1).offset;
  }
  return now - Date.parse(askedAt ?? "") > 86_400_000 ? null : undefined;
}

const endsWith = (event, name) => typeof event?.type === "string" && event.type.endsWith(name);
const nameOf = (value) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;

/** WHICH MODEL MADE THE TURN AT `message` (`{ path, offset }`): `{ name, from }`, or null when the
 *  asker's log has no event that says (the head of this file). */
export async function modelOf(itx, message) {
  if (!message || !Number.isInteger(message.offset)) return null;
  const log = itx.cd(message.path);
  const at = (await log.readEvents(message.offset - 1, 1)).events[0];
  if (at?.offset !== message.offset) return null;
  // an iterate agent's turn: the settled request names its request, which names the model
  if (endsWith(at, "/llm-request/settled") || endsWith(at, "/llm-request/requested")) {
    const asked = endsWith(at, "/llm-request/requested")
      ? at
      : (await log.readEvents(at.payload?.llmRequestOffset - 1, 1)).events[0];
    const name =
      endsWith(asked, "/llm-request/requested") &&
      (endsWith(at, "/llm-request/requested") || asked.offset === at.payload?.llmRequestOffset)
        ? nameOf(asked.payload?.model)
        : null;
    return name ? { name, from: "llm-request" } : null;
  }
  // a Claude Code session's turn: the newest SessionStart hook before it
  if (endsWith(at, "/claude-code/hook-received")) {
    for (
      let end = message.offset, pages = 0;
      end > 0 && pages < START_PAGES;
      end -= PAGE, pages += 1
    ) {
      const { events } = await log.readEvents(Math.max(0, end - PAGE), PAGE);
      const start = events.findLast(
        (event) =>
          event.offset <= message.offset &&
          endsWith(event, "/claude-code/hook-received") &&
          event.payload?.hook_event_name === "SessionStart" &&
          nameOf(event.payload?.model),
      );
      if (start) return { name: nameOf(start.payload.model), from: "session-start" };
    }
  }
  return null;
}

const isPath = (value) => typeof value === "string" && value.startsWith("/");
const locatedKey = ({ file, ask, commitOid }) => `${file}\n${ask}\n${commitOid}`;

/** The words of an ask that a search looks for: its first stretch (12 to 60 characters) with no
 *  quote and no backslash, which a script's text and a JSON payload hold as they are. */
export function needleOf(ask) {
  return /[^"'\\`’‘“”\n]{12,60}/.exec(String(ask ?? ""))?.[0].trim() || null;
}

/** The first event of `log` at or after the time `from` (ms): a search by halves over the offsets,
 *  one event a read. It answers an offset to read from (`readEvents(offset - 1, …)`). */
async function offsetAt(log, head, from) {
  let low = 1;
  let high = head;
  while (low < high) {
    const middle = (low + high) >> 1;
    const event = (await log.readEvents(middle - 1, 1)).events[0];
    if (!event || Date.parse(event.createdAt) >= from) high = middle;
    else low = Math.max(middle, event.offset) + 1;
  }
  return low;
}

/** WHERE THE MESSAGE THAT ASKED IS: `{ path, offset }`, or null when nothing says. `row` is the
 *  ask's row of `askersOf` (`agent`, `at`, `commitOffset`), `repo` the tasks' repo. */
export async function locateAsk(itx, repo, ask, row) {
  if (!row.agent) return null;
  // an agent's own turn: the commit's fact names its cause
  if (Number.isInteger(row.commitOffset)) {
    const fact = (await itx.cd(repo).readEvents(row.commitOffset - 1, 1)).events[0];
    const cause =
      fact?.offset === row.commitOffset && /^(\/.+)@(\d+)$/.exec(fact.source?.cause?.parent ?? "");
    if (cause && cause[1] === row.agent) {
      const offset = Number(cause[2]);
      const event = (await itx.cd(cause[1]).readEvents(offset - 1, 1)).events[0];
      const needle = needleOf(ask);
      const words =
        Boolean(needle) &&
        event?.offset === offset &&
        JSON.stringify(event.payload ?? null).includes(needle);
      return { path: cause[1], offset, words };
    }
  }
  // a session through a person's sign-in: the event of its log that holds the ask's words
  const needle = needleOf(ask);
  const at = Date.parse(row.at ?? "");
  if (!needle || !Number.isFinite(at)) return null;
  const log = itx.cd(row.agent);
  const head = (await log.readEvents(Number.MAX_SAFE_INTEGER, 1)).scannedThroughOffset ?? 0;
  if (head === 0) return null;
  const start = await offsetAt(log, head, at - NEAR);
  const { events } = await log.readEvents(start - 1, PAGE);
  const found = events.findLast((event) => {
    const before = at + SLACK - Date.parse(event.createdAt);
    if (!(before >= 0 && before <= NEAR + SLACK)) return false;
    const text = JSON.stringify(event.payload ?? null);
    return text.includes(needle) && WRITES.test(text);
  });
  return found ? { path: row.agent, offset: found.offset, words: true } : null;
}

/** WHO ADDED EACH OPEN ASK, from the feed's changes. `open`: `{ [file]: [ask, …] }`, the asks that
 *  the files have now. `changes`: the payloads of `tasks/task-changed` events, NEWEST FIRST.
 *  `found` holds what earlier (newer) changes said already, and is added to: `{ [file]: { [ask]:
 *  { agent, by, page, at, commitOid } } }`. The newest change that added an ask wins, so an ask
 *  that was answered and asked again is its last asker's. `agent` is the commit's `Via:` line when
 *  that is a path, else the platform's `by` when that is one (an agent's own turn), else null. */
export function askersOf(open, changes, found = {}) {
  for (const change of changes) {
    const asks = open[change.file];
    if (!asks) continue;
    const before = change.before?.humanAsk || [];
    for (const ask of change.after?.humanAsk || []) {
      if (before.includes(ask) || !asks.includes(ask) || found[change.file]?.[ask]) continue;
      (found[change.file] ??= {})[ask] = {
        agent: isPath(change.via) ? change.via : isPath(change.by) ? change.by : null,
        by: change.by ?? null,
        page: change.page ?? null,
        at: change.committedAt ?? null,
        commitOid: change.commitOid ?? null,
        commitOffset: change.commitOffset ?? null,
      };
    }
  }
  return found;
}

/** `itx.config.taskAskers({ repo? })`: who asked each ask that a task of the tasks repo (or of the
 *  repo `repo` names) still has. It answers `{ repo, asks, readFrom }`. `asks` has one row for each
 *  ask, in the board's order: `{ file, ask, agent, by, page, at, assignee }`. `agent`: the path of
 *  the agent that added the ask, or null when nothing says (an ask older than the feed, or a
 *  person's own). `by`, `page`: who made that commit and on which page, by the platform's stamp.
 *  `at`: when; null for an ask that the feed does not have. `message`: `{ path, offset, words }`,
 *  the event of the asker's log in which it asked (`words: false`: the event that led to the
 *  ask, which does not hold its words), or null (the head of this file). `model`: `{ name,
 *  from }`, the model that made that turn by the asker's own log, or null: unrecorded.
 *  `blocking`: `{ path, offset, text }`, the agent's own last words of that turn, or null. `assignee`: the
 *  task's own `agent:`, which is NOT the asker. `readFrom`: the offset of the feed's log that the read went back to. */
export async function taskAskers(itx, input) {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input)))
    throw new Error("taskAskers takes { repo? }, or nothing for the tasks repo.");
  const repo = await repoOf("taskAskers", itx, input?.repo);
  const handle = itx.repos.get(repo);
  const commitOid = await handle.tip();
  const under = commitOid ? await handle.modules({ commitOid, dir: TASKS_DIR }) : {};
  const tasks = tasksOf(
    Object.fromEntries(Object.entries(under).map(([path, text]) => [`${TASKS_DIR}/${path}`, text])),
  ).filter((task) => task.humanAsk.length > 0);
  const open = Object.fromEntries(tasks.map((task) => [task.path, task.humanAsk]));
  const found = {};
  const located = new Map();
  let log = null;
  let readFrom = null;
  // the feed's log, from its end back: a read of a log that does not exist would make it, so the
  // catalog is asked first (as board.js does)
  const feed = feedOf(repo);
  const path = boardPathOf(feed);
  if (
    tasks.length > 0 &&
    (await itx.contexts.list({ under: feed.root, limit: 200 })).some(
      (context) => context.path === path,
    )
  ) {
    log = itx.cd(path);
    const head = (await log.readEvents(Number.MAX_SAFE_INTEGER, 1)).scannedThroughOffset ?? 0;
    // back from the log's end, 4,000 offsets at most, until every open ask has its asker
    for (let end = head; end > 0 && end > head - 4000; end -= PAGE) {
      if (Object.entries(open).every(([file, asks]) => asks.every((ask) => found[file]?.[ask])))
        break;
      const start = Math.max(0, end - PAGE);
      const { events } = await log.readEvents(start, PAGE);
      const changes = events
        .filter((event) => event.type === TASK_CHANGED && event.offset <= end)
        .map((event) => event.payload)
        .reverse();
      // newest first, so the newest word on an ask's message is the one kept
      for (const event of events.toReversed())
        if (
          event.type === ASK_LOCATED &&
          event.payload.rule === RULE &&
          event.offset <= end &&
          !located.has(locatedKey(event.payload))
        )
          located.set(
            locatedKey(event.payload),
            Number.isInteger(event.payload.offset)
              ? {
                  path: event.payload.path,
                  offset: event.payload.offset,
                  words: event.payload.words === true,
                  model: event.payload.model ?? null,
                  blocking: event.payload.blocking,
                }
              : null,
          );
      askersOf(open, changes, found);
      readFrom = start;
    }
  }
  // the asks whose message nobody looked up yet: some of them now, and the answer kept on the feed
  const unknown = Object.entries(found)
    .flatMap(([file, asks]) => Object.entries(asks).map(([ask, row]) => ({ file, ask, row })))
    .filter(
      ({ file, ask, row }) =>
        row.agent &&
        row.commitOid &&
        !located.has(locatedKey({ file, ask, commitOid: row.commitOid })),
    )
    .slice(0, MAX_LOCATE);
  await Promise.all(
    unknown.map(async ({ file, ask, row }) => {
      const key = locatedKey({ file, ask, commitOid: row.commitOid });
      // a lookup that fails says nothing, and is made again at the next call
      const message = await locateAsk(itx, repo, ask, row).catch(() => undefined);
      // oxlint-disable-next-line iterate/simple-truthiness-check -- undefined: the lookup failed, and is made again; null: it found no message, which is kept
      if (message === undefined) return;
      // the model of that turn, when it holds the ask's words: a failed read is "unrecorded" for now
      if (message)
        message.model = message.words ? await modelOf(itx, message).catch(() => null) : null;
      located.set(key, message);
      if (!message && !(Date.now() - Date.parse(row.at ?? "") > 300_000)) return;
      // kept when it can be: a feed that takes no event costs the next call one more lookup
      await Promise.resolve()
        .then(() =>
          log.append({
            type: ASK_LOCATED,
            idempotencyKey: `tasks/ask-located:${RULE}:${key}`,
            payload: {
              rule: RULE,
              file,
              ask,
              commitOid: row.commitOid,
              path: message?.path ?? row.agent,
              offset: message?.offset ?? null,
              words: message?.words ?? null,
              model: message?.model ?? null,
            },
          }),
        )
        .catch(() => {});
    }),
  );
  // the blocking message of each located ask that has none yet: found when the turn has ended,
  // and kept as one more event on the feed, which then is the newest word on that ask
  const waiting = Object.entries(found)
    .flatMap(([file, asks]) =>
      Object.entries(asks).map(([ask, row]) => ({
        file,
        ask,
        row,
        key: locatedKey({ file, ask, commitOid: row.commitOid }),
      })),
    )
    .filter(({ key }) => located.get(key)?.words && located.get(key).blocking === undefined)
    .slice(0, MAX_LOCATE);
  await Promise.all(
    waiting.map(async ({ file, ask, row, key }) => {
      const where = located.get(key);
      const blocking = await blockingOf(itx, where, row.at).catch(() => undefined);
      // oxlint-disable-next-line iterate/simple-truthiness-check -- undefined: not known yet, and looked for again; null: there is none, which is kept
      if (blocking === undefined) return;
      where.blocking = blocking;
      await Promise.resolve()
        .then(() =>
          log.append({
            type: ASK_LOCATED,
            idempotencyKey: `tasks/ask-located:${RULE}:${key}:blocking`,
            payload: {
              rule: RULE,
              file,
              ask,
              commitOid: row.commitOid,
              path: where.path,
              offset: where.offset,
              words: where.words,
              model: where.model ?? null,
              blocking,
            },
          }),
        )
        .catch(() => {});
    }),
  );
  const none = { agent: null, by: null, page: null, at: null };
  return {
    repo,
    asks: tasks.flatMap((task) =>
      task.humanAsk.map((ask) => {
        const { agent, by, page, at, commitOid } = found[task.path]?.[ask] ?? none;
        const where =
          (commitOid && located.get(locatedKey({ file: task.path, ask, commitOid }))) || null;
        const message = where && { path: where.path, offset: where.offset, words: where.words };
        return {
          file: task.path,
          ask,
          agent,
          by,
          page,
          at,
          message,
          model: where?.model ?? null,
          blocking: where?.blocking ?? null,
          assignee: task.agent || null,
        };
      }),
    ),
    readFrom,
  };
}
