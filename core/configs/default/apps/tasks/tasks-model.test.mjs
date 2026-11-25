// tasks-model.test.mjs — the board's reading and writing of a task file (public/tasks-model.js).
// Run it with `node --test apps/tasks/`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addAsk,
  agentChatPath,
  addNote,
  answerAsk,
  answersOf,
  addDecision,
  agoOf,
  decisionFault,
  keeperOf,
  NEEDS_ORDERS,
  pressOf,
  staleOf,
  stillNeededMessage,
  decisionsOf,
  answerMessage,
  receiversOf,
  askedOf,
  contextOf,
  HUH_DRAFT_MAX,
  needsFor,
  orderNeeds,
  peopleAsked,
  talkDraft,
  applyChange,
  columnOf,
  columnsOf,
  commitOf,
  counts,
  DIMENSIONS,
  dimensionsOf,
  eventPath,
  filterTasks,
  isTaskPath,
  messageOf,
  needsAPerson,
  waitsForAPerson,
  newTask,
  parseTask,
  rewordAsk,
  rowsOf,
  setBlockedOn,
  setField,
  setStatus,
  setTitle,
  slugify,
  tasksOf,
  valuesOf,
  withdrawAsk,
} from "./public/tasks-model.js";

test("a file with frontmatter is a card with its status, tags, size and owner", () => {
  const task = parseTask(
    "tasks/cloud/board-filters.md",
    "---\nstatus: in-progress\nsize: large\ntags: [board, ui]\nowner: jonas\n---\n\n# Board filters\n\nText.\n",
  );
  assert.equal(task.title, "Board filters");
  assert.equal(task.status, "in-progress");
  assert.equal(task.column, "in-progress");
  assert.deepEqual(task.tags, ["board", "ui"]);
  assert.equal(task.size, "large");
  assert.equal(task.owner, "jonas");
  assert.equal(task.folder, "cloud");
});

test("a file with no frontmatter is a task in Todo, titled by its heading or its name", () => {
  assert.equal(parseTask("tasks/a.md", "# Ship it\n").column, "todo");
  assert.equal(parseTask("tasks/a.md", "# Ship it\n").title, "Ship it");
  assert.equal(
    parseTask("tasks/2026-11-19-board-filters.md", "No heading.\n").title,
    "Board filters",
  );
  assert.equal(parseTask("tasks/a.md", "").folder, "");
});

test("the title is the frontmatter's, before the heading; a heading in a code fence is no title", () => {
  assert.equal(
    parseTask("tasks/a.md", '---\ntitle: "From: the top"\n---\n# Heading\n').title,
    "From: the top",
  );
  assert.equal(parseTask("tasks/a.md", "```\n# not this\n```\n\n# This\n").title, "This");
});

test("the older key `state:` and a block list of labels are read", () => {
  const task = parseTask("tasks/a.md", "---\nstate: in-review\nlabels:\n  - one\n  - two\n---\n");
  assert.equal(task.column, "in-review");
  assert.deepEqual(task.tags, ["one", "two"]);
});

test("the spellings that hand-written task files use land in the five columns", () => {
  const column = Object.fromEntries(
    [
      "idea",
      "later",
      "ready",
      "building",
      "in review",
      "needs-decision",
      "done-pending-merge",
      "done, awaiting review",
      "complete",
      "Done",
      "",
    ].map((status) => [status, columnOf(status)]),
  );
  assert.deepEqual(column, {
    idea: "backlog",
    later: "backlog",
    ready: "todo",
    building: "in-progress",
    "in review": "in-review",
    "needs-decision": "in-review",
    "done-pending-merge": "in-review",
    "done, awaiting review": "in-review",
    complete: "done",
    Done: "done",
    "": "todo",
  });
});

test("a status of its own gets a column of its own, after the five", () => {
  const tasks = tasksOf({
    "tasks/a.md": "---\nstatus: blocked\n---\n# A\n",
    "tasks/b.md": "---\nstatus: done\n---\n# B\n",
  });
  assert.deepEqual(
    columnsOf(tasks).map((column) => column.id),
    ["backlog", "todo", "in-progress", "in-review", "done", "blocked"],
  );
});

test("a status change rewrites one line and leaves every other byte", () => {
  const source =
    "---\nsize: small\nstatus: todo   \n# a comment line\ntags:\n  - x\n---\n\n# T\n\n---\nnot frontmatter\n";
  assert.equal(
    setStatus(source, "done"),
    "---\nsize: small\nstatus: done\n# a comment line\ntags:\n  - x\n---\n\n# T\n\n---\nnot frontmatter\n",
  );
});

test("a status change keeps the key the file has, and adds `status:` where there is none", () => {
  assert.equal(setStatus("---\nstate: todo\n---\nBody\n", "done"), "---\nstate: done\n---\nBody\n");
  assert.equal(
    setStatus("---\nsize: small\n---\nBody\n", "done"),
    "---\nsize: small\nstatus: done\n---\nBody\n",
  );
  assert.equal(setStatus("---\n---\nBody\n", "done"), "---\nstatus: done\n---\nBody\n");
  assert.equal(
    setStatus("# Only a body\n", "in-progress"),
    "---\nstatus: in-progress\n---\n\n# Only a body\n",
  );
});

test("a status change keeps Windows line endings, and quotes a status YAML would misread", () => {
  assert.equal(
    setStatus("---\r\nstatus: todo\r\n---\r\nBody\r\n", "done"),
    "---\r\nstatus: done\r\n---\r\nBody\r\n",
  );
  assert.equal(
    parseTask("tasks/a.md", setStatus("# T\n", "waiting: on Misha")).status,
    "waiting: on Misha",
  );
});

test("what was set is what is read", () => {
  for (const status of ["backlog", "todo", "in-progress", "in-review", "done", "blocked"])
    assert.equal(
      parseTask("tasks/a.md", setStatus("---\ntags: [a]\n---\n# T\n", status)).column,
      status,
    );
});

test("a new task is a file under tasks/ named by its title, never over another", () => {
  assert.deepEqual(newTask({ title: "Ship the Tour!" }), {
    path: "tasks/ship-the-tour.md",
    content: "---\nstatus: todo\n---\n\n# Ship the Tour!\n",
  });
  const taken = ["tasks/cloud/ship.md", "tasks/cloud/ship-2.md"];
  assert.equal(
    newTask({ title: "Ship", folder: "cloud", status: "done", taken }).path,
    "tasks/cloud/ship-3.md",
  );
  assert.equal(newTask({ title: "   " }).path, "tasks/new-task.md");
  assert.equal(newTask({ title: "x", folder: "../../Etc" }).path, "tasks/etc/x.md");
});

test("only markdown under tasks/ is a task", () => {
  assert.equal(isTaskPath("tasks/a.md"), true);
  assert.equal(isTaskPath("tasks/deep/er/a.markdown"), true);
  assert.equal(isTaskPath("tasks/proof.cjs"), false);
  assert.equal(isTaskPath("backlog/a.md"), false);
  assert.equal(isTaskPath("apps/tasks/README.md"), false);
});

test("the filter is every word, any of the tags, and a folder with those beneath it", () => {
  const tasks = tasksOf({
    "tasks/a.md": "---\ntags: [ui]\n---\n# Board filters\n",
    "tasks/cloud/b.md": "---\ntags: [cloud]\nowner: misha\n---\n# Cloud arcs\n",
    "tasks/cloud/designs/c.md": "# Wizard design\n",
  });
  const paths = (filter) => filterTasks(tasks, filter).map((task) => task.path);
  assert.deepEqual(paths({ query: "board FILT" }), ["tasks/a.md"]);
  assert.deepEqual(paths({ query: "misha" }), ["tasks/cloud/b.md"]);
  assert.deepEqual(paths({ where: { tags: ["ui", "cloud"] } }), ["tasks/a.md", "tasks/cloud/b.md"]);
  assert.deepEqual(paths({ folder: "cloud" }), ["tasks/cloud/b.md", "tasks/cloud/designs/c.md"]);
  assert.deepEqual(paths({ folder: "" }), ["tasks/a.md"]);
  assert.deepEqual(
    counts(tasks, (task) => task.tags),
    [
      ["cloud", 1],
      ["ui", 1],
    ],
  );
});

