// cards.test.mjs — an agent's three calls that keep a card (cards.js). Run it with
// `node --test apps/tasks/`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefOf, taskAssign, taskOpen, taskUpdate } from "./cards.js";
import { parseTask } from "./public/tasks-model.js";

const NOW = new Date("2026-11-20T16:05:31.000Z");
const CARD =
  "---\nstatus: todo\nowner: misha@nustom.com\n---\n\n# Fix the bar\n\nIn Misha's words: the bar overlaps.\n";
const EM = "/agents/engineering-manager";
const SYSADMIN = "/agents/sysadmin";

// A fake mind: repos that hold files at a tip, agents that take messages, and logs that keep what
// is appended. `own`: what a mind adds of its own to the calls (cards.js, `deps`).
function fakeMind({
  files = { "tasks/fix-the-bar.md": CARD },
  agents = [EM, "/agents/claude/owner-1"],
  caller,
  machine = {},
  rows,
  own = {},
} = {}) {
  const repos = {
    "/repos/tasks": { tip: "t1", files: { ...files } },
    "/repos/other": { tip: "o1", files: {} },
  };
  const commits = [];
  const messages = [];
  const appended = [];
  const itx = {
    url: async () => "https://iterate.com/",
    repos: {
      list: async () => Object.keys(repos).map((path) => ({ path })),
      get: (path) => ({
        tip: async () => repos[path].tip,
        readFile: async (file) => repos[path].files[file] ?? null,
        modules: async ({ dir }) =>
          Object.fromEntries(
            Object.entries(repos[path].files)
              .filter(([file]) => file.startsWith(`${dir}/`))
              .map(([file, text]) => [file.slice(dir.length + 1), text]),
          ),
        commitFiles: async ({ message, changes, parent }) => {
          if (parent !== repos[path].tip)
            throw new Error(`repo ${path}: the commit was refused: main is at ${repos[path].tip}`);
          for (const change of changes) repos[path].files[change.path] = change.content;
          repos[path].tip = `${parent}+`;
          commits.push({
            repo: path,
            message,
            parent,
            paths: changes.map((change) => change.path),
          });
          return { commitOid: repos[path].tip };
        },
      }),
    },
    agents: {
      get: (path) => ({
        message: async (text) => {
          if (machine.deaf === path) throw new Error("no such agent");
          messages.push({ to: path, text });
          return { offset: messages.length };
        },
      }),
    },
    cd: (path) => ({
      append: async (...events) =>
        void appended.push(...events.map((event) => ({ path, ...event }))),
    }),
  };
  const deps = {
    callerPath: () => {
      if (!caller) throw new Error("no caller");
      return caller;
    },
    isAgent: async (path) => agents.includes(path) || Boolean(rows && Object.hasOwn(rows, path)),
    // the catalog's row of an agent, when the test gives rows: a mind's api.ts always does
    ...(rows && { agentRow: async (path) => rows[path] ?? null }),
    ...own,
  };
  return {
    itx,
    deps,
    repos,
    commits,
    messages,
    appended,
    file: (path, repo = "/repos/tasks") => repos[repo].files[path],
  };
}

