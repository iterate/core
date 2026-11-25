// feed.test.mjs — the task change feed (feed.js): what an update of the tasks repo's main turns
// into, and how an agent follows. Run it with `node --test apps/tasks/`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardPathOf,
  FEED_TRUNCATED,
  followRowOf,
  followTasks,
  isTaskFile,
  lineDiff,
  MAX_DIFF_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MOVES,
  TASK_CHANGED,
  TASK_FEED,
  taskChangeOf,
  taskChangesEvent,
  taskFollowers,
  unfollowTasks,
} from "./feed.js";

const REPO = "/repos/tasks";
const BOARD = "/task-files/tasks";
const OTHER = "/repos/other";
const OTHER_BOARD = "/task-files/other";
const card = (status, extra = "") =>
  `---\nstatus: ${status}\ntags: [a, b]\n${extra}---\n\n# Ship it\n\nBody.\n`;
const fact = {
  commitOid: "c2",
  beforeOid: "c1",
  commitOffset: 7,
  committedAt: "2026-11-20T14:00:00.000Z",
  message: "tasks: move",
  by: "a@x",
};

test("a task file is Markdown under the folder; a feed with no folder takes the whole repo", () => {
  assert.equal(boardPathOf(TASK_FEED), BOARD);
  assert.deepEqual(
    ["tasks/a.md", "tasks/a/b.markdown", "tasksx/c.md", "tasks/img.png", "worker.ts"].map((path) =>
      isTaskFile(TASK_FEED, path),
    ),
    [true, true, false, false, false],
  );
  assert.equal(isTaskFile({ ...TASK_FEED, dir: "" }, "a.md"), true);
});

test("modified: the card before and after, one line that says what moved, and a small diff", () => {
  const change = taskChangeOf({
    feed: TASK_FEED,
    fact,
    file: "tasks/x.md",
    before: card("todo"),
    after: card(
      "in-progress",
      "blocked-on: PR #12\nhuman-ask:\n  - Sign the grant?\n  - Merge #12, or wait?\n",
    ),
  });
  assert.equal(change.change, "modified");
  assert.deepEqual(
    [
      change.repo,
      change.file,
      change.commitOid,
      change.beforeOid,
      change.commitOffset,
      change.message,
      change.by,
    ],
    [REPO, "tasks/x.md", "c2", "c1", 7, "tasks: move", "a@x"],
  );
  assert.deepEqual(change.before, {
    title: "Ship it",
    status: "todo",
    tags: ["a", "b"],
    owner: "",
    agent: "",
    blockedOn: null,
    humanAsk: null,
  });
  assert.equal(change.after.blockedOn, "PR #12");
  assert.deepEqual(change.after.humanAsk, ["Sign the grant?", "Merge #12, or wait?"]);
  assert.equal(
    change.summary,
    "tasks/x.md changed by a@x: status todo → in-progress; blocked-on none → PR #12; human-ask +2 -0 (now 2)",
  );
  assert.deepEqual(change.moved, ["status", "blocked-on", "human-ask"]);
  const given = taskChangeOf({
    feed: TASK_FEED,
    fact,
    file: "tasks/x.md",
    before: card("todo"),
    after: card("todo", "owner: jonas\nagent: /agents/w\n")
      .replace("# Ship it", "# Ship it now")
      .replace("[a, b]", "[a]"),
  });
  assert.deepEqual(given.moved, ["title", "owner", "agent", "tags"]);
  assert.ok([...change.moved, ...given.moved].every((move) => MOVES.includes(move)));
  assert.equal(
    change.diff,
    "@@ -1,5 +1,9 @@\n ---\n-status: todo\n+status: in-progress\n tags: [a, b]\n+blocked-on: PR #12\n+human-ask:\n+  - Sign the grant?\n+  - Merge #12, or wait?\n ---\n ",
  );
  assert.equal(change.diffOmitted, undefined);
});