const DIMENSIONED = {
  "tasks/a.md":
    "---\nstatus: todo\ntags: [ui, board]\nsize: large\npriority: high\nowner: jonas\n---\n# A\n",
  "tasks/b.md":
    "---\nstatus: done\nlabels: [ui]\nsize: small\nassignee: misha\nagent: /agents/tasks/b\n---\n# B\n",
  "tasks/c.md": "---\nstatus: todo\nsize: large\npriority: urgent\nmood: fine\n---\n# C\n",
  "tasks/deep/d.md": "# D\n",
};

test("a card has the dimensions its frontmatter holds, and no other", () => {
  const [a, b, c, d] = tasksOf(DIMENSIONED);
  assert.deepEqual(
    [a, b].map((task) => [task.tags, task.priority, task.size, task.owner, task.agent]),
    [
      [["ui", "board"], "high", "large", "jonas", ""],
      [["ui"], "", "small", "misha", "/agents/tasks/b"],
    ],
  );
  assert.deepEqual(valuesOf(a, "tags"), ["ui", "board"]);
  assert.deepEqual(valuesOf(c, "owner"), []);
  assert.equal("mood" in c, false);
  assert.deepEqual(
    DIMENSIONS.flatMap(({ id }) => valuesOf(d, id)),
    [],
  );
});

test("a board has a dimension only when a file holds it, with its values in order and their counts", () => {
  const dimensions = dimensionsOf(tasksOf(DIMENSIONED));
  assert.deepEqual(
    dimensions.map(({ id, values, without }) => [id, values, without]),
    [
      [
        "tags",
        [
          ["ui", 2],
          ["board", 1],
        ],
        2,
      ],
      [
        "priority",
        [
          ["urgent", 1],
          ["high", 1],
        ],
        2,
      ],
      [
        "size",
        [
          ["small", 1],
          ["large", 2],
        ],
        1,
      ],
      [
        "owner",
        [
          ["jonas", 1],
          ["misha", 1],
        ],
        2,
      ],
      ["agent", [["/agents/tasks/b", 1]], 3],
    ],
  );
  // no file with a priority: the board has no priority
  assert.deepEqual(
    dimensionsOf(
      tasksOf({ "tasks/a.md": "---\nsize: small\n---\n# A\n", "tasks/b.md": "# B\n" }),
    ).map(({ id }) => id),
    ["size"],
  );
  assert.deepEqual(dimensionsOf(tasksOf({ "tasks/b.md": "# B\n" })), []);
  // a value with no place in the order comes after those that have one
  const sizes = dimensionsOf(
    tasksOf({ "tasks/a.md": "---\nsize: epic\n---\n", "tasks/b.md": "---\nsize: Small\n---\n" }),
  );
  assert.deepEqual(
    sizes[0].values.map(([value]) => value),
    ["Small", "epic"],
  );
});

test("the filter is one value of each dimension named", () => {
  const tasks = tasksOf(DIMENSIONED);
  const paths = (where) => filterTasks(tasks, { where }).map((task) => task.path);
  assert.deepEqual(paths({ size: ["large"] }), ["tasks/a.md", "tasks/c.md"]);
  assert.deepEqual(paths({ size: ["large"], priority: ["urgent"] }), ["tasks/c.md"]);
  assert.deepEqual(paths({ size: ["large", "small"], tags: ["ui"] }), ["tasks/a.md", "tasks/b.md"]);
  assert.deepEqual(paths({ owner: ["misha"] }), ["tasks/b.md"]);
  assert.deepEqual(paths({ owner: [] }).length, 4);
  // the words reach every dimension's values
  assert.deepEqual(
    filterTasks(tasks, { query: "urgent" }).map((task) => task.path),
    ["tasks/c.md"],
  );
  assert.deepEqual(
    filterTasks(tasks, { query: "agents/tasks" }).map((task) => task.path),
    ["tasks/b.md"],
  );
});

test("the rows by a dimension: one a value in order, then the tasks with none; a task with two tags is in two", () => {
  const tasks = tasksOf(DIMENSIONED);
  const rows = (id, of = tasks) =>
    rowsOf(
      of,
      dimensionsOf(tasks).find((each) => each.id === id),
    ).map((row) => [row.value, row.label, row.tasks.map((task) => task.path)]);
  assert.deepEqual(rows("size"), [
    ["small", "small", ["tasks/b.md"]],
    ["large", "large", ["tasks/a.md", "tasks/c.md"]],
    [null, "No size", ["tasks/deep/d.md"]],
  ]);
  assert.deepEqual(rows("tags"), [
    ["ui", "ui", ["tasks/a.md", "tasks/b.md"]],
    ["board", "board", ["tasks/a.md"]],
    [null, "No tag", ["tasks/c.md", "tasks/deep/d.md"]],
  ]);
  // a row with no task shown (a filter took them) is left out
  assert.deepEqual(rows("size", filterTasks(tasks, { where: { owner: ["jonas"] } })), [
    ["large", "large", ["tasks/a.md"]],
  ]);
});

test("a task made in a row is born with the row's value, and the board never writes a dimension else", () => {
  assert.equal(
    newTask({ title: "Big one", fields: { size: "large" } }).content,
    "---\nstatus: todo\nsize: large\n---\n\n# Big one\n",
  );
  assert.equal(
    newTask({ title: "T", fields: { tags: "ui, really" } }).content,
    '---\nstatus: todo\ntags: ["ui, really"]\n---\n\n# T\n',
  );
  assert.equal(
    parseTask("tasks/t.md", newTask({ title: "T", fields: { tags: "ui" } }).content).tags[0],
    "ui",
  );
  assert.equal(
    newTask({ title: "T", fields: { mood: "fine" } }).content,
    "---\nstatus: todo\n---\n\n# T\n",
  );
  // a status change keeps every dimension's line, and a line the board does not know, byte for byte
  const source = DIMENSIONED["tasks/c.md"];
  assert.equal(setStatus(source, "done"), source.replace("status: todo", "status: done"));
});

test("changes are applied to the files as they are at the commit, and a commit names each path once", () => {
  const files = { "tasks/a.md": "---\nstatus: todo\nsize: small\n---\n# A\n" };
  const changes = [
    { kind: "status", path: "tasks/a.md", status: "in-progress" },
    { kind: "create", path: "tasks/b.md", content: "---\nstatus: todo\n---\n\n# B\n" },
    { kind: "status", path: "tasks/b.md", status: "done" },
    { kind: "status", path: "tasks/gone.md", status: "done" },
  ];
  assert.deepEqual(commitOf(files, changes), [
    { path: "tasks/a.md", content: "---\nstatus: in-progress\nsize: small\n---\n# A\n" },
    { path: "tasks/b.md", content: "---\nstatus: done\n---\n\n# B\n" },
  ]);
  assert.equal(
    messageOf(changes.slice(0, 3)),
    "tasks: 2 changes\n\n- tasks/a.md is in-progress\n- new tasks/b.md is done",
  );
  assert.equal(messageOf(changes.slice(0, 1)), "tasks: tasks/a.md is in-progress");
  // a card moved and moved back writes nothing
  assert.deepEqual(
    commitOf(files, [changes[0], { kind: "status", path: "tasks/a.md", status: "todo" }]),
    [],
  );
  // a file somebody else made first is not written over
  assert.equal(applyChange({ "tasks/b.md": "theirs" }, changes[1])["tasks/b.md"], "theirs");
});

// ── what the task sheet writes: a title, a dimension ──

const WRITTEN =
  "---\nstatus: todo\ntags: [ui, billing]\npriority: high\nmood: fine\nowner: jonas\n---\n\n# Billing page\n\nThe page a member pays on.\n";

test("a dimension is written into its own line, and every other byte stays", () => {
  assert.equal(
    setField(WRITTEN, "priority", "low"),
    WRITTEN.replace("priority: high", "priority: low"),
  );
  assert.equal(
    setField(WRITTEN, "owner", "misha t"),
    WRITTEN.replace("owner: jonas", "owner: misha t"),
  );
  assert.equal(
    setField(WRITTEN, "tags", ["ui", "cloud"]),
    WRITTEN.replace("tags: [ui, billing]", "tags: [ui, cloud]"),
  );
  // a dimension the file does not hold yet is added at the frontmatter's end
  assert.equal(
    setField(WRITTEN, "size", "large"),
    WRITTEN.replace("owner: jonas\n", "owner: jonas\nsize: large\n"),
  );
  // an empty value takes the line away, and nothing else
  assert.equal(setField(WRITTEN, "priority", ""), WRITTEN.replace("priority: high\n", ""));
  assert.equal(setField(WRITTEN, "tags", []), WRITTEN.replace("tags: [ui, billing]\n", ""));
  assert.equal(setField(WRITTEN, "size", ""), WRITTEN);
  // a key the board does not know is never written, and no id but a dimension's is
  assert.equal(setField(WRITTEN, "mood", "bad"), WRITTEN);
  assert.equal(setField(WRITTEN, "status", "done"), WRITTEN);
  // what was written is what is read
  assert.deepEqual(parseTask("tasks/a.md", setField(WRITTEN, "tags", ["a b", "c, d", "ui"])).tags, [
    "a b",
    "c, d",
    "ui",
  ]);
  assert.equal(
    parseTask("tasks/a.md", setField(WRITTEN, "owner", "Ada: the first")).owner,
    "Ada: the first",
  );
  assert.deepEqual(parseTask("tasks/a.md", "---\ntags: [it's, other]\n---\n").tags, [
    "it's",
    "other",
  ]);
});