test("a new card holds the ask in the person's words, who asked, and its asks; its file is named by the title", async () => {
  const mind = fakeMind({ caller: EM });
  const made = await taskOpen(
    mind.itx,
    {
      title: "  The answer box:\n Cmd-Enter ",
      text: 'Misha, 20 Nov 2026, in the pilot\'s card: "i tried to use cmd-enter".\n',
      owner: "misha@nustom.com",
      tags: ["tasks-app"],
      ask: ["Ctrl-Enter too?"],
      noChoice: "Only Misha knows which key his hand goes to.",
    },
    mind.deps,
  );
  assert.deepEqual(made, {
    repo: "/repos/tasks",
    file: "tasks/the-answer-box-cmd-enter.md",
    commitOid: "t1+",
    link: "https://tasks.iterate.com/?repo=tasks&task=tasks%2Fthe-answer-box-cmd-enter.md",
    warning: undefined,
  });
  assert.equal(
    mind.file(made.file),
    '---\nstatus: todo\ntags: [tasks-app]\nowner: "misha@nustom.com"\nhuman-ask:\n  - Ctrl-Enter too?\n---\n\n# The answer box: Cmd-Enter\n\nMisha, 20 Nov 2026, in the pilot\'s card: "i tried to use cmd-enter".\n',
  );
  assert.deepEqual(mind.commits, [
    {
      repo: "/repos/tasks",
      message: `tasks: new tasks/the-answer-box-cmd-enter.md\n\nVia: ${EM}`,
      parent: "t1",
      paths: [made.file],
    },
  ]);
  // the same title again is a second file; a card of another repo; a member's script names no agent
  const again = await taskOpen(mind.itx, { title: "The answer box: Cmd-Enter" }, mind.deps);
  assert.equal(again.file, "tasks/the-answer-box-cmd-enter-2.md");
  assert.equal(mind.file(again.file), "---\nstatus: todo\n---\n\n# The answer box: Cmd-Enter\n");
  const member = fakeMind();
  const far = await taskOpen(
    member.itx,
    { title: "A", status: "backlog", repo: "other" },
    member.deps,
  );
  assert.deepEqual(
    [far.repo, far.link],
    ["/repos/other", "https://tasks.iterate.com/?repo=other&task=tasks%2Fa.md"],
  );
  assert.equal(member.commits[0].message, "tasks: new tasks/a.md");
  await assert.rejects(
    taskOpen(mind.itx, { title: " " }, mind.deps),
    /title is a text, and it is not empty/,
  );
  await assert.rejects(taskOpen(mind.itx, "A", mind.deps), /taskOpen takes \{ title, text\?/);
  await assert.rejects(
    taskOpen(mind.itx, { title: "A", repo: "none" }, mind.deps),
    /the mind has no repo \/repos\/none/,
  );
});

test("an update is one commit of what the call names, and says whose it is", async () => {
  const mind = fakeMind();
  const worker = "/agents/claude/fix-bar-abc123";
  const done = await taskUpdate(
    mind.itx,
    {
      file: "tasks/fix-the-bar.md",
      by: worker,
      status: "in-progress",
      blockedOn: "PR #12 review",
      ask: "Ship it on a Friday?",
      noChoice: "A test of one commit.",
      note: "Found the cause:\n the label has no width.",
    },
    mind.deps,
    NOW,
  );
  assert.deepEqual(
    [done.repo, done.file, done.commitOid, done.changed],
    ["/repos/tasks", "tasks/fix-the-bar.md", "t1+", true],
  );
  assert.deepEqual(done.card, {
    title: "Fix the bar",
    status: "in-progress",
    owner: "misha@nustom.com",
    agent: "",
    model: "",
    effort: "",
    tags: [],
    blockedOn: "PR #12 review",
    humanAsk: ["Ship it on a Friday?"],
  });
  assert.equal(
    mind.file("tasks/fix-the-bar.md"),
    `---\nstatus: in-progress\nowner: misha@nustom.com\nblocked-on: PR #12 review\nhuman-ask:\n  - Ship it on a Friday?\n---\n\n# Fix the bar\n\nIn Misha's words: the bar overlaps.\n\n## Log\n\n- 2026-11-20 16:05 UTC, ${worker}: Found the cause: the label has no width.\n`,
  );
  assert.equal(
    mind.commits[0].message,
    `tasks: 4 changes\n\n- tasks/fix-the-bar.md is in-progress\n- tasks/fix-the-bar.md: blocked on PR #12 review\n- tasks/fix-the-bar.md: asks "Ship it on a Friday?"\n- tasks/fix-the-bar.md: a note\n\nVia: ${worker}`,
  );
  // the blocker goes; a call that changes nothing makes no commit
  const freed = await taskUpdate(
    mind.itx,
    { file: "tasks/fix-the-bar.md", by: worker, blockedOn: "" },
    mind.deps,
    NOW,
  );
  assert.deepEqual(
    [freed.changed, freed.card.blockedOn, mind.commits[1].message],
    [true, null, `tasks: tasks/fix-the-bar.md: no longer blocked\n\nVia: ${worker}`],
  );
  const same = await taskUpdate(
    mind.itx,
    { file: "tasks/fix-the-bar.md", by: worker, status: "in-progress" },
    mind.deps,
    NOW,
  );
  assert.deepEqual([same.changed, same.commitOid, mind.commits.length], [false, "t1++", 2]);
  // from an agent's own context the caller is the agent
  const own = fakeMind({ caller: EM });
  await taskUpdate(
    own.itx,
    { file: "tasks/fix-the-bar.md", note: "Asked Misha in the room." },
    own.deps,
    NOW,
  );
  assert.match(
    own.file("tasks/fix-the-bar.md"),
    /- 2026-11-20 16:05 UTC, \/agents\/engineering-manager: Asked Misha in the room\.\n$/,
  );
  assert.match(own.commits[0].message, /\n\nVia: \/agents\/engineering-manager$/);
});

test("an update keeps a card's asks true: one is taken off with its reason, one is written again, each named by its beginning", async () => {
  const long =
    "Jonas: ONE DECISION, on the final pinned head of PR-55: 98c082d71 (green; mergeable). DONE as you asked on 20 Nov, and a hundred more words of ids and offsets.";
  const asking = CARD.replace(
    "owner: misha@nustom.com\n",
    `owner: misha@nustom.com\nhuman-ask:\n  - "${long}"\n  - Turn the agent tools on? Yes or no.\n  - Xero's plan, or our own adapter?\n`,
  );
  const mind = fakeMind({ files: { "tasks/fix-the-bar.md": asking } });
  const done = await taskUpdate(
    mind.itx,
    {
      file: "tasks/fix-the-bar.md",
      by: EM,
      withdraw: {
        ask: "Jonas: ONE DECISION",
        why: "PR-55 merged on 21 Nov 2026 at 21:36 UTC.",
      },
      reword: [
        {
          ask: "Turn the agent tools on?",
          to: "Jonas: turn on the agent tools in the Dash, yes or no?",
        },
      ],
      note: "The asks were checked on 23 Nov.",
    },
    mind.deps,
    NOW,
  );
  assert.deepEqual(done.card.humanAsk, [
    "Xero's plan, or our own adapter?",
    "Jonas: turn on the agent tools in the Dash, yes or no?",
  ]);
  const text = mind.file("tasks/fix-the-bar.md");
  assert.match(
    text,
    /\n## Log\n\n- 2026-11-20 16:05 UTC, \/agents\/engineering-manager: An ask was taken off, with no answer: PR-55 merged on 21 Nov 2026 at 21:36 UTC\. It began: "Jonas: ONE DECISION, on the final pinned head of PR-55: 98c082d71 \(green; mergeable\)\. DONE as you a…"\n/,
  );
  assert.match(
    text,
    /\n- 2026-11-20 16:05 UTC, \/agents\/engineering-manager: An ask was written again in plain words\. It began: "Turn the agent tools on\? Yes or no\."\n- 2026-11-20 16:05 UTC, \/agents\/engineering-manager: The asks were checked on 23 Nov\.\n$/,
  );
  assert.doesNotMatch(text, /## Answers/);
  // the message names each ask's change, and the three notes once
  assert.match(
    mind.commits[0].message,
    /^tasks: 3 changes\n\n- tasks\/fix-the-bar\.md: no longer asks "Jonas: ONE DECISION[^\n]*\n- tasks\/fix-the-bar\.md: a note\n- tasks\/fix-the-bar\.md: asks again, as "Jonas: turn on the agent tools in the Dash, yes or no\?"\n\nVia: \/agents\/engineering-manager$/,
  );
  // a beginning that fits no ask, or two, is refused with what the card asks; nothing is written
  await assert.rejects(
    taskUpdate(
      mind.itx,
      { file: "tasks/fix-the-bar.md", withdraw: { ask: "Merge it?", why: "merged" } },
      mind.deps,
      NOW,
    ),
    /no ask of tasks\/fix-the-bar\.md begins with "Merge it\?"\. It asks: "Xero's plan, or our own adapter\?", "Jonas: turn on/,
  );
  const two = fakeMind({
    files: {
      "tasks/fix-the-bar.md": CARD.replace(
        "owner: misha@nustom.com\n",
        "owner: misha@nustom.com\nhuman-ask:\n  - Jonas, the first?\n  - Jonas, the second?\n",
      ),
    },
  });
  await assert.rejects(
    taskUpdate(
      two.itx,
      { file: "tasks/fix-the-bar.md", reword: { ask: "Jonas, the", to: "One?" } },
      two.deps,
      NOW,
    ),
    /2 asks of tasks\/fix-the-bar\.md begin with "Jonas, the"/,
  );
  await assert.rejects(
    taskUpdate(
      two.itx,
      { file: "tasks/fix-the-bar.md", withdraw: { ask: "Jonas, the first?" } },
      two.deps,
      NOW,
    ),
    /withdraw is \{ ask, why \}/,
  );
  await assert.rejects(
    taskUpdate(
      two.itx,
      { file: "tasks/fix-the-bar.md", reword: ["Jonas, the first?"] },
      two.deps,
      NOW,
    ),
    /reword is \{ ask, to \}/,
  );
  assert.deepEqual([mind.commits.length, two.commits.length], [1, 0]);
});

test("an update of nothing is refused, in words; a commit that another one overtook is made again", async () => {
  const mind = fakeMind();
  await assert.rejects(
    taskUpdate(mind.itx, { file: "tasks/fix-the-bar.md" }, mind.deps, NOW),
    /name what changes: status, title, owner/,
  );
  await assert.rejects(
    taskUpdate(mind.itx, { file: "worker.ts", status: "done" }, mind.deps, NOW),
    /file is a task's path/,
  );
  await assert.rejects(
    taskUpdate(mind.itx, { file: "tasks/none.md", status: "done" }, mind.deps, NOW),
    /\/repos\/tasks has no tasks\/none\.md/,
  );
  await assert.rejects(
    taskUpdate(mind.itx, { file: "tasks/fix-the-bar.md", status: " " }, mind.deps, NOW),
    /status is a word/,
  );
  await assert.rejects(
    taskUpdate(mind.itx, ["tasks/fix-the-bar.md"], mind.deps, NOW),
    /taskUpdate takes \{ file, status\?/,
  );
  assert.equal(mind.commits.length, 0);
  const { get } = mind.itx.repos;
  let stale = true;
  mind.itx.repos.get = (path) => ({
    ...get(path),
    tip: async () => (stale ? ((stale = false), "t0") : get(path).tip()),
  });
  const done = await taskUpdate(
    mind.itx,
    { file: "tasks/fix-the-bar.md", status: "done" },
    mind.deps,
    NOW,
  );
  assert.deepEqual([done.commitOid, done.card.status, mind.commits.length], ["t1+", "done", 1]);
});

test("a card given to an agent that runs: the card names it, and it gets the brief once", async () => {
  const mind = fakeMind({ caller: EM });
  const owner = "/agents/claude/owner-1";
  const given = await taskAssign(
    mind.itx,
    { file: "tasks/fix-the-bar.md", agent: owner, message: " Misha waits\n in the room. " },
    mind.deps,
    NOW,
  );
  assert.deepEqual(
    [given.agent, given.starting, given.model, given.running, given.card.status, given.card.agent],
    [owner, false, null, null, "in-progress", owner],
  );
  assert.equal(
    mind.file("tasks/fix-the-bar.md"),
    `---\nstatus: in-progress\nowner: misha@nustom.com\nagent: "${owner}"\n---\n\n# Fix the bar\n\nIn Misha's words: the bar overlaps.\n\n## Log\n\n- 2026-11-20 16:05 UTC, ${EM}: Given to ${owner}.\n`,
  );
  assert.deepEqual(
    mind.messages.map((message) => message.to),
    [owner],
  );
  const [{ text }] = mind.messages;
  assert.match(
    text,
    /^You have a task from \/agents\/engineering-manager\. The card is your brief: tasks\/fix-the-bar\.md in the repo \/repos\/tasks of this mind\.\n\n1\. Read it/,
  );
  assert.match(
    text,
    /itx\.config\.followTasks\(\{ file: "tasks\/fix-the-bar\.md", agent: "\/agents\/claude\/owner-1", repo: "tasks" \}\)/,
  );
  assert.match(
    text,
    /itx\.config\.taskUpdate\(\{ file: "tasks\/fix-the-bar\.md", by: "\/agents\/claude\/owner-1", note: "…", repo: "tasks" \}\)/,
  );
  assert.match(
    text,
    /\n4\. Send no status messages: whoever needs your state reads the card or follows it\.\n5\. Close out your own card: [^\n]*gets a card of its own \(taskOpen\) BEFORE you close, and your last note names it\.\n\nIn the words/,
  );
  assert.match(
    text,
    /\n\nIn the words of the agent that gives you the card: Misha waits in the room\.$/,
  );
  assert.equal(mind.appended.length, 0);
  // a card that is in review or done keeps its status
  const late = fakeMind({
    files: { "tasks/fix-the-bar.md": CARD.replace("status: todo", "status: in-review") },
  });
  assert.equal(
    (
      await taskAssign(
        late.itx,
        { file: "tasks/fix-the-bar.md", agent: owner, by: EM },
        late.deps,
        NOW,
      )
    ).card.status,
    "in-review",
  );
});

test("a mind's own start of a new agent: the card names what it started, and the brief ends with the mind's own rules", async () => {
  const file = "tasks/fix-the-bar.md";
  const worker = "/agents/claude/fix-bar-abc123";
  const asked = [];
  const own = {
    startWorker: async (_itx, input) => {
      asked.push(input);
      return { agent: worker, model: "a-model", effort: "medium", running: 2 };
    },
    briefRules: async ({ worker: isNew }) => [
      "6. Merge your own pull request.",
      ...(isNew ? ["7. One heavy check at a time."] : []),
    ],
  };
  const mind = fakeMind({ caller: EM, own });
  const given = await taskAssign(
    mind.itx,
    { file, worker: { name: "fix-bar", repo: "config" } },
    mind.deps,
    NOW,
  );
  assert.deepEqual(asked, [
    { worker: { name: "fix-bar", repo: "config" }, by: EM, file, repo: "/repos/tasks" },
  ]);
  assert.deepEqual(
    [given.agent, given.starting, given.model, given.effort, given.running],
    [worker, true, "a-model", "medium", 2],
  );
  assert.deepEqual(
    [given.card.agent, given.card.model, given.card.effort, given.card.status],
    [worker, "a-model", "medium", "in-progress"],
  );
  assert.match(
    mind.file(file),
    /\nagent: "\/agents\/claude\/fix-bar-abc123"\nmodel: a-model\neffort: medium\n---\n/,
  );
  // the card says what is true at this moment: the worker was asked for
  assert.match(
    mind.file(file),
    /A new worker was asked for: \/agents\/claude\/fix-bar-abc123 \(a-model, medium\)\.\n$/,
  );
  assert.deepEqual(
    mind.messages.map((message) => message.to),
    [worker],
  );
  assert.match(
    mind.messages[0].text,
    /\n5\. Close out your own card: [^\n]*\n6\. Merge your own pull request\.\n7\. One heavy check at a time\.$/,
  );
  // an agent that runs gets the mind's rules too, without those of a new one
  const old = fakeMind({ caller: EM, own });
  await taskAssign(old.itx, { file, agent: "/agents/claude/owner-1" }, old.deps, NOW);
  assert.match(old.messages[0].text, /\n6\. Merge your own pull request\.$/);
  // a start that names no model: the card names the agent alone
  const bare = fakeMind({ caller: EM, own: { startWorker: async () => ({ agent: worker }) } });
  const plain = await taskAssign(bare.itx, { file, worker: {} }, bare.deps, NOW);
  assert.deepEqual(
    [plain.model, plain.effort, plain.running, plain.card.model],
    [null, null, null, ""],
  );
  assert.match(
    bare.file(file),
    /A new worker was asked for: \/agents\/claude\/fix-bar-abc123\.\n$/,
  );
  // the start's own refusal is the call's: nothing was written
  const refused = fakeMind({
    caller: EM,
    own: {
      startWorker: async () => {
        throw new Error("this computer is short of memory");
      },
    },
  });
  await assert.rejects(
    taskAssign(refused.itx, { file, worker: { name: "a" } }, refused.deps, NOW),
    /this computer is short of memory/,
  );
  assert.deepEqual([refused.commits.length, refused.messages.length], [0, 0]);
  // a mind that starts no agent says so, and writes nothing
  const none = fakeMind({ caller: EM });
  await assert.rejects(
    taskAssign(none.itx, { file, worker: { name: "a" } }, none.deps, NOW),
    /this mind starts no new agent for a card\. Give the card to an agent that runs: \{ file, agent \}\./,
  );
  assert.deepEqual([none.commits.length, none.messages.length], [0, 0]);
});

test("an agent that provably does not run takes no card; one that cannot be proven gone takes it", async () => {
  const file = "tasks/fix-the-bar.md";
  // as the mind's catalog has them: a closed window sends no end, so its row stays idle
  const closed = "/agents/claude/first-deploy-fix-mwo8bsev-4c0268";
  // NOW is 20 Nov 16:05 UTC: a turn of 14:05 was 2 hours ago, one of the day before 24 hours ago
  const lately = "2026-11-20T14:05:00.000Z";
  const yesterday = "2026-11-19T16:05:00.000Z";
  const rows = {
    [closed]: { kind: "claude", status: "idle", lastActivityAt: lately },
    "/agents/claude/owner-1": { kind: "claude", status: "idle", lastActivityAt: yesterday },
    "/agents/claude/failed-start-abc123": { kind: "claude", status: "ended" },
    "/agents/claude/on-a-mac-abc123": { kind: "claude", status: "idle", lastActivityAt: lately },
    "/agents/claude/on-a-mac-def456": {
      kind: "claude",
      status: "working",
      lastActivityAt: yesterday,
    },
    "/agents/codex/long-idle": { kind: "codex", status: "idle", lastActivityAt: yesterday },
    "/agents/herdr/a-pane": { kind: "herdr", status: "idle" },
    [EM]: { kind: "iterate", status: "idle", lastActivityAt: yesterday },
  };
  // what this mind can prove of a session: it lists the ones that run on its own computer
  const seen = [];
  const own = {
    sessionState: async (_itx, agent, row) => {
      seen.push([agent, row.kind]);
      if (agent === "/agents/claude/owner-1") return "runs";
      if (agent === closed) return "is a session that does not run now";
      return undefined;
    },
  };
  const mind = fakeMind({ caller: EM, rows, own });
  await assert.rejects(
    taskAssign(mind.itx, { file, agent: closed }, mind.deps, NOW),
    /first-deploy-fix-mwo8bsev-4c0268 is a session that does not run now\. Nobody would read the card\. Give it to an agent that runs; name \/agents\/claude\/first-deploy-fix-mwo8bsev-4c0268 in the card's text/,
  );
  await assert.rejects(
    taskAssign(mind.itx, { file, agent: "/agents/claude/failed-start-abc123" }, mind.deps, NOW),
    /failed-start-abc123 has ended\. Nobody would read the card/,
  );
  // nothing was written and nobody was told; a row that ended is not asked about
  assert.deepEqual([mind.commits.length, mind.messages.length], [0, 0]);
  assert.deepEqual(seen, [[closed, "claude"]]);
  // the mind proves that it runs, however long ago its last turn was
  assert.equal(
    (await taskAssign(mind.itx, { file, agent: "/agents/claude/owner-1" }, mind.deps, NOW)).agent,
    "/agents/claude/owner-1",
  );
  // WHAT THE MIND CANNOT PROVE goes by the agent's last turn. Given: a session with a turn 2 hours
  // ago; a row with no time; and an iterate agent, which is the mind's own loop, however long it
  // was idle. With no `sessionState` at all, the last turn decides for every session
  for (const agent of ["/agents/claude/on-a-mac-abc123", "/agents/herdr/a-pane", EM]) {
    const each = fakeMind({ caller: SYSADMIN, rows, own });
    assert.equal(
      (await taskAssign(each.itx, { file, agent }, each.deps, NOW)).card.agent,
      agent,
      agent,
    );
  }
  const plain = fakeMind({ caller: EM, rows });
  assert.equal(
    (await taskAssign(plain.itx, { file, agent: closed }, plain.deps, NOW)).agent,
    closed,
  );
  // refused: no turn for a day, whatever the row says the agent does
  for (const agent of ["/agents/claude/on-a-mac-def456", "/agents/codex/long-idle"]) {
    const each = fakeMind({ caller: SYSADMIN, rows, own });
    await assert.rejects(
      taskAssign(each.itx, { file, agent }, each.deps, NOW),
      /has had no turn since 2026-11-19 16:05 UTC \(more than 12 hours\), and the mind cannot tell whether it still runs\. Nobody would read the card\. Give it to an agent that runs/,
      agent,
    );
    assert.deepEqual([each.commits.length, each.messages.length], [0, 0]);
  }
});

test("what goes wrong when a card is given is said in words, with what to do", async () => {
  const mind = fakeMind({ caller: EM });
  const file = "tasks/fix-the-bar.md";
  await assert.rejects(
    taskAssign(mind.itx, { file }, mind.deps, NOW),
    /taskAssign takes \{ file, agent \} for an agent that runs, or \{ file, worker/,
  );
  await assert.rejects(
    taskAssign(
      mind.itx,
      { file, agent: "/agents/a", worker: { name: "a", repo: "private" } },
      mind.deps,
      NOW,
    ),
    /taskAssign takes/,
  );
  await assert.rejects(
    taskAssign(mind.itx, { file, agent: "/agents/typo" }, mind.deps, NOW),
    /\/agents\/typo is no agent/,
  );
  await assert.rejects(
    taskAssign(mind.itx, { file, worker: "fix-bar" }, mind.deps, NOW),
    /worker is what this mind's start of a new agent takes, as an object/,
  );
  await assert.rejects(
    taskAssign(mind.itx, { file: "tasks/none.md", agent: EM }, mind.deps, NOW),
    /\/repos\/tasks has no tasks\/none\.md\. Open the card first \(taskOpen\)\./,
  );
  assert.deepEqual([mind.commits.length, mind.messages.length], [0, 0]);
  // the card was written and the agent did not take the message: the call says how to send it again
  const deaf = fakeMind({ caller: EM, machine: { deaf: "/agents/claude/owner-1" } });
  await assert.rejects(
    taskAssign(deaf.itx, { file, agent: "/agents/claude/owner-1" }, deaf.deps, NOW),
    /the card names \/agents\/claude\/owner-1, and the message to it failed \(no such agent\): call taskAssign again with \{ file: "tasks\/fix-the-bar\.md", agent: "\/agents\/claude\/owner-1" \}/,
  );
  assert.equal(parseTask(file, deaf.file(file)).agent, "/agents/claude/owner-1");
});

test("the brief names the repo when it is not the tasks repo, and its sender when there is one", () => {
  const far = briefOf({
    repo: "/repos/other",
    file: "tasks/a.md",
    agent: "/agents/w",
    by: null,
    words: "",
  });
  assert.match(
    far,
    /^You have a task\. The card is your brief: tasks\/a\.md in the repo \/repos\/other of this mind\./,
  );
  assert.match(
    far,
    /followTasks\(\{ file: "tasks\/a\.md", agent: "\/agents\/w", repo: "other" \}\)/,
  );
  assert.match(
    far,
    /taskUpdate\(\{ file: "tasks\/a\.md", by: "\/agents\/w", note: "…", repo: "other" \}\)/,
  );
  assert.doesNotMatch(far, /In the words of/);
});

test("a mind's own way with a note: the card keeps what it answers, and a mind with none keeps the note", async () => {
  const file = "tasks/fix-the-bar.md";
  const mind = fakeMind({
    caller: EM,
    own: {
      linkNote: async (_itx, note) =>
        note.replace("9217f14", "[9217f14](https://example.com/c/9217f14)"),
    },
  });
  await taskUpdate(
    mind.itx,
    { file, status: "done", note: "Live: config commit 9217f14." },
    mind.deps,
    NOW,
  );
  assert.match(
    mind.file(file),
    /: Live: config commit \[9217f14\]\(https:\/\/example\.com\/c\/9217f14\)\.\n$/,
  );
  const plain = fakeMind({ caller: EM });
  await taskUpdate(plain.itx, { file, note: "Live: config commit 9217f14." }, plain.deps, NOW);
  assert.match(plain.file(file), /: Live: config commit 9217f14\.\n$/);
});

test("an ask that is a choice brings its options and a recommendation, or says why it is no choice", async () => {
  const decision = {
    options: [
      { name: "Friday", tradeoff: "Live two days sooner; nobody watches it over the weekend." },
      { name: "Monday", tradeoff: "Two days later; the team is there when it lands." },
    ],
    recommend: "Monday",
    why: "The change touches sign-in.",
  };
  const mind = fakeMind();
  const done = await taskUpdate(
    mind.itx,
    {
      file: "tasks/fix-the-bar.md",
      by: "/agents/worker",
      ask: "Jonas: ship on Friday or on Monday?",
      decision,
    },
    mind.deps,
    NOW,
  );
  assert.deepEqual(done.card.humanAsk, ["Jonas: ship on Friday or on Monday?"]);
  assert.equal(
    mind.file("tasks/fix-the-bar.md"),
    "---\nstatus: todo\nowner: misha@nustom.com\nhuman-ask:\n  - Jonas: ship on Friday or on Monday?\n---\n\n# Fix the bar\n\nIn Misha's words: the bar overlaps.\n\n## Decisions\n\n- **Jonas: ship on Friday or on Monday?**\n  - Option: Friday: Live two days sooner; nobody watches it over the weekend.\n  - Option: Monday: Two days later; the team is there when it lands.\n  - Recommended: Monday: The change touches sign-in.\n",
  );
  assert.equal(mind.commits.length, 1);
  assert.equal(done.warning, undefined);
  // an ask with neither is taken, and the call's answer warns ("Only warn": Jonas, 25 Nov 2026)
  const bare = fakeMind();
  const warned = await taskUpdate(
    bare.itx,
    { file: "tasks/fix-the-bar.md", ask: "Ship it?" },
    bare.deps,
    NOW,
  );
  assert.deepEqual(warned.card.humanAsk, ["Ship it?"]);
  assert.match(
    warned.warning,
    /^This ask has no options\. An ask that is a choice names them: add decision: .* add noChoice: "<why>" instead/,
  );
  assert.match(
    (await taskOpen(bare.itx, { title: "A card", ask: "Ship it?" }, bare.deps)).warning,
    /^This ask has no options/,
  );
  // no warning for an ask that says why it is no choice, and none for a call that adds no ask
  assert.equal(
    (
      await taskUpdate(
        bare.itx,
        {
          file: "tasks/fix-the-bar.md",
          ask: "Open the link?",
          noChoice: "Only a person sees the page.",
        },
        bare.deps,
        NOW,
      )
    ).warning,
    undefined,
  );
  assert.equal(
    (await taskUpdate(bare.itx, { file: "tasks/fix-the-bar.md", note: "x" }, bare.deps, NOW))
      .warning,
    undefined,
  );
  const refused = fakeMind();
  // a decision that is not whole
  const bad = (change, words) =>
    assert.rejects(
      taskUpdate(
        refused.itx,
        { file: "tasks/fix-the-bar.md", ask: "Ship it?", decision: { ...decision, ...change } },
        refused.deps,
        NOW,
      ),
      words,
    );
  await bad({ options: [decision.options[0]] }, /at least two options/);
  await bad(
    { options: [{ name: "Friday" }, decision.options[1]] },
    /each of decision\.options is \{ name, tradeoff \}/,
  );
  await bad(
    { recommend: "Tuesday" },
    /decision\.recommend is the name of one option: "Friday", "Monday"/,
  );
  await bad({ why: " " }, /decision\.why says why/);
  await assert.rejects(
    taskUpdate(
      refused.itx,
      { file: "tasks/fix-the-bar.md", ask: ["One?", "Two?"], decision },
      refused.deps,
      NOW,
    ),
    /a decision is of ONE ask/,
  );
  await assert.rejects(
    taskUpdate(
      refused.itx,
      { file: "tasks/fix-the-bar.md", note: "x", decision },
      refused.deps,
      NOW,
    ),
    /go with an ask/,
  );
  assert.equal(refused.commits.length, 0);
  // a new card with a decision ask
  const opened = await taskOpen(
    refused.itx,
    { title: "Ship day", ask: "Jonas: ship on Friday or on Monday?", decision },
    refused.deps,
  );
  assert.match(
    refused.file(opened.file),
    /## Decisions\n\n- \*\*Jonas: ship on Friday or on Monday\?\*\*\n {2}- Option: Friday: /,
  );
  // the first message to a card's agent says the rule
  assert.match(
    briefOf({ repo: "/repos/tasks", file: "tasks/a.md", agent: "/agents/a", by: EM }),
    /An ask that is a choice goes with decision: \{ options: \[\{ name, tradeoff \}, …\], recommend, why \}.* its answer then holds a warning/,
  );
});

test("an ask whose answer another agent acts on names that agent, and the words that the asker waits for", async () => {
  const mind = fakeMind({ caller: EM });
  const file = "tasks/fix-the-bar.md";
  const told = await taskUpdate(
    mind.itx,
    {
      file,
      ask: "Jonas: release the move of Jeeves.",
      tell: { agent: " /agents/sysadmin ", words: "Move Jeeves after the local test." },
    },
    mind.deps,
    NOW,
  );
  // it is no choice: no warning, and the card keeps where the answer goes
  assert.equal(told.warning, undefined);
  assert.deepEqual(told.card.humanAsk, ["Jonas: release the move of Jeeves."]);
  assert.match(
    mind.file(file),
    /\n## Decisions\n\n- \*\*Jonas: release the move of Jeeves\.\*\*\n {2}- Tell: \/agents\/sysadmin: Move Jeeves after the local test\.\n/,
  );
  assert.match(
    mind.commits[0].message,
    /"Jonas: release the move of Jeeves\." is answered by a message to \/agents\/sysadmin/,
  );
  // what is refused, in words, and writes nothing
  const before = mind.commits.length;
  await assert.rejects(
    taskUpdate(
      mind.itx,
      { file, ask: "A?", tell: { agent: "sysadmin", words: "x" } },
      mind.deps,
      NOW,
    ),
    /tell\.agent is the path of the agent/,
  );
  await assert.rejects(
    taskUpdate(
      mind.itx,
      { file, ask: ["A?", "B?"], tell: { agent: "/agents/a", words: "x" } },
      mind.deps,
      NOW,
    ),
    /a tell is of ONE ask/,
  );
  await assert.rejects(
    taskUpdate(mind.itx, { file, tell: { agent: "/agents/a", words: "x" } }, mind.deps, NOW),
    /go with an ask, and this call adds none/,
  );
  await assert.rejects(
    taskUpdate(
      mind.itx,
      {
        file,
        ask: "A?",
        tell: { agent: "/agents/a", words: "x" },
        decision: {
          options: [
            { name: "a", tradeoff: "x" },
            { name: "b", tradeoff: "y" },
          ],
          recommend: "a",
          why: "z",
        },
      },
      mind.deps,
      NOW,
    ),
    /a decision or a tell, not both/,
  );
  assert.equal(mind.commits.length, before);
  // a new card takes one too
  const opened = await taskOpen(
    mind.itx,
    { title: "Release", ask: "Jonas: say go.", tell: { agent: "/agents/sysadmin", words: "Go." } },
    mind.deps,
  );
  assert.match(mind.file(opened.file), / {2}- Tell: \/agents\/sysadmin: Go\.\n/);
});
