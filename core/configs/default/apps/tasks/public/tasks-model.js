// tasks-model.js — A TASK FILE AS A CARD, text in and text out: no network, no page. A task is a
// markdown file under tasks/ in a repo of the mind (the tasks repo, `TASKS_REPO` below, unless a
// board or a caller names another), and what the board knows of it is in the file's frontmatter
// and its first heading:
//
//   ---
//   status: in-progress      the column (below); `state:` is read too, as the first board wrote it
//   tags: [board, ui]        also read: `labels:`, a block list, or words with commas between
//   size: small              shown on the card as it is written
//   priority: high           shown on the card as it is written
//   owner: jonas             also read: `assignee:`
//   agent: /agents/...       the agent that has the task, as the first board wrote it
//   blocked-on: PR #12       what holds the task (one line); the board only reads it
//   human-ask:               what the task waits for from a person, one `- ` line for each ask
//     - Sign the grant?      (also read: one line after the key, or `[a, b]`). The board lists
//     - Merge #12, or wait?  them ("Needs a person", `needsAPerson`), and a person answers one
//                            there: the ask's line goes, and the ask with its answer is kept
//                            under `## Answers` in the text (`answerAsk`). These two keys are
//                            read whole: a `#` in them is a word, never a comment
//   ---
//
// Tags, priority, size, owner and agent are the task's DIMENSIONS (below): the board shows one,
// filters by it and breaks into rows by it only when some file holds it. It invents none.
//
//   # The title               else `title:` in the frontmatter, else the file's name
//
// A file with no frontmatter is a task too, in Todo. The board changes ONE thing of a file at a
// time (its status, its title, one dimension, or one ask answered: `setStatus`, `setTitle`,
// `setField`, `answerAsk`) and leaves every other byte as it was, so a hand-written file stays
// hand-written, and a key the board does not know stays where it is.
// The page (app.js) and the test (../tasks-model.test.mjs) both load this file as it is.

/** THE TASKS REPO, AND THE FOLDER OF A REPO WHOSE MARKDOWN FILES ARE ITS TASKS. The tasks repo is
 *  the one that the board shows and `itx.config.followTasks` follows when nobody names a repo. It
 *  lives in the mind alone (no GitHub mirror), and a commit to it publishes nothing. Any other
 *  repo of the mind is a board too, by its name: `tasks.<domain>/?repo=<name>` (app.js), and the
 *  change feed tells of every repo's tasks (../feed.js). Nothing else names these two. */
export const TASKS_REPO = "/repos/tasks";
export const TASKS_DIR = "tasks";

/** The board's columns, in order. A task whose status is none of these (or of their other
 *  spellings below) gets a column of its own after them. */
export const COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "Todo" },
  { id: "in-progress", label: "In progress" },
  { id: "in-review", label: "In review" },
  { id: "done", label: "Done" },
];

/** Other spellings of a column, as task files written by hand have them. They are read, never
 *  rewritten: a file changes only when a person moves its card. */
const SPELLINGS = {
  backlog: ["idea", "ideas", "later", "someday", "icebox"],
  todo: ["to-do", "ready", "open", "next", "planned", "new"],
  "in-progress": ["doing", "building", "wip", "started", "active", "in-flight"],
  "in-review": [
    "review",
    "needs-review",
    "needs-decision",
    "done-pending-merge",
    "done-awaiting-review",
    "awaiting-review",
  ],
  done: ["complete", "completed", "closed", "shipped", "merged", "finished"],
};
const COLUMN_OF = new Map(
  COLUMNS.flatMap(({ id }) => [id, ...(SPELLINGS[id] || [])].map((spelling) => [spelling, id])),
);

/** The column a written status belongs to: one of COLUMNS' ids, or for a status of its own the
 *  status as a slug. None written is Todo. */
export function columnOf(status) {
  const slug = slugify(status || "");
  if (!slug) return "todo";
  return COLUMN_OF.get(slug) || slug;
}

/** Lower-case words with hyphens between: "Done, awaiting review" is done-awaiting-review. One
 *  longer than `max` is cut at the end of a word, never inside one (unless its first word alone
 *  is too long). */