test("a dimension keeps the file's own spelling of its key, its line endings, and a file with no frontmatter gets one", () => {
  assert.equal(
    setField("---\nassignee: jonas\n---\n# T\n", "owner", "misha"),
    "---\nassignee: misha\n---\n# T\n",
  );
  assert.equal(
    setField("---\nlabels: [a]\n---\n# T\n", "tags", ["a", "b"]),
    "---\nlabels: [a, b]\n---\n# T\n",
  );
  // a block list goes with its key, and the key after it stays
  assert.equal(
    setField("---\ntags:\n  - a\n  - b\nsize: small\n---\n# T\n", "tags", ["c"]),
    "---\ntags: [c]\nsize: small\n---\n# T\n",
  );
  // two spellings in one file become one line: the file says one thing
  assert.equal(
    setField("---\ntags: [a]\nlabels: [b]\nsize: small\n---\n", "tags", ["a", "b", "c"]),
    "---\ntags: [a, b, c]\nsize: small\n---\n",
  );
  assert.equal(
    setField("---\r\nstatus: todo\r\n---\r\nBody\r\n", "size", "small"),
    "---\r\nstatus: todo\r\nsize: small\r\n---\r\nBody\r\n",
  );
  assert.equal(setField("# T\n", "size", "small"), "---\nsize: small\n---\n\n# T\n");
  assert.equal(setField("# T\n", "size", ""), "# T\n");
  // the last key taken away leaves the two fences: the board deletes no frontmatter
  assert.equal(setField("---\nsize: small\n---\n# T\n", "size", ""), "---\n---\n# T\n");
  // a status change still leaves a second spelling of its key alone
  assert.equal(
    setStatus("---\nstatus: todo\nstate: old\n---\n", "done"),
    "---\nstatus: done\nstate: old\n---\n",
  );
});

test("a title is written where the file keeps it, and renames nothing", () => {
  // the first heading
  assert.equal(
    setTitle(WRITTEN, "Billing, the page"),
    WRITTEN.replace("# Billing page", "# Billing, the page"),
  );
  assert.equal(parseTask("tasks/billing-page.md", setTitle(WRITTEN, "New name")).title, "New name");
  assert.equal(
    parseTask("tasks/billing-page.md", setTitle(WRITTEN, "New name")).path,
    "tasks/billing-page.md",
  );
  // `title:` in the frontmatter, when the file has it; the heading below it stays
  assert.equal(
    setTitle("---\ntitle: Old\n---\n# A heading\n", "New: one"),
    '---\ntitle: "New: one"\n---\n# A heading\n',
  );
  // a heading in a code fence is no title; the real one after it is
  assert.equal(
    setTitle("```\n# not this\n```\n# This\n", "That"),
    "```\n# not this\n```\n# That\n",
  );
  // no heading: a new one, as the body's first line
  assert.equal(
    setTitle("---\nstatus: todo\n---\n\nJust text.\n", "Named"),
    "---\nstatus: todo\n---\n\n# Named\n\nJust text.\n",
  );
  assert.equal(setTitle("Just text.\n", "Named"), "# Named\n\nJust text.\n");
  assert.equal(setTitle("", "Named"), "# Named\n");
  assert.equal(setTitle("---\nstatus: todo\n---\n", "Named"), "---\nstatus: todo\n---\n# Named\n");
  // line endings stay, and so does every line but the title's
  assert.equal(
    setTitle("---\r\nsize: s\r\n---\r\n\r\n# Old\r\n\r\nText\r\n", "New"),
    "---\r\nsize: s\r\n---\r\n\r\n# New\r\n\r\nText\r\n",
  );
  // new lines in a title are spaces, and an empty title changes nothing
  assert.equal(setTitle("# Old\n", "  Two\nlines "), "# Two lines\n");
  assert.equal(setTitle(WRITTEN, "   "), WRITTEN);
});

test("a title and a dimension are changes like a status: applied to the file as it is at the commit", () => {
  const files = { "tasks/a.md": "---\nstatus: todo\n---\n\n# A\n" };
  const changes = [
    { kind: "title", path: "tasks/a.md", title: "A, renamed" },
    { kind: "field", path: "tasks/a.md", field: "priority", value: "high" },
    { kind: "field", path: "tasks/a.md", field: "tags", value: ["ui"] },
    { kind: "status", path: "tasks/a.md", status: "done" },
    { kind: "field", path: "tasks/gone.md", field: "size", value: "small" },
  ];
  assert.deepEqual(commitOf(files, changes), [
    {
      path: "tasks/a.md",
      content: "---\nstatus: done\npriority: high\ntags: [ui]\n---\n\n# A, renamed\n",
    },
  ]);
  // somebody edited the text meanwhile: their line stays, ours are applied to their file
  const theirs = {
    "tasks/a.md": "---\nstatus: todo\nsize: large\n---\n\n# A\n\nTheir new paragraph.\n",
  };
  assert.equal(
    commitOf(theirs, changes)[0].content,
    "---\nstatus: done\nsize: large\npriority: high\ntags: [ui]\n---\n\n# A, renamed\n\nTheir new paragraph.\n",
  );
  assert.equal(
    messageOf(changes.slice(0, 4)),
    "tasks: 4 changes\n\n- tasks/a.md: the title\n- tasks/a.md: priority is high\n- tasks/a.md: tags is ui\n- tasks/a.md is done",
  );
  assert.equal(
    messageOf([{ kind: "field", path: "tasks/a.md", field: "size", value: "" }]),
    "tasks: tasks/a.md: no size",
  );
  // a property set and set back writes nothing
  assert.deepEqual(
    commitOf({ "tasks/a.md": WRITTEN }, [
      { kind: "field", path: "tasks/a.md", field: "priority", value: "low" },
      { kind: "field", path: "tasks/a.md", field: "priority", value: "high" },
    ]),
    [],
  );
});

test("a long title's file name is cut at a word", () => {
  const path = newTask({
    title: "The task sheet: a card opens in the board, with the Docs editor and comments",
  }).path;
  assert.equal(path, "tasks/the-task-sheet-a-card-opens-in-the-board-with-the-docs-editor.md");
  assert.equal(slugify("one two three", 9), "one-two");
  assert.equal(slugify("one two three", 7), "one-two");
  assert.equal(slugify("one two three", 8), "one-two");
  // a first word that is too long alone is cut where it must be
  assert.equal(slugify("supercalifragilistic", 5), "super");
  assert.equal(slugify("short"), "short");
});

test("blocked-on and human-ask are read whole, and only an open task that asks needs a person", () => {
  const asks = parseTask(
    "tasks/a.md",
    "---\nstatus: todo\nhuman-ask: [sign the grant, read it]\nblocked-on: a review, then a deploy\n---\n# A\n",
  );
  assert.deepEqual(asks.humanAsk, ["sign the grant", "read it"]);
  assert.equal(asks.blockedOn, "a review, then a deploy");
  const oneLine = parseTask("tasks/b.md", "---\nhuman-ask: say yes, or no\n---\n# B\n");
  assert.deepEqual(oneLine.humanAsk, ["say yes, or no"]);
  const block = parseTask(
    "tasks/c.md",
    "---\nblocked_on: CI\nhuman-ask:\n  - one\n  - two\n---\n# C\n",
  );
  assert.deepEqual([block.blockedOn, block.humanAsk], ["CI", ["one", "two"]]);
  const none = parseTask("tasks/d.md", "---\nstatus: todo\nhuman-ask:\n---\n# D\n");
  assert.deepEqual([none.blockedOn, none.humanAsk], ["", []]);
  const done = parseTask("tasks/e.md", "---\nstatus: done\nhuman-ask: [late]\n---\n# E\n");
  const blocked = parseTask("tasks/f.md", "---\nblocked-on: CI\n---\n# Aa blocked\n");
  // a task that is held and asks nothing waits for no person
  assert.deepEqual(
    needsAPerson([none, done, blocked, oneLine, asks]).map((task) => task.title),
    ["A", "B"],
  );
});