test("added and deleted; a change of the text alone says so", () => {
  const added = taskChangeOf({
    feed: TASK_FEED,
    fact,
    file: "tasks/x.md",
    before: null,
    after: "# New\n",
  });
  assert.deepEqual([added.change, added.before, added.after.title], ["added", null, "New"]);
  assert.equal(added.summary, 'tasks/x.md added by a@x: "New", status none');
  assert.equal(added.diff, "@@ -0,0 +1,1 @@\n+# New");
  const deleted = taskChangeOf({
    feed: TASK_FEED,
    fact: { ...fact, by: null },
    file: "tasks/x.md",
    before: "# Old\n",
    after: null,
  });
  assert.deepEqual(
    [deleted.change, deleted.after, deleted.summary],
    ["deleted", null, 'tasks/x.md deleted: "Old"'],
  );
  assert.equal(deleted.diff, "@@ -1,1 +0,0 @@\n-# Old");
  const body = taskChangeOf({
    feed: TASK_FEED,
    fact,
    file: "tasks/x.md",
    before: card("todo"),
    after: card("todo").replace("Body.", "Body, and more."),
  });
  assert.equal(body.summary, "tasks/x.md changed by a@x: its text");
  // what moved, by name: a file that came or went, and "text" for a change that moved no field
  assert.deepEqual([added.moved, deleted.moved, body.moved], [["added"], ["deleted"], ["text"]]);
});

test("an ask that left with an answer is told with its answer; one that only left is counted", () => {
  const asks = card(
    "todo",
    "human-ask:\n  - Merge #12 now, or wait?\n  - Sign the grant?\n  - A third one?\n",
  );
  // the first is answered by the committer, the second by another person (an agent wrote it down), the third is withdrawn
  const after = `${card("todo")}\n## Answers\n\n- **Merge #12 now, or wait?** Wait for the deploy. (a@x, 2026-11-20 14:50 UTC)\n- **Sign the grant?** Signed. (misha@nustom.com, 2026-11-20 14:51 UTC)\n`;
  const told = taskChangeOf({ feed: TASK_FEED, fact, file: "tasks/x.md", before: asks, after });
  assert.equal(
    told.summary,
    'tasks/x.md changed by a@x: answered "Merge #12 now, or wait?": Wait for the deploy.; answered "Sign the grant?": Signed. (misha@nustom.com); human-ask +0 -1 (now 0)',
  );
  // an answer moves the asks: a follower of asks alone hears of it
  assert.deepEqual(told.moved, ["human-ask"]);
  // a long ask and a long answer are cut, and the whole line stays under its bound
  const long = taskChangeOf({
    feed: TASK_FEED,
    fact,
    file: "tasks/x.md",
    before: card("todo", `human-ask:\n  - ${"q".repeat(200)}?\n`),
    after: `${card("todo")}\n## Answers\n\n- **${"q".repeat(200)}?** ${"y".repeat(900)} (a@x, 2026-11-20 14:50 UTC)\n`,
  });
  assert.equal(
    long.summary,
    `tasks/x.md changed by a@x: answered "${"q".repeat(69)}…": ${"y".repeat(159)}…`,
  );
});

