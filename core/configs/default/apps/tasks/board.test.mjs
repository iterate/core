// board.test.mjs — the board as data for an agent (board.js). Run it with `node --test apps/tasks/`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { taskBoard } from "./board.js";

const changed = (offset, file, change, summary, by = "a@x") => ({
  type: "events.iterate.com/tasks/task-changed",
  offset,
  payload: { file, change, summary, by, committedAt: `2026-11-20T14:0${offset}:00.000Z` },
});
const follower = {
  name: "task-follow-1",
  filter: 'payload.file = "tasks/a.md"',
  copy: { path: "/agents/em" },
};

// A fake mind: repos with a tasks folder at a tip, the feeds' logs, their rows, and the catalog.
function fakeMind({
  logs = {
    "/task-files/tasks": [
      changed(1, "tasks/a.md", "added", "a added"),
      changed(2, "tasks/b.md", "added", "b added"),
      { type: "events.iterate.com/itx/woken", offset: 3, payload: {} },
      changed(4, "tasks/a.md", "modified", "a: status todo → in-progress", "/agents/worker"),
    ],
  },
  rows = [follower, { name: "config" }],
} = {}) {
  const repos = {
    "/repos/tasks": {
      tip: "t1",
      files: {
        "a.md": `---\nstatus: in-progress\nowner: jonas\nagent: /agents/worker\nhuman-ask:\n  - Sign the grant?\n---\n# A\n\n## Answers\n\n- **Merge #12 now, or wait?** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n- **A long one?** ${"y".repeat(600)} (a@x, 2026-11-20 14:55 UTC)\n`,
        "b.md": "---\nstatus: todo\nblocked-on: PR #12\n---\n# B\n",
        "c.md": "---\nstatus: done\nhuman-ask: [late]\n---\n# C\n",
        "notes.txt": "no task",
      },
    },
    "/repos/other": { tip: "o1", files: { "z.md": "# Z\n" } },
    "/repos/unborn": { tip: null, files: {} },
  };
  const read = [];
  const itx = {
    url: async () => "https://iterate.com/",
    repos: {
      list: async () => Object.keys(repos).map((path) => ({ path })),
      get: (path) => ({ tip: async () => repos[path].tip, modules: async () => repos[path].files }),
    },
    // the catalog: the feeds' logs, and the agents it has a row for (a long idle one has none)
    contexts: {
      list: async ({ under }) =>
        under === "/agents"
          ? [
              { path: "/agents/worker", awake: true, lastActivityAt: "2026-11-20T14:03:30.000Z" },
              { path: "/agents/em", awake: false },
            ]
          : Object.keys(logs).map((path) => ({ path })),
    },
    cd: (path) => {
      read.push(path);
      const events = logs[path] ?? [];
      return {
        readEvents: async (after, limit) => ({
          events: events.filter((event) => event.offset > after).slice(0, limit),
          scannedThroughOffset: events.at(-1)?.offset ?? 0,
        }),
        subscriptions: { list: async () => (path === "/task-files/tasks" ? rows : []) },
      };
    },
  };
  return { itx, read };
}