test("a card's mark: only an open task that asks has one, and it names whom the asks name", () => {
  const card = (front) => parseTask("tasks/a.md", `---\n${front}\n---\n# A\n`);
  // no ask, a done task, a task that is only held: no mark
  assert.equal(waitsForAPerson(card("status: todo")), null);
  assert.equal(waitsForAPerson(card("status: done\nhuman-ask: [Jonas: late?]")), null);
  assert.equal(waitsForAPerson(card("status: in-progress\nblocked-on: CI")), null);
  // an ask that names nobody
  assert.deepEqual(waitsForAPerson(card("status: todo\nhuman-ask: Should this mind be let in?")), {
    asks: 1,
    people: [],
    label: "Needs a person",
  });
  // the names before the first colon, each once, in the asks' order
  assert.deepEqual(
    waitsForAPerson(
      card(
        'status: in-review\nhuman-ask:\n  - "Jonas: delete the 5 kept sign-ins, yes or no?"\n  - "Jonas or Misha: may we merge?"\n  - Ship it?',
      ),
    ),
    { asks: 3, people: ["Jonas", "Misha"], label: "Needs Jonas, Misha" },
  );
  // the mark and "Needs a person" are one rule
  const all = [
    card("status: todo"),
    card("status: done\nhuman-ask: [x]"),
    card("human-ask: [x]"),
    card("blocked-on: CI"),
  ];
  assert.deepEqual(
    needsAPerson(all),
    all.filter((task) => waitsForAPerson(task)),
  );
});

test("whom an ask names: the names before its first colon, and nothing else", () => {
  assert.deepEqual(askedOf("Jonas: may I make one proof agent?"), ["Jonas"]);
  assert.deepEqual(askedOf("Jonas, Misha and Jo: who signs?"), ["Jonas", "Misha", "Jo"]);
  assert.deepEqual(askedOf("Jonas & Misha: ok?"), ["Jonas", "Misha"]);
  for (const ask of [
    "Should this mind be let in? If yes, open https://iterate.com/x",
    "Note: the deploy waits",
    "PR: merge it?",
    "Merge #12 now: yes or no?",
    "jonas: lower case",
    "Open the page and say what is wrong: the menu",
    "",
    undefined,
  ])
    assert.deepEqual(askedOf(ask), [], String(ask));
});

test("a # in blocked-on or human-ask is a word; after any other key it starts a comment", () => {
  const task = parseTask(
    "tasks/a.md",
    '---\nstatus: todo # soon\nblocked-on: PR #12 review\nhuman-ask:\n  - Merge #99, or wait?\n  - "quoted # too"\n---\n# A\n',
  );
  assert.equal(task.status, "todo");
  assert.equal(task.blockedOn, "PR #12 review");
  assert.deepEqual(task.humanAsk, ["Merge #99, or wait?", "quoted # too"]);
  assert.deepEqual(parseTask("tasks/b.md", "---\nhuman-ask: [Sign #7?, read it]\n---\n").humanAsk, [
    "Sign #7?",
    "read it",
  ]);
});

const answered = {
  answer: " Wait for\nthe deploy. ",
  by: "misha@nustom.com",
  at: "2026-11-20T14:50:31.000Z",
};

test("an answer takes the ask's line out of the frontmatter and keeps both under ## Answers", () => {
  const file =
    "---\nstatus: todo\nhuman-ask:\n  - Merge #12 now, or wait?\n  - Sign the grant?\nowner: jonas\n---\n\n# A\n\nText.\n";
  const one = answerAsk(file, { ask: "Merge #12 now, or wait?", ...answered });
  assert.equal(
    one,
    "---\nstatus: todo\nhuman-ask:\n  - Sign the grant?\nowner: jonas\n---\n\n# A\n\nText.\n\n## Answers\n\n- **Merge #12 now, or wait?** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n",
  );
  // the last ask takes its key with it, and the second answer goes under the same heading
  const two = answerAsk(one, {
    ask: "Sign the grant?",
    answer: "",
    by: "jonas@nustom.com",
    at: "2026-11-21T09:05:00.000Z",
  });
  assert.equal(
    two,
    "---\nstatus: todo\nowner: jonas\n---\n\n# A\n\nText.\n\n## Answers\n\n- **Merge #12 now, or wait?** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n- **Sign the grant?** (jonas@nustom.com, 2026-11-21 09:05 UTC)\n",
  );
  assert.deepEqual(
    [parseTask("tasks/a.md", one).humanAsk, parseTask("tasks/a.md", two).humanAsk],
    [["Sign the grant?"], []],
  );
  // an ask that the file does not have changes nothing
  assert.equal(answerAsk(file, { ask: "Another ask?", ...answered }), file);
  assert.equal(answerAsk("# No frontmatter\n", { ask: "x", ...answered }), "# No frontmatter\n");
});

test("an ask that is taken off leaves the frontmatter and writes no answer; one that is written again keeps its place in the list's end", () => {
  const file =
    "---\nstatus: todo\nhuman-ask:\n  - Merge #12 now, or wait?\n  - Sign the grant?\nowner: jonas\n---\n\n# A\n\nText.\n";
  assert.equal(
    withdrawAsk(file, "Merge #12 now, or wait?"),
    "---\nstatus: todo\nhuman-ask:\n  - Sign the grant?\nowner: jonas\n---\n\n# A\n\nText.\n",
  );
  // the last ask takes its key with it; every other byte stays
  assert.equal(
    withdrawAsk(withdrawAsk(file, "Merge #12 now, or wait?"), "Sign the grant?"),
    "---\nstatus: todo\nowner: jonas\n---\n\n# A\n\nText.\n",
  );
  assert.equal(
    withdrawAsk("---\nhuman-ask: [Sign #7?, read it]\n---\n\n# B\n", "read it"),
    "---\nhuman-ask: [Sign #7?]\n---\n\n# B\n",
  );
  assert.equal(withdrawAsk("---\nhuman-ask: one ask\n---\n# C\n", "one ask"), "---\n---\n# C\n");
  assert.equal(
    rewordAsk(file, "Merge #12 now, or wait?", " Jonas: merge  #12 now,\nyes or no? "),
    "---\nstatus: todo\nhuman-ask:\n  - Sign the grant?\n  - Jonas: merge #12 now, yes or no?\nowner: jonas\n---\n\n# A\n\nText.\n",
  );
  // an ask that the file does not have, and new words that are empty, change nothing
  assert.equal(withdrawAsk(file, "Another ask?"), file);
  assert.equal(rewordAsk(file, "Another ask?", "New words?"), file);
  assert.equal(rewordAsk(file, "Sign the grant?", "  "), file);
  assert.equal(withdrawAsk("# No frontmatter\n", "x"), "# No frontmatter\n");
  // as changes of a commit, with a message that says what happened to each ask
  const changes = [
    { kind: "withdraw", path: "tasks/a.md", ask: "Merge #12 now, or wait?" },
    {
      kind: "reword",
      path: "tasks/a.md",
      ask: "Sign the grant?",
      to: "Jonas: sign the grant, yes or no?",
    },
  ];
  // the card's only ask written again: its key is made again, at the frontmatter's end
  assert.deepEqual(commitOf({ "tasks/a.md": file }, changes), [
    {
      path: "tasks/a.md",
      content:
        "---\nstatus: todo\nowner: jonas\nhuman-ask:\n  - Jonas: sign the grant, yes or no?\n---\n\n# A\n\nText.\n",
    },
  ]);
  assert.equal(
    messageOf(changes),
    'tasks: 2 changes\n\n- tasks/a.md: no longer asks "Merge #12 now, or wait?"\n- tasks/a.md: asks again, as "Jonas: sign the grant, yes or no?"',
  );
});