export function slugify(text, max = 64) {
  const slug = String(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  // the cut fell at a word's end when the next character is a hyphen
  const whole = slug[max] === "-" ? cut : cut.slice(0, Math.max(cut.lastIndexOf("-"), 0)) || cut;
  return whole.replace(/-+$/g, "");
}

/** Whether the board shows this file of the repo: markdown under the tasks folder. */
export function isTaskPath(path) {
  return path.startsWith(`${TASKS_DIR}/`) && /\.(?:md|markdown)$/i.test(path);
}

// ── the frontmatter ──
// Read line by line, for the few keys the board shows: no YAML library, so nothing to load and
// nothing that can rewrite a file's other lines. A key is a line that starts at the left edge.

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** The file's frontmatter: its lines, where the body begins, and the file's line ending. */
function frontmatterOf(source) {
  const eol = /\r\n/.test(source) ? "\r\n" : "\n";
  const match = FRONTMATTER.exec(source);
  if (!match) return { exists: false, lines: [], bodyAt: 0, eol };
  return {
    exists: true,
    lines: match[1] === undefined || match[1] === "" ? [] : match[1].split(/\r?\n/),
    bodyAt: match[0].length,
    eol,
  };
}

const keyOf = (line) => /^([A-Za-z][\w-]*)[ \t]*:(?:[ \t]|$)/.exec(line)?.[1];

/** A written value without its quotes, or its comment when it has no quotes. `whole` keeps what
 *  follows a `#`: in a line that a person reads, "#12" is a word. */
function scalar(text, whole = false) {
  const value = text.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  if (quoted) return quoted[2];
  return whole ? value : value.replace(/\s+#.*$/, "").trim();
}

/** The items of an inline list: split at each comma that is outside quotes, so `["a, b", c]` is two. */
function itemsOf(text) {
  const items = [""];
  let quote = null;
  for (const char of text) {
    if (char === "," && !quote) items.push("");
    else items[items.length - 1] += char;
    if (quote) quote = char === quote ? null : quote;
    // a quote opens an item only as its first character: the one in `it's` is a letter
    else if ((char === `"` || char === "'") && items.at(-1).trim() === char) quote = char;
  }
  return items;
}

/** One key's value: a string, or a list for `[a, b]` and for `- a` lines under the key. Undefined
 *  when the frontmatter has no such key. `whole`: no part of the value is a comment (`scalar`). */
function valueOf(lines, key, whole = false) {
  const at = lines.findIndex((line) => keyOf(line) === key);
  if (at < 0) return undefined;
  const rest = lines[at].slice(lines[at].indexOf(":") + 1).trim();
  const inline = /^\[([\s\S]*)\]$/.exec(rest);
  if (inline)
    return itemsOf(inline[1])
      .map((item) => scalar(item, whole))
      .filter(Boolean);
  if (rest) return scalar(rest, whole);
  const items = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) break;
    items.push(scalar(item[1], whole));
  }
  return items.length > 0 ? items.filter(Boolean) : "";
}

const listOf = (value) =>
  value === undefined
    ? []
    : (Array.isArray(value) ? value : String(value).split(","))
        .map((each) => each.trim())
        .filter(Boolean);
const textOf = (value) => (Array.isArray(value) ? value.join(", ") : value || "");

/** The first `# ` heading outside the frontmatter and outside a code fence: its words, and which
 *  line of `body` it is. */
