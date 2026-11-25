// asks.test.mjs — an agent's answer to an ask of a task (asks.js). Run it with
// `node --test apps/tasks/`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerTask } from "./asks.js";

const NOW = new Date("2026-11-20T14:50:31.000Z");

// A fake mind: repos that hold files at a tip, and a commit that names the tip it was decided on.
function fakeMind(
  files = {
    "tasks/a.md":
      "---\nstatus: todo\nhuman-ask:\n  - Merge #12 now, or wait?\n  - Sign the grant?\n---\n\n# A\n",
  },
) {
  const repos = {
    "/repos/tasks": { tip: "t1", files: { ...files } },
    "/repos/other": { tip: "o1", files: { "tasks/z.md": "---\nhuman-ask: one ask\n---\n" } },
  };
  const commits = [];
  const itx = {
    repos: {
      list: async () => Object.keys(repos).map((path) => ({ path })),
      get: (path) => ({
        tip: async () => repos[path].tip,
        readFile: async (file) => repos[path].files[file] ?? null,
        commitFiles: async ({ message, changes, parent }) => {
          if (parent !== repos[path].tip)
            throw new Error(`repo ${path}: the commit was refused: main is at ${repos[path].tip}`);
          for (const change of changes) repos[path].files[change.path] = change.content;
          repos[path].tip = `${parent}+`;
          commits.push({ repo: path, message, parent });
          return { commitOid: repos[path].tip };
        },
      }),
    },
  };
  return { itx, repos, commits };
}

test("an agent's answer is one commit in the board's own format, and says what is still asked", async () => {
  const mind = fakeMind();
  const done = await answerTask(
    mind.itx,
    {
      file: "tasks/a.md",
      ask: "Merge #12 now, or wait?",
      answer: "Wait for the deploy.",
      by: "misha@nustom.com",
    },
    NOW,
  );
  assert.deepEqual(done, {
    repo: "/repos/tasks",
    file: "tasks/a.md",
    commitOid: "t1+",
    stillAsked: ["Sign the grant?"],
  });
  assert.equal(
    mind.repos["/repos/tasks"].files["tasks/a.md"],
    "---\nstatus: todo\nhuman-ask:\n  - Sign the grant?\n---\n\n# A\n\n## Answers\n\n- **Merge #12 now, or wait?** Wait for the deploy. (misha@nustom.com, 2026-11-20 14:50 UTC)\n",
  );
  assert.deepEqual(mind.commits, [
    {
      repo: "/repos/tasks",
      message: 'tasks: tasks/a.md: answered "Merge #12 now, or wait?"',
      parent: "t1",
    },
  ]);
  // a task of another repo
  const far = await answerTask(
    mind.itx,
    { file: "tasks/z.md", ask: "one ask", answer: "yes", by: "a@x", repo: "other" },
    NOW,
  );
  assert.deepEqual([far.repo, far.stillAsked], ["/repos/other", []]);
});

test("a commit that another one overtook is made again on the new tip", async () => {
  const mind = fakeMind();
  const { get } = mind.itx.repos;
  let stale = true;
  // the first read sees a tip that has moved by the time of the commit
  mind.itx.repos.get = (path) => ({
    ...get(path),
    tip: async () => (stale ? ((stale = false), "t0") : get(path).tip()),
  });
  const done = await answerTask(
    mind.itx,
    { file: "tasks/a.md", ask: "Sign the grant?", answer: "Signed.", by: "a@x" },
    NOW,
  );
  assert.deepEqual(
    [done.commitOid, done.stillAsked, mind.commits.length],
    ["t1+", ["Merge #12 now, or wait?"], 1],
  );
});

test("an answer to nothing is refused, in words", async () => {
  const mind = fakeMind();
  const ask = { file: "tasks/a.md", ask: "Sign the grant?", answer: "Yes.", by: "a@x" };
  await assert.rejects(
    answerTask(mind.itx, { ...ask, ask: "Another ask?" }, NOW),
    /tasks\/a\.md does not ask that\. It asks: "Merge #12 now, or wait\?", "Sign the grant\?"\./,
  );
  await assert.rejects(
    answerTask(mind.itx, { ...ask, file: "tasks/none.md" }, NOW),
    /\/repos\/tasks has no tasks\/none\.md/,
  );
  await assert.rejects(
    answerTask(mind.itx, { ...ask, file: "worker.ts" }, NOW),
    /file is a task's path/,
  );
  await assert.rejects(
    answerTask(mind.itx, { ...ask, answer: " " }, NOW),
    /answer is a text, and it is not empty/,
  );
  await assert.rejects(answerTask(mind.itx, { ...ask, by: undefined }, NOW), /by is a text/);
  await assert.rejects(
    answerTask(mind.itx, { ...ask, repo: "none" }, NOW),
    /the mind has no repo \/repos\/none/,
  );
  await assert.rejects(
    answerTask(mind.itx, "tasks/a.md", NOW),
    /takes \{ file, ask, answer, by, repo\? \}/,
  );
  assert.equal(mind.commits.length, 0);
});