test("an answer finds an ask however the file writes it, and its heading wherever it is", () => {
  const inline = answerAsk('---\nhuman-ask: [Sign #7?, "read it, all"]\n---\n# A', {
    ask: "read it, all",
    ...answered,
  });
  assert.equal(
    inline,
    "---\nhuman-ask: [Sign #7?]\n---\n# A\n\n## Answers\n\n- **read it, all** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n",
  );
  const line = answerAsk("---\nhuman_ask: say yes, or no\n---\n", {
    ask: "say yes, or no",
    ...answered,
  });
  assert.equal(
    line,
    "---\n---\n## Answers\n\n- **say yes, or no** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n",
  );
  // a heading with a section after it, and one inside a code fence that is no heading
  const between =
    "---\nhuman-ask: [x]\n---\n# A\n\n```\n## Answers\n```\n\n## Answers\n\n- **old** yes (a@x, 2026-11-19 10:00 UTC)\n\n## Later\n\nMore.\n";
  assert.equal(
    answerAsk(between, { ask: "x", ...answered }),
    "---\n---\n# A\n\n```\n## Answers\n```\n\n## Answers\n\n- **old** yes (a@x, 2026-11-19 10:00 UTC)\n- **x** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n\n## Later\n\nMore.\n",
  );
  // an empty section, and a file with Windows line ends
  assert.equal(
    answerAsk("---\nhuman-ask: [x]\n---\n## Answers\n", { ask: "x", ...answered }),
    "---\n---\n## Answers\n\n- **x** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n",
  );
  assert.equal(
    answerAsk("---\r\nhuman-ask: [x]\r\n---\r\n# A\r\n", { ask: "x", ...answered }),
    "---\r\n---\r\n# A\r\n\r\n## Answers\r\n\r\n- **x** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\r\n",
  );
});

test("an answer is a change like any other: applied to the file as it is at the commit, and named in the message", () => {
  const files = { "tasks/a.md": "---\nstatus: todo\nhuman-ask:\n  - Sign the grant?\n---\n# A\n" };
  const change = { kind: "answer", path: "tasks/a.md", ask: "Sign the grant?", ...answered };
  const [written] = commitOf(files, [
    { kind: "status", path: "tasks/a.md", status: "in-progress" },
    change,
  ]);
  assert.equal(
    written.content,
    "---\nstatus: in-progress\n---\n# A\n\n## Answers\n\n- **Sign the grant?** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n",
  );
  assert.equal(messageOf([change]), 'tasks: tasks/a.md: answered "Sign the grant?"');
  // an ask that somebody else answered meanwhile is gone from the file: the change writes nothing
  assert.deepEqual(commitOf({ "tasks/a.md": "---\nstatus: todo\n---\n# A\n" }, [change]), []);
  assert.equal(applyChange({}, change)["tasks/a.md"], undefined);
});

test("the answers that a task's text keeps are read back as they were written", () => {
  const file =
    "---\nstatus: todo\nhuman-ask:\n  - Merge #12 now, or wait?\n  - Sign the grant?\n---\n# A\n";
  const one = answerAsk(file, {
    ask: "Merge #12 now, or wait?",
    answer: "Wait (until Monday).",
    by: "misha@nustom.com",
    at: "2026-11-20T14:50:31.000Z",
  });
  const two = answerAsk(one, {
    ask: "Sign the grant?",
    answer: "",
    by: "a test of the pilot",
    at: "2026-11-21T09:05:00.000Z",
  });
  assert.deepEqual(answersOf(two), [
    {
      ask: "Merge #12 now, or wait?",
      answer: "Wait (until Monday).",
      by: "misha@nustom.com",
      at: "2026-11-20 14:50",
    },
    { ask: "Sign the grant?", answer: "", by: "a test of the pilot", at: "2026-11-21 09:05" },
  ]);
  // only the lines of that form under that heading: not a list elsewhere, not one in a code fence
  const other =
    "# A\n\n- **bold** words (a@x, 2026-11-20 14:50 UTC)\n\n```\n## Answers\n- **x** y (a@x, 2026-11-20 14:50 UTC)\n```\n\n## Answers\n\nA line of prose.\n- **x** y (a@x, 2026-11-20 14:50 UTC)\n\n## Later\n\n- **z** no (a@x, 2026-11-20 14:50 UTC)\n";
  assert.deepEqual(answersOf(other), [
    { ask: "x", answer: "y", by: "a@x", at: "2026-11-20 14:50" },
  ]);
  assert.deepEqual(answersOf(file), []);
});

const asksOf = (source) => parseTask("tasks/a.md", source).humanAsk;

test("an ask is one more line under human-ask, however the file wrote the key, and is read back as it was", () => {
  const plain = "---\nstatus: todo\n---\n# A\n";
  const one = addAsk(plain, " Merge #12 now,\n or wait? ");
  assert.equal(one, "---\nstatus: todo\nhuman-ask:\n  - Merge #12 now, or wait?\n---\n# A\n");
  // a second ask goes after the first, and a key in the middle keeps its place
  const two = addAsk(
    "---\nhuman-ask:\n  - Merge #12 now, or wait?\nowner: jonas\n---\n# A\n",
    "Sign the grant?",
  );
  assert.equal(
    two,
    "---\nhuman-ask:\n  - Merge #12 now, or wait?\n  - Sign the grant?\nowner: jonas\n---\n# A\n",
  );
  // one line after the key, and an inline list, become lines of a list with their items as written
  assert.equal(
    addAsk("---\nhuman_ask: say yes, or no\n---\n", "And why?"),
    "---\nhuman_ask:\n  - say yes, or no\n  - And why?\n---\n",
  );
  assert.equal(
    addAsk('---\nhuman-ask: [Sign #7?, "read it, all"]\n---\n', "And why?"),
    '---\nhuman-ask:\n  - Sign #7?\n  - "read it, all"\n  - And why?\n---\n',
  );
  assert.deepEqual(
    asksOf(addAsk('---\nhuman-ask: [Sign #7?, "read it, all"]\n---\n', "And why?")),
    ["Sign #7?", "read it, all", "And why?"],
  );
  // a file with no frontmatter gets one; an ask that is there already, or an empty one, changes nothing
  assert.equal(addAsk("# A\n", "Why?"), "---\nhuman-ask:\n  - Why?\n---\n\n# A\n");
  assert.equal(addAsk(one, "Merge #12 now, or wait?"), one);
  assert.equal(addAsk(plain, "  "), plain);
  // words that the reader would take for quotes or for a list come back as they were
  for (const odd of [
    '"Ship it" or "wait"',
    "'quoted'",
    "[x] tick this",
    "[all of it]",
    "- a dash first",
    "a # b",
  ])
    assert.deepEqual(asksOf(addAsk(plain, odd)), [odd], odd);
  // and an ask that was added can be answered
  assert.deepEqual(
    asksOf(
      answerAsk(addAsk(plain, "[all of it]"), {
        ask: "[all of it]",
        answer: "yes",
        by: "a@x",
        at: "2026-11-20T14:50:00.000Z",
      }),
    ),
    [],
  );
});

test("blocked-on is one line, set and taken away, and read back as it was", () => {
  const plain = "---\nstatus: todo\n---\n# A\n";
  const blocked = setBlockedOn(plain, " PR #12\n review ");
  assert.equal(blocked, "---\nstatus: todo\nblocked-on: PR #12 review\n---\n# A\n");
  assert.equal(
    setBlockedOn(blocked, "the deploy"),
    "---\nstatus: todo\nblocked-on: the deploy\n---\n# A\n",
  );
  assert.equal(setBlockedOn(blocked, ""), plain);
  assert.equal(setBlockedOn(plain, null), plain);
  // the file's own spelling of the key stays
  assert.equal(
    setBlockedOn("---\nblocked_on: CI\n---\n", "a review"),
    "---\nblocked_on: a review\n---\n",
  );
  for (const odd of ["[CI] is red", "[all of it]", '"the deploy"', "'x'"])
    assert.equal(parseTask("tasks/a.md", setBlockedOn(plain, odd)).blockedOn, odd, odd);
});

test("a note is one line under ## Log, after the notes before it", () => {
  const file = "---\nstatus: todo\n---\n\n# A\n\nText.\n";
  const at = "2026-11-20T15:40:31.000Z";
  const one = addNote(file, {
    note: " Found the cause:\n the hint races. ",
    by: "/agents/worker",
    at,
  });
  assert.equal(
    one,
    "---\nstatus: todo\n---\n\n# A\n\nText.\n\n## Log\n\n- 2026-11-20 15:40 UTC, /agents/worker: Found the cause: the hint races.\n",
  );
  const two = addNote(one, {
    note: "Fixed.",
    by: "/agents/worker",
    at: "2026-11-20T16:05:00.000Z",
  });
  assert.equal(two, `${one}- 2026-11-20 16:05 UTC, /agents/worker: Fixed.\n`);
  assert.equal(addNote(file, { note: "  ", by: "x", at }), file);
  // the log and the answers are two sections: each line goes under its own heading, wherever that is
  const answered = answerAsk(addAsk(two, "Ship it?"), {
    ask: "Ship it?",
    answer: "Yes.",
    by: "a@x",
    at,
  });
  const noted = addNote(answered, {
    note: "Shipped.",
    by: "/agents/worker",
    at: "2026-11-20T16:30:00.000Z",
  });
  assert.equal(
    noted,
    "---\nstatus: todo\n---\n\n# A\n\nText.\n\n## Log\n\n- 2026-11-20 15:40 UTC, /agents/worker: Found the cause: the hint races.\n- 2026-11-20 16:05 UTC, /agents/worker: Fixed.\n- 2026-11-20 16:30 UTC, /agents/worker: Shipped.\n\n## Answers\n\n- **Ship it?** Yes. (a@x, 2026-11-20 15:40 UTC)\n",
  );
});