test("a diff keeps the lines between two changes out, and shows a missing line end", () => {
  const lines = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`);
  const after = lines.map((line, at) => (at === 1 ? "LINE 2" : at === 10 ? "LINE 11" : line));
  assert.equal(
    lineDiff(`${lines.join("\n")}\n`, `${after.join("\n")}\n`),
    "@@ -1,4 +1,4 @@\n line 1\n-line 2\n+LINE 2\n line 3\n line 4\n@@ -9,4 +9,4 @@\n line 9\n line 10\n-line 11\n+LINE 11\n line 12",
  );
  assert.equal(lineDiff("same", "same"), "");
  assert.equal(lineDiff("a\n", "a"), "@@ -1,2 +1,1 @@\n a\n-");
  // two changes that touch are one stretch
  assert.equal(lineDiff("a\nb\nc\nd\n", "A\nb\nc\nD\n"), "@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n-d\n+D");
});

test("a big diff and a big file are left out with a flag; the card is still told", () => {
  const big = taskChangeOf({
    feed: TASK_FEED,
    fact,
    file: "tasks/x.md",
    before: "a\n",
    after: `${"y".repeat(MAX_DIFF_BYTES)}\n`,
  });
  assert.deepEqual([big.diff, big.diffOmitted], [null, "diff-too-large"]);
  const huge = taskChangeOf({
    feed: TASK_FEED,
    fact,
    file: "tasks/x.md",
    before: card("todo"),
    after: card("done") + "z".repeat(MAX_FILE_BYTES),
  });
  assert.deepEqual(
    [huge.diff, huge.diffOmitted, huge.after.status],
    [null, "file-too-large", "done"],
  );
});

// A fake mind: the repo's own log of facts, a commit's files, logs that refuse a second key with
// other content, and rows as the platform lists them.
function fakeMind({ facts, files, agents = [], otherFacts = [] }) {
  const logs = new Map([
    [REPO, facts],
    [OTHER, otherFacts],
  ]);
  const keys = new Map();
  const reads = [];
  const eventsOf = (path) => logs.get(path) ?? logs.set(path, []).get(path);
  const itx = {
    repos: {
      list: async () => [{ path: REPO }, { path: OTHER }],
      get: () => ({
        modules: async ({ commitOid, dir }) => {
          reads.push(commitOid);
          if (!files[commitOid]) throw new Error(`no commit ${commitOid}`);
          return Object.fromEntries(
            Object.entries(files[commitOid])
              .filter(([path]) => path.startsWith(`${dir}/`))
              .map(([path, text]) => [path.slice(dir.length + 1), text]),
          );
        },
        readFile: async (path) => Object.values(files).at(-1)[path] ?? null,
      }),
    },
    cd: (path) => ({
      readEvents: async (after, limit) => {
        const events = eventsOf(path)
          .filter((event) => event.offset > after)
          .slice(0, limit);
        return {
          events,
          scannedThroughOffset: events.at(-1)?.offset ?? eventsOf(path).at(-1)?.offset ?? 0,
        };
      },
      append: async (event) => {
        const seen = keys.get(`${path} ${event.idempotencyKey}`);
        if (event.idempotencyKey && seen) {
          if (JSON.stringify(seen) === JSON.stringify(event.payload)) return;
          throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { code: "IDEMPOTENCY_CONFLICT" });
        }
        if (event.idempotencyKey) keys.set(`${path} ${event.idempotencyKey}`, event.payload);
        eventsOf(path).push({ ...event, path, offset: (eventsOf(path).at(-1)?.offset ?? 0) + 1 });
      },
      subscriptions: {
        // the rows as the platform folds them: the last event of a name, none after `target: null`
        list: async () => {
          const rows = new Map();
          for (const event of eventsOf(path).filter((each) =>
            each.type.endsWith("/itx/subscription-configured"),
          )) {
            if (event.payload.target === null) rows.delete(event.payload.name);
            else
              rows.set(event.payload.name, {
                name: event.payload.name,
                filter: event.payload.filter,
                copy: event.payload.target,
              });
          }
          return [...rows.values()];
        },
      },
    }),
  };
  const deps = { callerPath: () => "/", isAgent: async (path) => agents.includes(path) };
  return {
    itx,
    deps,
    reads,
    told: (log = BOARD) => eventsOf(log).filter((event) => !event.type.includes("/itx/")),
    rows: (log = BOARD) => itx.cd(log).subscriptions.list(),
  };
}
const commitFact = (offset, commitOid, changedPaths, repo = REPO) => ({
  type: "events.iterate.com/repo/commit-completed",
  path: repo,
  offset,
  createdAt: `2026-11-20T14:00:0${offset}.000Z`,
  source: { onBehalfOf: { principal: { actor: "user_1", email: "a@x" } } },
  payload: { path: repo, commitOid, message: `${commitOid}\n\nmore`, changedPaths },
});
/** Three updates of main, with other events of the repo's log between them. */
function history() {
  const facts = [
    commitFact(2, "c1", ["tasks/a.md"]),
    { type: "events.iterate.com/repo/pushed", path: REPO, offset: 3, payload: {} },
    commitFact(5, "c2", ["tasks/a.md", "worker.ts"]),
    { type: "events.iterate.com/itx/woken", path: REPO, offset: 6, payload: {} },
    commitFact(9, "c3", ["tasks/b.md"]),
  ];
  const files = {
    c1: { "tasks/a.md": "a1\n", "worker.ts": "w1" },
    c2: { "tasks/a.md": "a2\n", "worker.ts": "w2" },
    c3: { "tasks/a.md": "a2\n", "tasks/b.md": "# B\n", "worker.ts": "w2" },
  };
  return { facts, files };
}

test("before is the commit of the fact before on the repo's log, whatever order the facts arrive in", async () => {
  const { facts, files } = history();
  const mind = fakeMind({ facts, files });
  // the newest first, then the one before it, as an unordered delivery may hand them over
  await taskChangesEvent(mind.itx, facts[4]);
  await taskChangesEvent(mind.itx, facts[2]);
  const [b, a] = mind.told();
  assert.deepEqual(
    [
      b.type,
      b.payload.file,
      b.payload.change,
      b.payload.beforeOid,
      b.payload.commitOid,
      b.payload.commitOffset,
    ],
    [TASK_CHANGED, "tasks/b.md", "added", "c2", "c3", 9],
  );
  assert.deepEqual(
    [
      a.payload.file,
      a.payload.change,
      a.payload.beforeOid,
      a.payload.commitOid,
      a.payload.commitOffset,
    ],
    ["tasks/a.md", "modified", "c1", "c2", 5],
  );
  assert.equal(a.payload.diff, "@@ -1,1 +1,1 @@\n-a1\n+a2");
  assert.deepEqual(
    [a.payload.by, a.payload.message, a.payload.committedAt],
    ["a@x", "c2", "2026-11-20T14:00:05.000Z"],
  );
  assert.equal(a.idempotencyKey, "tasks/task-changed:/repos/tasks@5:tasks/a.md");
  // the repo's first fact has no commit before it: its files are added. A commit that no person
  // asked for is by the context whose event caused it
  await taskChangesEvent(mind.itx, {
    ...facts[0],
    source: { origin: REPO, cause: { parent: "/agents/meet/a-call@2161" } },
  });
  const first = mind.told()[2].payload;
  assert.deepEqual(
    [first.change, first.beforeOid, first.by, first.via],
    ["added", null, "/agents/meet/a-call", null],
  );
  assert.equal(first.summary, 'tasks/a.md added by /agents/meet/a-call: "A", status none');
});

test("a commit that an agent's session made through a person's sign-in says so: its Via line", async () => {
  const { facts, files } = history();
  const mind = fakeMind({ facts, files });
  // the platform stamps the person; the commit's message names the session
  const message =
    "tasks: a moves\n\nWhy it moved.\n\nVia: Claude Code (tasks pilot, session b7fb218f on beelink)\nIterate-Run: /@187197";
  await taskChangesEvent(mind.itx, { ...facts[2], payload: { ...facts[2].payload, message } });
  const [told] = mind.told();
  assert.deepEqual(
    [told.payload.by, told.payload.via, told.payload.message],
    ["a@x", "Claude Code (tasks pilot, session b7fb218f on beelink)", "tasks: a moves"],
  );
  assert.equal(
    told.payload.summary,
    "tasks/a.md changed by a@x via Claude Code (tasks pilot, session b7fb218f on beelink): its text",
  );
  // a script through a person's sign-in has no page; the person's own act on the board has one
  assert.equal(told.payload.page, null);
  const onBoard = {
    onBehalfOf: {
      principal: { actor: "user_1", email: "a@x" },
      via: { appPage: "tasks.iterate.com" },
      call: "/repos/tasks#repo.commitFiles",
    },
  };
  await taskChangesEvent(mind.itx, { ...facts[4], source: onBoard });
  const own = mind.told()[1].payload;
  assert.deepEqual([own.by, own.page, own.via], ["a@x", "tasks.iterate.com", null]);
  assert.equal(own.summary, 'tasks/b.md added by a@x on tasks.iterate.com: "B", status none');
});

test("a fact that is delivered twice adds nothing, and the root's copy is not this feed's", async () => {
  const { facts, files } = history();
  const mind = fakeMind({ facts, files });
  await taskChangesEvent(mind.itx, facts[2]);
  await taskChangesEvent(mind.itx, facts[2]);
  await taskChangesEvent(mind.itx, { ...facts[2], path: "/" });
  await taskChangesEvent(mind.itx, { ...facts[2], payload: { ...facts[2].payload, path: OTHER } });
  await taskChangesEvent(mind.itx, { ...facts[2], path: "/repos/a/nested" });
  assert.equal(mind.told().length, 1);
});

test("every repo of the mind has a feed: a commit to another repo is told on that repo's log", async () => {
  const { facts, files } = history();
  const otherFacts = [
    commitFact(3, "o1", ["README.md"], OTHER),
    commitFact(4, "o2", ["tasks/z.md"], OTHER),
  ];
  const mind = fakeMind({
    facts,
    files: {
      ...files,
      o1: { "README.md": "# Other\n" },
      o2: { "README.md": "# Other\n", "tasks/z.md": "# Z\n" },
    },
    otherFacts,
  });
  await taskChangesEvent(mind.itx, otherFacts[0]);
  await taskChangesEvent(mind.itx, otherFacts[1]);
  assert.equal(mind.told().length, 0);
  const [z] = mind.told("/task-files/other");
  assert.deepEqual(
    [z.payload.repo, z.payload.file, z.payload.change, z.payload.beforeOid],
    [OTHER, "tasks/z.md", "added", "o1"],
  );
  assert.equal(z.idempotencyKey, "tasks/task-changed:/repos/other@4:tasks/z.md");
});

test("a commit that names no task file reads nothing; one that names no file at all is compared", async () => {
  const { facts, files } = history();
  const mind = fakeMind({ facts, files });
  await taskChangesEvent(mind.itx, commitFact(5, "c2", ["worker.ts"]));
  assert.deepEqual([mind.reads.length, mind.told().length], [0, 0]);
  // a `git push` to the repo: the fact names no file, and the folders say what changed
  await taskChangesEvent(mind.itx, commitFact(9, "c3", []));
  assert.deepEqual(
    mind.told().map((event) => event.payload.file),
    ["tasks/b.md"],
  );
  // the same tip announced again changes nothing, and so does a commit that left the folder as it was
  const again = fakeMind({ facts: [...facts, commitFact(12, "c3", [])], files });
  await taskChangesEvent(again.itx, commitFact(12, "c3", []));
  assert.deepEqual([again.reads.length, again.told().length], [0, 0]);
});

test("past the cap, one summary names the rest", async () => {
  const many = Array.from(
    { length: MAX_FILES + 2 },
    (_, at) => `tasks/t${String(at).padStart(2, "0")}.md`,
  );
  const facts = [commitFact(2, "c1", ["x"]), commitFact(4, "c2", many)];
  const mind = fakeMind({
    facts,
    files: { c1: {}, c2: Object.fromEntries(many.map((path) => [path, "# T\n"])) },
  });
  await taskChangesEvent(mind.itx, facts[1]);
  const told = mind.told();
  assert.deepEqual(
    told.filter((event) => event.type === TASK_CHANGED).map((event) => event.payload.file),
    many.slice(0, MAX_FILES),
  );
  const [summary] = told.filter((event) => event.type === FEED_TRUNCATED);
  assert.deepEqual(
    [summary.payload.total, summary.payload.sent, summary.payload.skipped],
    [MAX_FILES + 2, MAX_FILES, many.slice(MAX_FILES)],
  );
  assert.equal(told.at(-1), summary);
});

test("a read that fails once is tried again; one that keeps failing is thrown, and tells nothing twice", async () => {
  const { facts, files } = history();
  const mind = fakeMind({ facts, files });
  const { get } = mind.itx.repos;
  let failures = 1;
  mind.itx.repos.get = () => ({
    ...get(),
    modules: async (options) =>
      failures-- > 0 ? Promise.reject(new Error("overloaded")) : get().modules(options),
  });
  await taskChangesEvent(mind.itx, facts[2]);
  assert.equal(mind.told().length, 1);
  failures = 9;
  await assert.rejects(taskChangesEvent(mind.itx, facts[4]), /overloaded/);
  assert.equal(mind.told().length, 1);
});

test("a follower is one row on the log: a filter for one file, and a message to the agent", async () => {
  const { facts, files } = history();
  const mind = fakeMind({ facts, files, agents: ["/agents/em", "/agents/worker"] });
  const one = await followTasks(
    mind.itx,
    { agent: "/agents/worker", file: "tasks/a.md" },
    mind.deps,
  );
  assert.deepEqual([one.agent, one.follows, one.log], ["/agents/worker", "tasks/a.md", BOARD]);
  // an agent's own script names nobody: the platform says where the call came from
  const all = await followTasks(mind.itx, undefined, {
    ...mind.deps,
    callerPath: () => "/agents/em",
  });
  assert.deepEqual([all.agent, all.follows], ["/agents/em", "every task"]);
  const [worker, em] = await mind.rows();
  // the row takes the file's changes, but not a commit that the follower made itself: one that
  // its own turn caused (`by`), or one whose message names it (`via`)
  assert.deepEqual(
    [worker.name, worker.filter, worker.copy.path, worker.copy.type],
    [
      one.row,
      'payload.file = "tasks/a.md" and payload.by != "/agents/worker" and payload.via != "/agents/worker"',
      "/agents/worker",
      "events.iterate.com/agent/message-received",
    ],
  );
  assert.equal(
    worker.copy.payload,
    '{ "message": "A task changed: " & payload.summary & (payload.diff ? "\\n\\n" & payload.diff : " (no diff here: " & payload.diffOmitted & "; read the file)")' +
      ' & "\\n\\nYou follow tasks/a.md of /repos/tasks. To stop: await itx.config.unfollowTasks({\\"agent\\":\\"/agents/worker\\",\\"file\\":\\"tasks/a.md\\",\\"repo\\":\\"tasks\\"})" }',
  );
  assert.equal(em.filter, 'payload.by != "/agents/em" and payload.via != "/agents/em"');
  // a row that an earlier version wrote, with the file alone in its filter, is read as well
  await mind.itx.cd(OTHER_BOARD).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "task-follow-old",
      filter: 'payload.file = "tasks/od\\"d.md"',
      target: { path: "/agents/old" },
    },
  });
  assert.deepEqual(await taskFollowers(mind.itx, { repo: "other" }), [
    {
      agent: "/agents/old",
      follows: 'tasks/od"d.md',
      only: null,
      repo: OTHER,
      row: "task-follow-old",
    },
  ]);
  await mind.itx.cd(OTHER_BOARD).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "task-follow-old", target: null },
  });
  assert.deepEqual(await taskFollowers(mind.itx), [
    { agent: "/agents/worker", follows: "tasks/a.md", only: null, repo: REPO, row: one.row },
    { agent: "/agents/em", follows: "every task", only: null, repo: REPO, row: all.row },
  ]);
  // some changes and no other: the same row, with the moves in its filter, and the words say so
  const some = await followTasks(
    mind.itx,
    { agent: "/agents/em", only: ["status", "blocked-on", "human-ask", "status"] },
    mind.deps,
  );
  assert.deepEqual([some.row, some.only], [all.row, ["status", "blocked-on", "human-ask"]]);
  const [, narrowed] = await mind.rows();
  assert.equal(
    narrowed.filter,
    'payload.by != "/agents/em" and payload.via != "/agents/em" and ("status" in payload.moved or "blocked-on" in payload.moved or "human-ask" in payload.moved)',
  );
  assert.match(
    narrowed.copy.payload,
    /You follow every task \(only a change of: status, blocked-on, human-ask\) of \/repos\/tasks\./,
  );
  assert.deepEqual((await taskFollowers(mind.itx))[1], {
    agent: "/agents/em",
    follows: "every task",
    only: ["status", "blocked-on", "human-ask"],
    repo: REPO,
    row: all.row,
  });
  // and following with no `only` is every change again
  await followTasks(mind.itx, { agent: "/agents/em" }, mind.deps);
  assert.equal((await taskFollowers(mind.itx))[1].only, null);
  // a task of another repo: its row is on that repo's log, and the call that ends it names the repo
  const far = await followTasks(
    mind.itx,
    { agent: "/agents/em", file: "tasks/a.md", repo: "other" },
    mind.deps,
  );
  assert.deepEqual([far.repo, far.log], [OTHER, "/task-files/other"]);
  const [there] = await mind.rows("/task-files/other");
  assert.match(
    there.copy.payload,
    /You follow tasks\/a\.md of \/repos\/other\. To stop: await itx\.config\.unfollowTasks\(\{\\"agent\\":\\"\/agents\/em\\",\\"file\\":\\"tasks\/a\.md\\",\\"repo\\":\\"other\\"\}\)/,
  );
  assert.deepEqual(await taskFollowers(mind.itx, { repo: OTHER }), [
    { agent: "/agents/em", follows: "tasks/a.md", only: null, repo: OTHER, row: far.row },
  ]);
  assert.equal(
    (
      await unfollowTasks(
        mind.itx,
        { agent: "/agents/em", file: "tasks/a.md", repo: "other" },
        mind.deps,
      )
    ).ended,
    true,
  );
  assert.equal((await mind.rows()).length, 2);
  // following again is the same row; unfollowing ends it, once
  assert.equal(
    (await followTasks(mind.itx, { agent: "/agents/worker", file: "tasks/a.md" }, mind.deps)).row,
    one.row,
  );
  assert.equal((await mind.rows()).length, 2);
  assert.equal(
    (await unfollowTasks(mind.itx, { agent: "/agents/worker", file: "tasks/a.md" }, mind.deps))
      .ended,
    true,
  );
  assert.equal(
    (await unfollowTasks(mind.itx, { agent: "/agents/worker", file: "tasks/a.md" }, mind.deps))
      .ended,
    false,
  );
  assert.deepEqual(
    (await taskFollowers(mind.itx)).map((row) => row.agent),
    ["/agents/em"],
  );
  assert.match(
    followRowOf(TASK_FEED, { agent: "/agents/em", wake: false }).target.payload,
    /, "trigger": false \}$/,
  );
});

test("a follow that would reach nothing is refused, in words", async () => {
  const { facts, files } = history();
  const long = `/agents/${"x".repeat(900)}`;
  const mind = fakeMind({ facts, files, agents: ["/agents/em", long] });
  await assert.rejects(
    followTasks(mind.itx, { file: "tasks/a.md" }, mind.deps),
    /came from no agent's context: name the agent/,
  );
  await assert.rejects(
    followTasks(mind.itx, { agent: "/agents/typo", file: "tasks/a.md" }, mind.deps),
    /\/agents\/typo is no agent/,
  );
  await assert.rejects(
    followTasks(mind.itx, { agent: "/agents/em", file: "worker.ts" }, mind.deps),
    /file is a task's path in \/repos\/tasks, like "tasks\/a-task\.md"/,
  );
  await assert.rejects(
    followTasks(mind.itx, { agent: "/agents/em", file: "tasks/none.md" }, mind.deps),
    /\/repos\/tasks has no tasks\/none\.md/,
  );
  await assert.rejects(
    followTasks(mind.itx, { agent: long, file: "tasks/a.md" }, mind.deps),
    /too long together/,
  );
  await assert.rejects(
    followTasks(mind.itx, "tasks/a.md", mind.deps),
    /takes \{ file\?, agent\?, repo\? \}/,
  );
  await assert.rejects(
    followTasks(mind.itx, { agent: "/agents/em", repo: "none" }, mind.deps),
    /the mind has no repo \/repos\/none/,
  );
  await assert.rejects(
    followTasks(mind.itx, { agent: "/agents/em", repo: "/agents/em" }, mind.deps),
    /repo is a repo's name or its path/,
  );
  await assert.rejects(
    followTasks(mind.itx, { agent: "/agents/em", only: ["status", "mood"] }, mind.deps),
    /only is a list of what a change moved, from: added, deleted, status/,
  );
  await assert.rejects(
    followTasks(mind.itx, { agent: "/agents/em", only: [] }, mind.deps),
    /only is a list of what a change moved/,
  );
  assert.equal((await mind.rows()).length, 0);
});