test("the board as data: every card, what needs a person, the newest changes and who follows", async () => {
  const { itx } = fakeMind();
  const board = await taskBoard(itx);
  assert.deepEqual(
    [board.repo, board.commitOid, board.board],
    ["/repos/tasks", "t1", "https://tasks.iterate.com/?repo=tasks"],
  );
  // the answers that people gave are with the card: the decisions made, a long one cut
  const answers = [
    {
      ask: "Merge #12 now, or wait?",
      answer: "Wait for the deploy.",
      by: "misha@nustom.com",
      at: "2026-11-20 14:50",
    },
    { ask: "A long one?", answer: `${"y".repeat(499)}…`, by: "a@x", at: "2026-11-20 14:55" },
  ];
  assert.deepEqual(board.tasks, [
    {
      file: "tasks/a.md",
      title: "A",
      status: "in-progress",
      column: "in-progress",
      tags: [],
      priority: "",
      size: "",
      owner: "jonas",
      agent: "/agents/worker",
      agentSeen: { awake: true, lastActivityAt: "2026-11-20T14:03:30.000Z" },
      agentFollows: false,
      blockedOn: null,
      humanAsk: ["Sign the grant?"],
      answers,
      lastChange: {
        at: "2026-11-20T14:04:00.000Z",
        by: "/agents/worker",
        summary: "a: status todo → in-progress",
      },
    },
    {
      file: "tasks/b.md",
      title: "B",
      status: "todo",
      column: "todo",
      tags: [],
      priority: "",
      size: "",
      owner: "",
      agent: "",
      agentSeen: null,
      agentFollows: null,
      blockedOn: "PR #12",
      humanAsk: [],
      answers: [],
      lastChange: { at: "2026-11-20T14:02:00.000Z", by: "a@x", summary: "b added" },
    },
    {
      file: "tasks/c.md",
      title: "C",
      status: "done",
      column: "done",
      tags: [],
      priority: "",
      size: "",
      owner: "",
      agent: "",
      agentSeen: null,
      agentFollows: null,
      blockedOn: null,
      humanAsk: ["late"],
      answers: [],
      lastChange: null,
    },
  ]);
  // a done task needs nobody, and neither does one that is held and asks nothing
  assert.deepEqual(board.needsAPerson, ["tasks/a.md"]);
  assert.deepEqual(
    board.recentChanges.map((change) => [change.file, change.change]),
    [
      ["tasks/a.md", "modified"],
      ["tasks/b.md", "added"],
      ["tasks/a.md", "added"],
    ],
  );
  assert.deepEqual(board.followers, [{ agent: "/agents/em", follows: "tasks/a.md", only: null }]);
});

test("a card says whether its agent follows it: one that does not was not taken", async () => {
  // tasks/a.md names /agents/worker. Another agent's follow of the card is not the worker's
  assert.equal((await taskBoard(fakeMind().itx)).tasks[0].agentFollows, false);
  // the worker follows its card, as an agent that is given one does first
  const own = {
    name: "task-follow-2",
    filter:
      'payload.file = "tasks/a.md" and payload.by != "/agents/worker" and payload.via != "/agents/worker"',
    copy: { path: "/agents/worker" },
  };
  assert.equal(
    (await taskBoard(fakeMind({ rows: [follower, own] }).itx)).tasks[0].agentFollows,
    true,
  );
  // or it follows every card
  const all = {
    name: "task-follow-3",
    filter: 'payload.by != "/agents/worker" and payload.via != "/agents/worker"',
    copy: { path: "/agents/worker" },
  };
  const board = await taskBoard(fakeMind({ rows: [all] }).itx);
  assert.deepEqual(
    board.tasks.map((task) => task.agentFollows),
    [true, null, null],
  );
});

test("another repo by its name; a repo with no feed log yet is not read into being", async () => {
  const { itx, read } = fakeMind();
  const other = await taskBoard(itx, { repo: "other" });
  assert.deepEqual(
    [other.repo, other.board, other.tasks.map((task) => task.title)],
    ["/repos/other", "https://tasks.iterate.com/?repo=other", ["Z"]],
  );
  assert.deepEqual(
    [other.recentChanges, other.followers, other.tasks[0].lastChange],
    [[], [], null],
  );
  assert.deepEqual(read, []);
  const unborn = await taskBoard(itx, { repo: "/repos/unborn" });
  assert.deepEqual([unborn.commitOid, unborn.tasks, unborn.needsAPerson], [null, [], []]);
});

test("a board of nothing is refused, in words", async () => {
  const { itx } = fakeMind();
  await assert.rejects(taskBoard(itx, { repo: "none" }), /the mind has no repo \/repos\/none/);
  await assert.rejects(taskBoard(itx, "tasks"), /takes \{ repo\? \}/);
});