test("an ask, what holds a task and a note are changes like the others, each named in the message", () => {
  const files = { "tasks/a.md": "---\nstatus: todo\n---\n# A\n" };
  const changes = [
    { kind: "status", path: "tasks/a.md", status: "in-progress" },
    { kind: "blocked", path: "tasks/a.md", blockedOn: "PR #12" },
    { kind: "ask", path: "tasks/a.md", ask: "Ship it?" },
    {
      kind: "note",
      path: "tasks/a.md",
      note: "Started.",
      by: "/agents/worker",
      at: "2026-11-20T15:40:31.000Z",
    },
  ];
  const [written] = commitOf(files, changes);
  assert.equal(
    written.content,
    "---\nstatus: in-progress\nblocked-on: PR #12\nhuman-ask:\n  - Ship it?\n---\n# A\n\n## Log\n\n- 2026-11-20 15:40 UTC, /agents/worker: Started.\n",
  );
  assert.equal(
    messageOf(changes),
    'tasks: 4 changes\n\n- tasks/a.md is in-progress\n- tasks/a.md: blocked on PR #12\n- tasks/a.md: asks "Ship it?"\n- tasks/a.md: a note',
  );
  assert.equal(
    messageOf([{ kind: "blocked", path: "tasks/a.md", blockedOn: "" }]),
    "tasks: tasks/a.md: no longer blocked",
  );
  // a kind that the model does not know changes nothing
  assert.deepEqual(commitOf(files, [{ kind: "explode", path: "tasks/a.md" }]), []);
});

test("an agent's chat in the Dash: the address that itx.config.dashLink answers, and none for a plain name", () => {
  // each address is what the live mind's itx.config.dashLink({ view: "agent", contextPath }) answered on 20 Nov 2026
  assert.equal(
    agentChatPath("/agents/claude/tasks-agent-chat-link-mwp6c8m4-852f95"),
    "/agents/agents/claude/tasks-agent-chat-link-mwp6c8m4-852f95",
  );
  assert.equal(agentChatPath("/agents/voice/a b:c."), "/agents/agents/voice/a%20b:c%2E");
  assert.equal(agentChatPath("/agents/é@x,y+z"), "/agents/agents/%C3%A9@x,y+z");
  assert.equal(agentChatPath("/agents//x"), "/agents?contextPath=/agents//x");
  // a card whose agent is no context path has no chat to open
  for (const none of ["claude", "", undefined, null, "/", "https://evil.example/x"])
    assert.equal(agentChatPath(none), null);
});

test("filterTasks filters by statuses (normalized column ids)", () => {
  const tasks = tasksOf({
    "tasks/a.md": "---\nstatus: in-progress\ntags: [onboarding]\n---\n\n# Active\n",
    "tasks/b.md": "---\nstatus: todo\ntags: [onboarding]\n---\n\n# Next\n",
    "tasks/c.md": "---\nstatus: done\ntags: [onboarding]\n---\n\n# Finished\n",
    "tasks/d.md": "---\nstatus: backlog\ntags: [other]\n---\n\n# Later\n",
  });
  assert.deepEqual(
    filterTasks(tasks, { where: { tags: ["onboarding"] }, statuses: ["in-progress", "todo"] }).map(
      (t) => t.path,
    ),
    ["tasks/a.md", "tasks/b.md"],
  );
  assert.deepEqual(
    filterTasks(tasks, { statuses: ["completed"] }).map((t) => t.path),
    ["tasks/c.md"],
  );
});

test("newTask writes multiple values for a multi-value dimension like tags", () => {
  const created = newTask({
    title: "Follow up with Andy",
    status: "todo",
    fields: { tags: ["onboarding", "first-sitting"], priority: "high" },
  });
  assert.equal(created.path, "tasks/follow-up-with-andy.md");
  assert.match(created.content, /^tags: \[onboarding, first-sitting\]$/m);
  assert.match(created.content, /^priority: high$/m);
});

test("parseTask reads depends-on and depends_on frontmatter", () => {
  const card = parseTask(
    "tasks/onboarding-telemetry.md",
    "---\nstatus: todo\ntags: [onboarding]\ndepends-on: [tasks/onboarding-website.md, tasks/onboarding-look.md]\n---\n\n# Telemetry\n",
  );
  assert.deepEqual(card.dependsOn, ["tasks/onboarding-website.md", "tasks/onboarding-look.md"]);
});

test("huh? drafts a question to a new agent, and its link keeps the draft in the hash", async () => {
  const { huhDraft, huhHref, HUH_DRAFT_MAX } = await import("./public/tasks-model.js");
  const ask =
    'Jonas: turn on the tools in [the Dash](https://dash.iterate.com/settings), yes or no? 100% & "now" #1';
  const draft = huhDraft({
    domain: "iterate.com",
    path: "tasks/turn on.md",
    title: "Turn on the tools",
    ask,
    asker: { agent: "/agents/claude/x", at: "2026-11-23T15:40:12.000Z" },
    taskAgent: "/agents/claude/y",
  });
  // the ask whole, the task's link and file, and the agent that asked
  assert.ok(draft.includes(`The question: "${ask}"`));
  assert.ok(
    draft.includes(
      'The task: "Turn on the tools", https://tasks.iterate.com/?task=tasks%2Fturn+on.md (the file tasks/turn on.md of the repo /repos/tasks)',
    ),
  );
  assert.ok(draft.includes("The agent that asked: /agents/claude/x (on 2026-11-23 15:40 UTC)"));
  assert.ok(draft.includes("do not message the agent that asked"));
  assert.ok(!draft.includes("/agents/claude/y"));
  // another repo's board is named in the link and in the words
  assert.ok(
    huhDraft({ domain: "iterate.com", repo: "trial", path: "tasks/a.md", ask: "x?" }).includes(
      "https://tasks.iterate.com/?repo=trial&task=tasks%2Fa.md (the file tasks/a.md of the repo /repos/trial)",
    ),
  );
  // a person who asked on the board; nobody on record
  assert.ok(
    huhDraft({
      domain: "d.test",
      path: "tasks/a.md",
      ask: "x?",
      asker: { by: "misha@nustom.com" },
    }).includes("Asked by the person misha@nustom.com, on the task board"),
  );
  assert.ok(
    huhDraft({
      domain: "d.test",
      path: "tasks/a.md",
      ask: "x?",
      asker: {},
      taskAgent: "/agents/z",
    }).includes("Who asked is not recorded. The agent that has the task: /agents/z"),
  );
  assert.ok(
    huhDraft({ domain: "d.test", path: "tasks/a.md", ask: "x?", asker: { unread: true } }).includes(
      "Who asked is not recorded.",
    ),
  );
  // the link: the Dash's home, and the draft in the hash alone
  const href = new URL(huhHref("iterate.com", draft));
  assert.equal(href.origin + href.pathname + href.search, "https://dash.iterate.com/");
  assert.equal(new URLSearchParams(href.hash.slice(1)).get("draft"), draft);
  const long = new URL(huhHref("iterate.com", "x".repeat(9000)));
  assert.equal(new URLSearchParams(long.hash.slice(1)).get("draft").length, HUH_DRAFT_MAX);
});