function headingIn(body) {
  let fenced = false;
  const lines = body.split(/\r?\n/);
  for (let at = 0; at < lines.length; at += 1) {
    if (/^\s*(```|~~~)/.test(lines[at])) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[at]);
    if (heading) return { title: heading[1].trim(), at };
  }
}

/** The file's name as a title: "2026-11-19-board-filters.md" is "Board filters". */
function titleOfPath(path) {
  const name = path
    .split("/")
    .at(-1)
    .replace(/\.(?:md|markdown)$/i, "");
  const words =
    name
      .replace(/^\d{4}-\d{2}-\d{2}-/, "")
      .replace(/[-_]+/g, " ")
      .trim() || name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One task file as the board's card. `path` is its path in the repo and its identity. */
export function parseTask(path, source) {
  const { lines, bodyAt } = frontmatterOf(source);
  const status = textOf(valueOf(lines, "status") ?? valueOf(lines, "state"));
  const folder = path.split("/").slice(1, -1).join("/");
  return {
    path,
    title:
      textOf(valueOf(lines, "title")) ||
      headingIn(source.slice(bodyAt))?.title ||
      titleOfPath(path),
    /** as the file writes it; "" when it writes none */
    status,
    column: columnOf(status),
    tags: [...new Set([...listOf(valueOf(lines, "tags")), ...listOf(valueOf(lines, "labels"))])],
    priority: textOf(valueOf(lines, "priority")),
    size: textOf(valueOf(lines, "size")),
    owner: textOf(valueOf(lines, "owner") ?? valueOf(lines, "assignee")),
    agent: textOf(valueOf(lines, "agent")),
    /** the model and the effort that the task's agent was started with, when the card says so */
    model: textOf(valueOf(lines, "model")),
    effort: textOf(valueOf(lines, "effort")),
    /** what holds the task, as one line; "" when the file says nothing */
    blockedOn: textOf(valueOf(lines, "blocked-on", true) ?? valueOf(lines, "blocked_on", true)),
    /** paths of tasks that this task depends on (`depends-on:` / `depends_on:`) */
    dependsOn: [
      ...new Set([
        ...listOf(valueOf(lines, "depends-on")),
        ...listOf(valueOf(lines, "depends_on")),
      ]),
    ],
    /** what it waits for from a person, each item whole (a comma inside one line splits nothing) */
    humanAsk: [valueOf(lines, "human-ask", true) ?? valueOf(lines, "human_ask", true) ?? []]
      .flat()
      .filter(Boolean),
    /** the folders between tasks/ and the file: "" for a task at the top */
    folder,
    source,
  };
}

/** A value as one line of YAML: quoted only when YAML would read it as something else. */
function written(value) {
  return /^[\w][\w .\-/]*$/.test(value) && !/\s$/.test(value) ? value : JSON.stringify(value);
}

/** The file with its status changed and every other byte as it was. It writes the key the file
 *  has (`status:`, or the older `state:`), adds `status:` to a frontmatter without one, and gives
 *  a file with no frontmatter one of that single line. */
export function setStatus(source, status) {
  return setKey(source, ["status", "state"], written(status));
}

/** The file with ONE key of its frontmatter written and every other byte as it was. `keys` are the
 *  key's spellings: the one the file has is written, else the first is added at the frontmatter's
 *  end, and a file with no frontmatter gets one of that single line. `value` is the text after
 *  the colon; undefined takes the key's line away (and, when that leaves nothing between the
 *  fences, the frontmatter stays as two fences: the board never deletes a file's frontmatter).
 *  A value written as a block list (`- a` lines under the key) goes with its key's line. With `one`, a
 *  second spelling of the key in the same file goes too, so that the file says one thing. */
function setKey(source, keys, value, { one = false } = {}) {
  const { exists, lines, bodyAt, eol } = frontmatterOf(source);
  if (!exists)
    return value === undefined
      ? source
      : `---${eol}${keys[0]}: ${value}${eol}---${eol}${eol}${source}`;
  const key = keys.find((each) => lines.some((has) => keyOf(has) === each));
  if (!key && value === undefined) return source;
  const spellings = new Set(keys);
  const next = [];
  let dropping = false;
  let done = false;
  for (const line of lines) {
    const at = keyOf(line);
    // the lines of a block value belong to the key above them
    if (dropping && !at && /^(?:\s+\S|\s*-\s|\s*$)/.test(line) && line.trim() !== "") continue;
    dropping = false;
    if (at && (at === key || (one && spellings.has(at)))) {
      dropping = true;
      if (at === key && !done && value !== undefined) next.push(`${key}: ${value}`);
      done = true;
      continue;
    }
    next.push(line);
  }
  if (!key) next.push(`${keys[0]}: ${value}`);
  const between = next.length > 0 ? `${next.join(eol)}${eol}` : "";
  return `---${eol}${between}---${eol}${source.slice(bodyAt)}`;
}

/** The file with one DIMENSION written (an id of `DIMENSIONS`) and every other byte as it was.
 *  `value` is a text, or for tags a list; an empty one takes the key's line away. A file's own
 *  spelling of the key stays (`labels:`, `assignee:`). An id that is no dimension changes
 *  nothing. */
export function setField(source, id, value) {
  const dimension = DIMENSIONS.find((each) => each.id === id);
  if (!dimension) return source;
  const values = [value]
    .flat()
    .map((each) => String(each ?? "").trim())
    .filter(Boolean);
  if (values.length === 0) return setKey(source, dimension.keys, undefined, { one: true });
  const unique = [...new Set(values)];
  return setKey(
    source,
    dimension.keys,
    dimension.many ? `[${unique.map(written).join(", ")}]` : written(unique[0]),
    { one: true },
  );
}

/** The file with its TITLE changed and every other byte as it was: the `title:` of its
 *  frontmatter when it has one, else its first `# ` heading, else a new heading as the body's
 *  first line. The file's path does not change: a title renames nothing. An empty title changes
 *  nothing. */
export function setTitle(source, title) {
  const name = String(title).replace(/\s+/g, " ").trim();
  if (!name) return source;
  const { lines, bodyAt, eol } = frontmatterOf(source);
  if (lines.some((line) => keyOf(line) === "title"))
    return setKey(source, ["title"], written(name));
  const head = source.slice(0, bodyAt);
  const body = source.slice(bodyAt);
  const heading = headingIn(body);
  if (!heading) return insertHeading(head, body, name, eol);
  const bodyLines = body.split(/(\r?\n)/);
  // split keeps each line ending as its own element: line n is element 2n
  bodyLines[heading.at * 2] = `# ${name}`;
  return head + bodyLines.join("");
}

/** A body with a new first heading: after the blank lines that follow the frontmatter, and with a
 *  blank line before the text that was first. */
function insertHeading(head, body, name, eol) {
  const blank = /^(?:[ \t]*\r?\n)*/.exec(body)[0];
  const rest = body.slice(blank.length);
  return `${head}${blank}# ${name}${eol}${rest ? eol + rest : ""}`;
}

/** A new task's file: where it goes and what it holds. `taken` is the paths the repo has, so two
 *  tasks with one title get two files (`-2`, `-3`). */
export function newTask({ title, status = "todo", folder = "", taken = [], fields = {} }) {
  const name = title.trim() || "New task";
  const dir = [
    TASKS_DIR,
    ...folder
      .split("/")
      .map((part) => slugify(part))
      .filter(Boolean),
  ].join("/");
  const slug = slugify(name) || "task";
  const used = new Set(taken);
  let path = `${dir}/${slug}.md`;
  for (let n = 2; used.has(path); n += 1) path = `${dir}/${slug}-${n}.md`;
  // a task made in a row or filtered view is born with its values: `fields` is
  // { <dimension's id>: value | value[] }, written under the dimension's first key
  const more = DIMENSIONS.flatMap(({ id, keys, many }) => {
    const values = [
      ...new Set(
        [fields[id]]
          .flat()
          .map((each) => String(each ?? "").trim())
          .filter(Boolean),
      ),
    ];
    if (values.length === 0) return [];
    return [
      many
        ? `${keys[0]}: [${values.map(written).join(", ")}]`
        : `${keys[0]}: ${written(values[0])}`,
    ];
  });
  return {
    path,
    content: [`---`, `status: ${written(status)}`, ...more, `---`, ``, `# ${name}`, ``].join("\n"),
  };
}

// ── the dimensions ──

/** WHAT A TASK CAN BE SHOWN, FILTERED AND BROKEN DOWN BY, besides its status (the columns) and its
 *  folder. Each is read from the frontmatter keys in `keys`, and a board has a dimension only when
 *  one of its files holds it (`dimensionsOf`): the board invents no field. `param` is its name in
 *  the page's URL, `many` says that a task can have several values, `choices` are the values the
 *  task sheet offers beside those in use, and `order` is the order of
 *  the values that have one (any other value comes after them, the most used first). */
export const DIMENSIONS = [
  {
    id: "tags",
    param: "tag",
    label: "Tags",
    one: "Tag",
    none: "No tag",
    keys: ["tags", "labels"],
    many: true,
  },
  {
    id: "priority",
    param: "priority",
    label: "Priority",
    one: "Priority",
    none: "No priority",
    keys: ["priority"],
    choices: ["urgent", "high", "medium", "low"],
    order: [
      "urgent",
      "critical",
      "p0",
      "highest",
      "high",
      "p1",
      "medium",
      "normal",
      "p2",
      "low",
      "p3",
      "lowest",
      "p4",
    ],
  },
  {
    id: "size",
    param: "size",
    label: "Size",
    one: "Size",
    none: "No size",
    keys: ["size"],
    choices: ["small", "medium", "large"],
    order: ["xs", "tiny", "s", "small", "m", "medium", "l", "large", "xl", "huge"],
  },
  {
    id: "owner",
    param: "owner",
    label: "Owner",
    one: "Owner",
    none: "No owner",
    keys: ["owner", "assignee"],
  },
  { id: "agent", param: "agent", label: "Agent", one: "Agent", none: "No agent", keys: ["agent"] },
];

/** WHERE AN AGENT'S CHAT IS IN THE DASH: the Dash's own address of the agent at this context path,
 *  with no origin ("/agents/agents/claude/x"), or null when the value is no context path (a card
 *  whose `agent:` is a plain name has no chat to open). The encoding is that of
 *  apps/dash/links.ts `dashLinks(apex).agent`, which is what `itx.config.dashLink` answers: a path
 *  that a URL's pathname can carry goes in the pathname, any other in `?contextPath=`. */
export function agentChatPath(agent) {
  const path = String(agent ?? "").trim();
  if (!path.startsWith("/") || path === "/") return null;
  const sayable = path
    .slice(1)
    .split("/")
    .every((part) => part && part !== "." && part !== "..");
  const href = sayable
    ? `/agents${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")
        .replace(/%(?:40|3A|24|26|2B|2C|3B|3D)/g, decodeURIComponent)}`
    : `/agents?${new URLSearchParams({ contextPath: path })
        .toString()
        .replaceAll("+", "%20")
        .replace(/%(?:2F|40|3A|2C)/g, decodeURIComponent)}`;
  // a last "." "," ":" is encoded, so that a chat or a mail that makes the address a link keeps it
  return href.replace(/[.,:]$/, (last) => ({ ".": "%2E", ",": "%2C", ":": "%3A" })[last]);
}

/** A task's values in one dimension: none, one, or for tags several. */
export const valuesOf = (task, id) => [task[id]].flat().filter(Boolean);

/** The dimensions that these tasks hold, each with its values and how many tasks have each
 *  (`values`: `[value, count]`, in the dimension's order) and how many tasks have none
 *  (`without`). */
export function dimensionsOf(tasks) {
  return DIMENSIONS.map((dimension) => {
    const place = (value) => {
      const at = (dimension.order || []).indexOf(String(value).toLowerCase());
      return at < 0 ? (dimension.order || []).length : at;
    };
    const values = counts(tasks, (task) => valuesOf(task, dimension.id));
    values.sort(([a], [b]) => place(a) - place(b));
    return {
      ...dimension,
      values,
      without: tasks.filter((task) => valuesOf(task, dimension.id).length === 0).length,
    };
  }).filter((dimension) => dimension.values.length > 0);
}

/** The board's rows by one dimension (an element of `dimensionsOf`): a row for each value, in the
 *  dimension's order, then a row for the tasks that have none. A row with no task is left out,
 *  and a task with two tags is in two rows. */
export function rowsOf(tasks, dimension) {
  const byValue = new Map(dimension.values.map(([value]) => [value, []]));
  const without = [];
  for (const task of tasks) {
    const values = valuesOf(task, dimension.id);
    if (values.length === 0) without.push(task);
    for (const value of values) byValue.get(value)?.push(task);
  }
  const rows = [...byValue].map(([value, has]) => ({ value, label: value, tasks: has }));
  return [...rows, { value: null, label: dimension.none, tasks: without }].filter(
    (row) => row.tasks.length > 0,
  );
}

// ── what waits for a person ──

/** The tasks that are not done and ask a person something or say what holds them: those that ask
 *  first, then the blocked ones, each by title. The board never writes `blocked-on:`, and it
 *  writes `human-ask:` in one way: an ask that a person answers leaves it (`answerAsk`). */
export function needsAPerson(tasks) {
  return tasks
    .filter((task) => task.column !== "done" && (task.humanAsk.length > 0 || task.blockedOn))
    .sort(
      (a, b) =>
        Number(b.humanAsk.length > 0) - Number(a.humanAsk.length > 0) ||
        a.title.localeCompare(b.title, undefined, { numeric: true }) ||
        a.path.localeCompare(b.path),
    );
}

const ASK_KEYS = ["human-ask", "human_ask"];
/** The heading in a task's text under which the answers to its asks are kept. */
export const ANSWERS_HEADING = "## Answers";

/** THE FILE WITH ONE ASK ANSWERED, and every other byte as it was. This is the whole format of an
 *  answer:
 *    - the ask's line leaves `human-ask:` in the frontmatter (the key too, when it was the last
 *      ask), so the frontmatter says what is still asked;
 *    - `- **<the ask>** <the answer> (<who>, <YYYY-MM-DD HH:MM> UTC)` becomes the last line under
 *      `## Answers` in the text, a heading that is made at the text's end when the file has none.
 *  `by` is who answered, as they are known (an address); `at` is an ISO time. The answer is kept
 *  as one line. An ask that the file does not have changes nothing. */
export function answerAsk(source, { ask, answer, by, at }) {
  const { exists, lines, bodyAt, eol } = frontmatterOf(source);
  const keyAt = lines.findIndex((line) => ASK_KEYS.includes(keyOf(line)));
  if (!exists || keyAt < 0) return source;
  const front = [...lines];
  const rest = front[keyAt].slice(front[keyAt].indexOf(":") + 1).trim();
  const inline = /^\[([\s\S]*)\]$/.exec(rest);
  if (inline) {
    // `human-ask: [a, b]`: the line again without the item, each other item as it was written
    const items = itemsOf(inline[1])
      .map((item) => item.trim())
      .filter(Boolean);
    const found = items.findIndex((item) => scalar(item, true) === ask);
    if (found < 0) return source;
    items.splice(found, 1);
    if (items.length > 0) front[keyAt] = `${keyOf(front[keyAt])}: [${items.join(", ")}]`;
    else front.splice(keyAt, 1);
  } else if (rest) {
    // `human-ask: one ask`
    if (scalar(rest, true) !== ask) return source;
    front.splice(keyAt, 1);
  } else {
    // the `- ` lines under the key
    let end = keyAt + 1;
    while (end < front.length && /^\s*-\s+/.test(front[end])) end += 1;
    const found = front
      .slice(keyAt + 1, end)
      .findIndex((line) => scalar(/^\s*-\s+(.*)$/.exec(line)[1], true) === ask);
    if (found < 0) return source;
    // the last ask takes its key with it
    if (end - keyAt === 2) front.splice(keyAt, 2);
    else front.splice(keyAt + 1 + found, 1);
  }
  const said = String(answer ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const when = `${String(at).slice(0, 10)} ${String(at).slice(11, 16)} UTC`;
  const line = `- **${ask}** ${said ? `${said} ` : ""}(${by}, ${when})`;
  const between = front.length > 0 ? `${front.join(eol)}${eol}` : "";
  return `---${eol}${between}---${eol}${withLineUnder(source.slice(bodyAt), ANSWERS_HEADING, line, eol)}`;
}

/** A task's text with one more line under a `## ` heading (`heading`, with its marks): after that
 *  section's last line, or under a new heading at the text's end. A heading inside a code fence is
 *  no heading. */
function withLineUnder(body, heading, line, eol) {
  const lines = body.split(/\r?\n/);
  const words = heading.replace(/^#+\s*/, "");
  let fenced = false;
  let found = -1;
  let end = lines.length;
  for (let at = 0; at < lines.length; at += 1) {
    if (/^\s*(```|~~~)/.test(lines[at])) fenced = !fenced;
    if (fenced) continue;
    if (found < 0) {
      if (/^##\s/.test(lines[at]) && lines[at].replace(/^##\s+/, "").trim() === words) found = at;
    } else if (/^#{1,6}\s/.test(lines[at])) {
      end = at;
      break;
    }
  }
  if (found < 0) {
    const text = body.replace(/\s*$/, "");
    return `${text}${text ? eol + eol : ""}${heading}${eol}${eol}${line}${eol}`;
  }
  // the section's last line that is not blank: the new line goes after it
  let last = end - 1;
  while (last > found && lines[last].trim() === "") last -= 1;
  const after = lines.slice(last + 1);
  const next = [...lines.slice(0, last + 1), ...(last === found ? [""] : []), line, ...after].join(
    eol,
  );
  // a text that ended with no line end gets one: the line is a whole line
  return after.length > 0 ? next : `${next}${eol}`;
}

/** A text as ONE line of a frontmatter value that the reader gives back as it is (`scalar` with
 *  `whole`): in quotes when its own first and last characters would be read as quotes, or as the
 *  brackets of a list. */
function asWritten(text) {
  if (/^\[[\s\S]*\]$/.test(text)) return `"${text}"`;
  const quoted = /^(["'])[\s\S]*\1$/.exec(text);
  return quoted ? (quoted[1] === '"' ? `'${text}'` : `"${text}"`) : text;
}

/** THE FILE WITH ONE MORE ASK, and every other byte as it was: a `- ` line at the end of
 *  `human-ask:`. The key becomes a list of such lines when the file wrote it another way (one
 *  line, or `[a, b]`), is made at the frontmatter's end when the file has none, and a file with no
 *  frontmatter gets one. The ask is kept as one line. An ask that the file has already, or an
 *  empty one, changes nothing. */
export function addAsk(source, ask) {
  const said = String(ask ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const { exists, lines, bodyAt, eol } = frontmatterOf(source);
  const asked = [valueOf(lines, "human-ask", true) ?? valueOf(lines, "human_ask", true) ?? []]
    .flat()
    .filter(Boolean);
  if (!said || asked.includes(said)) return source;
  const item = `  - ${asWritten(said)}`;
  if (!exists) return `---${eol}human-ask:${eol}${item}${eol}---${eol}${eol}${source}`;
  const front = [...lines];
  const keyAt = front.findIndex((line) => ASK_KEYS.includes(keyOf(line)));
  if (keyAt < 0) front.push("human-ask:", item);
  else {
    const key = keyOf(front[keyAt]);
    const rest = front[keyAt].slice(front[keyAt].indexOf(":") + 1).trim();
    const inline = /^\[([\s\S]*)\]$/.exec(rest);
    // what the key held on its own line, as items of a list: each as it was written
    const held = inline
      ? itemsOf(inline[1])
          .map((each) => each.trim())
          .filter(Boolean)
      : rest
        ? [rest]
        : [];
    let end = keyAt + 1;
    while (end < front.length && /^\s*-\s+/.test(front[end])) end += 1;
    front.splice(keyAt, 1, `${key}:`, ...held.map((each) => `  - ${each}`));
    front.splice(end + held.length, 0, item);
  }
  return `---${eol}${front.join(eol)}${eol}---${eol}${source.slice(bodyAt)}`;
}

/** THE FILE WITH WHAT HOLDS THE TASK WRITTEN (`blocked-on:`, one line), or with the key taken
 *  away for an empty text; every other byte as it was. */
export function setBlockedOn(source, text) {
  const said = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return setKey(source, ["blocked-on", "blocked_on"], said ? asWritten(said) : undefined, {
    one: true,
  });
}

/** THE FILE WITH ONE PLAIN KEY OF ITS FRONTMATTER WRITTEN (`model: claude-fable-5-2`), or taken
 *  away for an empty text; every other byte as it was. For a key that is no dimension of the
 *  board: the board keeps it and shows it nowhere. A key that is no plain word changes nothing. */
export function setPlainKey(source, key, text) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(key))) return source;
  const said = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return setKey(source, [key], said ? written(said) : undefined);
}

/** The heading in a task's text under which notes are kept. */
export const LOG_HEADING = "## Log";

/** THE FILE WITH ONE MORE NOTE: `- <YYYY-MM-DD HH:MM> UTC, <who>: <the note>` as the last line
 *  under `## Log` in the text, a heading that is made at the text's end when the file has none.
 *  For a line of progress or of what was found; longer reasoning is written into the text itself.
 *  `at` is an ISO time. The note is kept as one line. An empty note changes nothing. */
export function addNote(source, { note, by, at }) {
  const said = String(note ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!said) return source;
  const { bodyAt, eol } = frontmatterOf(source);
  const when = `${String(at).slice(0, 10)} ${String(at).slice(11, 16)} UTC`;
  return (
    source.slice(0, bodyAt) +
    withLineUnder(source.slice(bodyAt), LOG_HEADING, `- ${when}, ${by}: ${said}`, eol)
  );
}

/** THE ANSWERS THAT A TASK'S TEXT KEEPS (`answerAsk` wrote them): each line under `## Answers` of
 *  the form `- **<ask>** <answer> (<who>, <YYYY-MM-DD HH:MM> UTC)`, oldest first, as
 *  `{ ask, answer, by, at }`. A line of another form is left out, and so is a heading inside a
 *  code fence. The change feed says with it what an ask was answered with, and the board as data
 *  (../board.js) lists them. */
export function answersOf(source) {
  const answers = [];
  let fenced = false;
  let inside = false;
  for (const line of source.slice(frontmatterOf(source).bodyAt).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (/^#{1,6}\s/.test(line)) {
      inside = /^##\s+Answers\s*$/.test(line);
      continue;
    }
    const found =
      inside &&
      /^- \*\*(.+?)\*\* (?:(.*) )?\(([^()]+), (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\)$/.exec(line);
    if (found) answers.push({ ask: found[1], answer: found[2] || "", by: found[3], at: found[4] });
  }
  return answers;
}

// ── the board ──

/** Every task of a folder read (`{ path: text }`), by title. */
export function tasksOf(files) {
  return Object.entries(files)
    .filter(([path, source]) => isTaskPath(path) && typeof source === "string")
    .map(([path, source]) => parseTask(path, source))
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title, undefined, { numeric: true }) ||
        a.path.localeCompare(b.path),
    );
}

/** The columns for these tasks: the five, then one for each status of its own, by name. The label
 *  of such a column is the status as the first file writes it. */
export function columnsOf(tasks) {
  const own = new Map();
  for (const task of tasks)
    if (!COLUMNS.some((column) => column.id === task.column) && !own.has(task.column))
      own.set(task.column, task.status);
  return [
    ...COLUMNS,
    ...[...own]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, label]) => ({ id, label, own: true })),
  ];
}

/** The tasks a filter leaves: every word of `query` in the title, the path, the status or a value
 *  of a dimension; for each dimension that `where` names (`{ tags: ["ui"], size: ["large"] }`),
 *  one of its values; one of `statuses` (by column id, when given); and the folder or one beneath
 *  it. */
export function filterTasks(tasks, { query = "", where = {}, folder = null, statuses = [] } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const named = DIMENSIONS.filter(({ id }) => where[id]?.length > 0);
  const wantedColumns = statuses.length > 0 ? new Set(statuses.map(columnOf)) : null;
  return tasks.filter((task) => {
    if (wantedColumns && !wantedColumns.has(task.column)) return false;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- "" is the folder at the top of tasks/, null is no folder asked for
    if (folder !== null && task.folder !== folder && !task.folder.startsWith(`${folder}/`))
      return false;
    for (const { id } of named)
      if (!valuesOf(task, id).some((value) => where[id].includes(value))) return false;
    if (words.length === 0) return true;
    const text = [
      task.title,
      task.path,
      task.status,
      ...DIMENSIONS.flatMap(({ id }) => valuesOf(task, id)),
    ]
      .join("\n")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** How many tasks each value has, most first: `counts(tasks, (task) => task.tags)`. */
export function counts(tasks, valuesOf) {
  const count = new Map();
  for (const task of tasks)
    for (const value of [valuesOf(task)].flat()) count.set(value, (count.get(value) || 0) + 1);
  return [...count].sort(([a, n], [b, m]) => m - n || String(a).localeCompare(String(b)));
}

// ── a change, and the files after it ──
// The page keeps what a person did as CHANGES, not as new files: a change is applied to the file
// as the repo has it at the moment of the commit, so a line somebody else wrote meanwhile stays.

/** What each kind of change does to a file's text. The board makes the first four; an agent's
 *  calls (../cards.js, ../asks.js) make them all. */
const CHANGES = {
  status: (source, change) => setStatus(source, change.status),
  title: (source, change) => setTitle(source, change.title),
  field: (source, change) => setField(source, change.field, change.value),
  answer: (source, change) => answerAsk(source, change),
  ask: (source, change) => addAsk(source, change.ask),
  blocked: (source, change) => setBlockedOn(source, change.blockedOn),
  note: (source, change) => addNote(source, change),
  key: (source, change) => setPlainKey(source, change.key, change.value),
};

/** `files` after `change`: `{ kind: "status", path, status }`, `{ kind: "title", path, title }`,
 *  `{ kind: "field", path, field, value }` (a dimension's id and its value), `{ kind: "answer",
 *  path, ask, answer, by, at }` (`answerAsk`), `{ kind: "ask", path, ask }` (`addAsk`),
 *  `{ kind: "blocked", path, blockedOn }` (`setBlockedOn`), `{ kind: "note", path, note, by, at }`
 *  (`addNote`), `{ kind: "key", path, key, value }` (`setPlainKey`) or `{ kind: "create", path,
 *  content }`. A change of a file that is gone changes nothing, and neither does a kind that is
 *  none of these. */
export function applyChange(files, change) {
  if (change.kind === "create")
    return change.path in files ? files : { ...files, [change.path]: change.content };
  const source = files[change.path];
  if (typeof source !== "string" || !Object.hasOwn(CHANGES, change.kind)) return files;
  const next = CHANGES[change.kind](source, change);
  return next === source ? files : { ...files, [change.path]: next };
}

/** What a commit of `changes` writes over `files`: each changed path once, with its last content.
 *  Empty when the changes change nothing (a card moved and moved back). */
export function commitOf(files, changes) {
  const after = changes.reduce(applyChange, files);
  return Object.keys(after)
    .filter((path) => after[path] !== files[path])
    .map((path) => ({ path, content: after[path] }));
}

const shortOf = (text) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/** The commit's message: what one change did, or how many there are with a line for each. A path
 *  whose status changed twice is named once, with where it ended; so is a title, and each
 *  dimension. */
export function messageOf(changes) {
  const last = new Map();
  for (const change of changes) {
    if (change.kind === "create") last.set(change.path, `new ${change.path}`);
    else if (change.kind === "title")
      last.set(`${change.path}\0title`, `${change.path}: the title`);
    else if (change.kind === "answer")
      last.set(
        `${change.path}\0answer\0${change.ask}`,
        `${change.path}: answered "${shortOf(change.ask)}"`,
      );
    else if (change.kind === "ask")
      last.set(
        `${change.path}\0ask\0${change.ask}`,
        `${change.path}: asks "${shortOf(String(change.ask))}"`,
      );
    else if (change.kind === "blocked")
      last.set(
        `${change.path}\0blocked`,
        `${change.path}: ${change.blockedOn ? `blocked on ${shortOf(String(change.blockedOn))}` : "no longer blocked"}`,
      );
    else if (change.kind === "note") last.set(`${change.path}\0note`, `${change.path}: a note`);
    else if (change.kind === "key")
      last.set(
        `${change.path}\0key\0${change.key}`,
        `${change.path}: ${change.value ? `${change.key} is ${shortOf(String(change.value))}` : `no ${change.key}`}`,
      );
    else if (change.kind === "field") {
      const value = [change.value].flat().filter(Boolean).join(", ");
      last.set(
        `${change.path}\0${change.field}`,
        `${change.path}: ${value ? `${change.field} is ${value}` : `no ${change.field}`}`,
      );
    } else
      last.set(
        change.path,
        `${last.get(change.path)?.startsWith("new ") ? "new " : ""}${change.path} is ${change.status}`,
      );
  }
  const said = [...last.values()];
  if (said.length === 1) return `tasks: ${said[0]}`;
  return [`tasks: ${said.length} changes`, "", ...said.map((line) => `- ${line}`)].join("\n");
}