test("a line's Markdown links and bare addresses are links, and nothing else is", async () => {
  const { linkedParts } = await import("./public/tasks-model.js");
  assert.deepEqual(
    linkedParts(
      "Jonas: turn on the tools in [iterate.com's Dash](https://dash.iterate.com/settings), yes or no?",
    ),
    [
      { text: "Jonas: turn on the tools in " },
      { text: "iterate.com's Dash", href: "https://dash.iterate.com/settings" },
      { text: ", yes or no?" },
    ],
  );
  // two links, one with brackets in its address
  assert.deepEqual(linkedParts("[a](https://x.test/a_(b)) and [c](http://y.test/?q=1&r=2)"), [
    { text: "a", href: "https://x.test/a_(b)" },
    { text: " and " },
    { text: "c", href: "http://y.test/?q=1&r=2" },
  ]);
  // a bare address ends before the sentence's full stop and bracket
  assert.deepEqual(
    linkedParts("Read #12 (https://github.com/iterate/private/pull/12). Then say yes."),
    [
      { text: "Read #12 (" },
      {
        text: "https://github.com/iterate/private/pull/12",
        href: "https://github.com/iterate/private/pull/12",
      },
      { text: "). Then say yes." },
    ],
  );
  assert.deepEqual(linkedParts("see https://en.wikipedia.org/wiki/A_(b)"), [
    { text: "see " },
    { text: "https://en.wikipedia.org/wiki/A_(b)", href: "https://en.wikipedia.org/wiki/A_(b)" },
  ]);
  // no link: another scheme, a name and password in the address, plain words
  for (const plain of [
    "[x](javascript:alert(1))",
    "[x](https://me:secret@x.test/)",
    "https://me:secret@x.test/ now",
    "Sign #7 [now]?",
    "",
  ])
    assert.deepEqual(linkedParts(plain), plain ? [{ text: plain }] : []);
  assert.deepEqual(linkedParts(undefined), []);
});

test("an ask that begins with a link is kept and read back as it was written", () => {
  const ask = "[The Dash](https://dash.iterate.com/) shows it: yes or no?";
  const source = addAsk("---\nstatus: todo\n---\n# A\n", ask);
  assert.deepEqual(parseTask("tasks/a.md", source).humanAsk, [ask]);
  const whole = "[yes](https://x.test/) or [no]";
  assert.deepEqual(parseTask("tasks/a.md", addAsk("# A\n", whole)).humanAsk, [whole]);
});

test("Needs a person: whom the asks name, the tasks for one person, and the order by when an ask was asked", () => {
  const card = (path, front) => parseTask(path, `---\nstatus: todo\n${front}\n---\n# ${path}\n`);
  const a = card("tasks/a.md", 'human-ask:\n  - "Jonas: one?"\n  - "Jonas or Misha: two?"');
  const b = card("tasks/b.md", "human-ask: Should this mind be let in?");
  const c = card("tasks/c.md", 'human-ask:\n  - "Misha: three?"\n  - Four?');
  const all = [a, b, c];
  assert.deepEqual(peopleAsked(all), [
    ["Misha", 2],
    ["Jonas", 1],
    ["", 2],
  ]);
  assert.deepEqual(peopleAsked([a]), [
    ["Jonas", 1],
    ["Misha", 1],
  ]);
  assert.deepEqual(needsFor(all, "Jonas"), [a]);
  assert.deepEqual(needsFor(all, "Misha"), [a, c]);
  assert.deepEqual(needsFor(all, ""), [b, c]);
  assert.equal(needsFor(all, null), all);
  // a task's time is its oldest ask's (oldest) or its newest ask's (newest); no time is last
  const at = {
    "Jonas: one?": "2026-11-20T10:00:00Z",
    "Jonas or Misha: two?": "2026-11-24T10:00:00Z",
    "Misha: three?": "2026-11-22T10:00:00Z",
  };
  const askedAt = (_task, ask) => at[ask];
  assert.deepEqual(orderNeeds(all, "oldest", askedAt), [a, c, b]);
  assert.deepEqual(orderNeeds(all, "newest", askedAt), [a, c, b]);
  assert.deepEqual(
    orderNeeds([c, a, b], "newest", (_task, ask) =>
      ask === "Jonas or Misha: two?" ? null : at[ask],
    ),
    [c, a, b],
  );
  assert.deepEqual(orderNeeds([b, c, a], "title", askedAt), [b, c, a]);
  assert.deepEqual(
    orderNeeds(all, "oldest", () => null),
    all,
  );
});

test("how long ago, and what a person reads before they answer", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  assert.deepEqual(
    [
      "2026-11-25T11:59:40Z",
      "2026-11-25T11:20:00Z",
      "2026-11-25T03:00:00Z",
      "2026-11-22T12:00:00Z",
      "2026-11-01T12:00:00Z",
      null,
      "soon",
    ].map((at) => agoOf(at, now)),
    ["now", "40 min", "9 h", "3 d", "3 wk", "", ""],
  );
  const file =
    "---\nstatus: todo\n---\n\n# The title\n\nJonas said: do it.\n\n\n\nSecond paragraph.\n\n## Done when\n\n- [ ] x\n\n## Log\n\n- 2026-11-20 10:00 UTC, /agents/a: one\n- 2026-11-21 10:00 UTC, /agents/a: two\nnot a note\n- 2026-11-22 10:00 UTC, /agents/b: three\n\n## Answers\n\n- **x** y (z, 2026-11-23 10:00 UTC)\n";
  assert.deepEqual(contextOf(file, { notes: 2 }), {
    about: "Jonas said: do it.\n\nSecond paragraph.",
    notes: ["2026-11-22 10:00 UTC, /agents/b: three", "2026-11-21 10:00 UTC, /agents/a: two"],
  });
  assert.deepEqual(contextOf("# T\n\none two three four", { max: 12 }), {
    about: "one two …",
    notes: [],
  });
  assert.deepEqual(contextOf("---\nstatus: todo\n---\n"), { about: "", notes: [] });
});

test("Talk these through drafts a question to a new agent that answers nothing itself", () => {
  const card = (path) =>
    parseTask(path, `---\nhuman-ask: ["Jonas: yes or no?"]\n---\n# Title of ${path}\n`);
  const draft = talkDraft({
    domain: "example.com",
    tasks: [card("tasks/a.md"), card("tasks/b.md")],
    who: "Jonas",
  });
  assert.match(draft, /those for Jonas\)\. 2 questions wait for a person's answer, on 2 tasks\./);
  assert.match(draft, /itx\.config\.taskAskers\(\)/);
  assert.match(draft, /https:\/\/tasks\.example\.com\/\?needs=person/);
  assert.match(draft, /- tasks\/a\.md: Title of tasks\/a\.md\n- tasks\/b\.md/);
  assert.match(draft, /Do not answer a question on the board, do not approve anything for me/);
  const many = talkDraft({
    domain: "example.com",
    repo: "other",
    tasks: Array.from({ length: 15 }, (_, n) => card(`tasks/${n}.md`)),
  });
  assert.match(many, /- and 3 more/);
  assert.match(many, /taskAskers\(\{ repo: "other" \}\)/);
  assert.match(many, /\?repo=other&needs=person/);
  assert.ok(many.length < HUH_DRAFT_MAX);
});

test("one event of a context in the Dash: the raw view with the event open, and none for no path or no offset", () => {
  assert.equal(
    eventPath("/agents/claude/x-1", 41),
    "/contexts/agents/claude/x-1?view=%7B%22event%22%3A41%7D",
  );
  assert.equal(
    new URLSearchParams(eventPath("/agents/a", 0).split("?")[1]).get("view"),
    '{"event":0}',
  );
  assert.equal(
    eventPath("/agents/a b//c", 7),
    "/contexts?contextPath=/agents/a%20b//c&view=%7B%22event%22%3A7%7D",
  );
  for (const [path, offset] of [
    ["worker", 1],
    ["/", 1],
    ["/agents/a", null],
    ["/agents/a", -1],
    ["/agents/a", 1.5],
    ["/agents/a", "7"],
  ])
    assert.equal(eventPath(path, offset), null);
});

test("who hears an answer: the asker, by the card it follows or by a message, and the task's agent that follows", () => {
  const task = parseTask("tasks/a.md", "---\nagent: /agents/worker\nhuman-ask: [x]\n---\n# A\n");
  const followers = [
    { agent: "/agents/worker", follows: "tasks/a.md", only: null },
    { agent: "/agents/manager", follows: "every task", only: ["status", "human-ask"] },
    { agent: "/agents/quiet", follows: "every task", only: ["status"] },
    { agent: "/agents/elsewhere", follows: "tasks/b.md", only: null },
  ];
  const of = (agent) => receiversOf({ task, asker: { agent }, followers });
  assert.deepEqual(of("/agents/worker"), [
    { agent: "/agents/worker", why: "asked", hears: "card" },
  ]);
  // a manager that asked hears by the card; the worker that has the task hears too. Nobody else is a proxy
  assert.deepEqual(of("/agents/manager"), [
    { agent: "/agents/manager", why: "asked", hears: "card" },
    { agent: "/agents/worker", why: "has the task", hears: "card" },
  ]);
  for (const agent of ["/agents/quiet", "/agents/elsewhere", "/agents/stranger"])
    assert.deepEqual(of(agent), [
      { agent, why: "asked", hears: "message" },
      { agent: "/agents/worker", why: "has the task", hears: "card" },
    ]);
  // no asker known, or a person asked: only the task's agent, when it follows
  assert.deepEqual(receiversOf({ task, asker: { agent: null, by: "misha@x" }, followers }), [
    { agent: "/agents/worker", why: "has the task", hears: "card" },
  ]);
  // and when it does not follow, it is told by a message, so that the answer is heard
  assert.deepEqual(receiversOf({ task, asker: null }), [
    { agent: "/agents/worker", why: "has the task", hears: "message" },
  ]);
  assert.deepEqual(receiversOf({ task, asker: { agent: "/agents/stranger" }, followers: [] }), [
    { agent: "/agents/stranger", why: "asked", hears: "message" },
  ]);
  assert.deepEqual(
    receiversOf({ task: parseTask("tasks/b.md", "---\nagent: someone\n---\n"), asker: {} }),
    [],
  );
  assert.match(
    answerMessage({
      domain: "example.com",
      path: "tasks/a.md",
      ask: "x",
      answer: "y",
      by: "jo",
      why: "has the task",
    }),
    /^jo answered a question on a task that you have/,
  );
});

test("what an asker that does not follow the card is told of an answer", () => {
  const said = answerMessage({
    domain: "example.com",
    path: "tasks/a.md",
    title: "A",
    ask: "Ship it?",
    answer: " Yes,\nafter the deploy. ",
    by: "jo@example.com",
  });
  assert.match(said, /^jo@example\.com answered a question that you asked on the task board\./);
  assert.match(
    said,
    /The task: "A", https:\/\/tasks\.example\.com\/\?task=tasks%2Fa\.md \(the file tasks\/a\.md of the repo \/repos\/tasks\)/,
  );
  assert.match(said, /The question: "Ship it\?"\nThe answer: Yes, after the deploy\.\n/);
  assert.match(
    answerMessage({
      domain: "example.com",
      repo: "other",
      path: "tasks/a.md",
      ask: "x",
      answer: "",
      by: "jo",
    }),
    /\?repo=other&task=tasks%2Fa\.md .*\n.*\nThe answer: \(no words\)/,
  );
});

test("a decision's options are kept in the task's text and read back, also after the ask is answered", () => {
  const file =
    '---\nstatus: todo\nhuman-ask:\n  - "Jonas: a or b?"\n---\n# A\n\n## Log\n\n- a note\n';
  const decision = {
    ask: "Jonas: a or b?",
    options: [
      { name: "a", tradeoff: "Fast: see https://x.example/a" },
      { name: "b", tradeoff: " slow,\nand safe " },
    ],
    recommend: "b",
    why: "It is safe.",
  };
  const one = addDecision(file, decision);
  assert.equal(
    one,
    `${file}\n## Decisions\n\n- **Jonas: a or b?**\n  - Option: a: Fast: see https://x.example/a\n  - Option: b: slow, and safe\n  - Recommended: b: It is safe.\n`,
  );
  assert.deepEqual(
    [...decisionsOf(one)],
    [
      [
        "Jonas: a or b?",
        {
          options: [
            { name: "a", tradeoff: "Fast: see https://x.example/a" },
            { name: "b", tradeoff: "slow, and safe" },
          ],
          recommend: "b",
          why: "It is safe.",
        },
      ],
    ],
  );
  // a second block for the same ask, and a decision that is not whole, change nothing
  assert.equal(addDecision(one, decision), one);
  assert.equal(addDecision(file, { ...decision, recommend: "c" }), file);
  assert.equal(addDecision(file, { ...decision, options: [decision.options[0]] }), file);
  // a second ask's block goes under the same heading; an answer leaves both blocks
  const two = addDecision(one, {
    ...decision,
    ask: "Misha: c or d?",
    options: [
      { name: "c", tradeoff: "x" },
      { name: "d", tradeoff: "y" },
    ],
    recommend: "c",
  });
  assert.deepEqual([...decisionsOf(two).keys()], ["Jonas: a or b?", "Misha: c or d?"]);
  const answered = answerAsk(two, {
    ask: "Jonas: a or b?",
    answer: "b",
    by: "jonas@x",
    at: "2026-11-25T10:00:00.000Z",
  });
  assert.deepEqual([...decisionsOf(answered).keys()], ["Jonas: a or b?", "Misha: c or d?"]);
  assert.deepEqual([...decisionsOf("# No decisions\n\n- **x**\n  - Option: a: b\n")], []);
  assert.equal(decisionFault(decision), "");
  assert.match(
    decisionFault({ ...decision, options: [decision.options[0], decision.options[0]] }),
    /differ from each other/,
  );
  assert.match(decisionFault(null), /decision is \{ options/);
  // as a change of the board, with its line in the commit's message
  const change = { kind: "decision", path: "tasks/a.md", ...decision };
  assert.equal(applyChange({ "tasks/a.md": file }, change)["tasks/a.md"], one);
  assert.equal(messageOf([change]), 'tasks: tasks/a.md: the options of "Jonas: a or b?"');
});

test("what presses: the priority, then held work, then the longest wait; and it is the first order", () => {
  const card = (path, front) => parseTask(path, `---\n${front}\nhuman-ask: [x]\n---\n# ${path}\n`);
  const a = card("tasks/a.md", "status: backlog");
  const b = card("tasks/b.md", "status: in-progress");
  const c = card("tasks/c.md", "status: backlog\npriority: high");
  const d = card("tasks/d.md", "status: todo\npriority: low\nblocked-on: CI");
  const e = card("tasks/e.md", "status: todo\nblocked-on: a deploy");
  assert.deepEqual(
    [a, b, c, d, e].map((task) => [pressOf(task).rank < pressOf(a).rank, pressOf(task).held]),
    [
      [false, false],
      [false, true],
      [true, false],
      [false, true],
      [false, true],
    ],
  );
  const at = {
    "tasks/a.md": "2026-11-20T10:00:00Z",
    "tasks/b.md": "2026-11-24T10:00:00Z",
    "tasks/e.md": "2026-11-22T10:00:00Z",
  };
  // high first; then the held ones of no priority, the longer wait first; then the rest; low last
  assert.deepEqual(
    orderNeeds([a, b, c, d, e], "pressing", (task) => at[task.path]).map((task) =>
      task.path.slice(6, 7),
    ),
    ["c", "e", "b", "a", "d"],
  );
  assert.equal(NEEDS_ORDERS[0].id, "pressing");
});

test("an ask that may be outdated, whom the page asks, and with what words", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(staleOf({ asker: { agent: "/agents/a", at: "2026-11-24T12:00:00Z" }, now }), "");
  assert.equal(
    staleOf({ asker: { agent: "/agents/a", at: "2026-11-21T11:00:00Z" }, now }),
    "asked 4 days ago",
  );
  assert.equal(
    staleOf({
      asker: { agent: "/agents/coding-chief-of-staff", at: "2026-11-25T11:00:00Z" },
      now,
      retired: ["/agents/coding-chief-of-staff"],
    }),
    "the agent that asked is retired",
  );
  assert.equal(staleOf({ asker: { agent: null, at: null }, now }), "");
  const task = parseTask("tasks/a.md", "---\nagent: /agents/worker\n---\n# A\n");
  assert.equal(keeperOf({ task, asker: { agent: "/agents/asker" } }), "/agents/asker");
  assert.equal(
    keeperOf({
      task,
      asker: { agent: "/agents/coding-chief-of-staff" },
      retired: ["/agents/coding-chief-of-staff"],
    }),
    "/agents/worker",
  );
  assert.equal(keeperOf({ task: parseTask("tasks/b.md", "# B\n"), asker: {} }), null);
  const said = stillNeededMessage({
    domain: "example.com",
    path: "tasks/a.md",
    title: "A",
    ask: "Ship it?",
    by: "jo@example.com",
    why: "asked 4 days ago",
  });
  assert.match(
    said,
    /^jo@example\.com asks whether a question on the task board is still needed \(asked 4 days ago\)\./,
  );
  assert.match(said, /The question: "Ship it\?"/);
  assert.match(said, /withdraw: \{ ask: "<its beginning>", why: "…" \}/);
});
