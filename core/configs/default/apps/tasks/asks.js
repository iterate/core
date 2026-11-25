// asks.js — AN ASK OF A TASK, ANSWERED BY AN AGENT: `itx.config.answerTask(…)` (api.ts). A
// person answers an ask on the board ("Needs a person", public/app.js `Ask`). An agent uses this
// call for an answer that a person gave it somewhere else: in a chat, on a call, in Slack. Both
// write one format, public/tasks-model.js `answerAsk`: the ask's line leaves `human-ask:`, and
// `- **<the ask>** <the answer> (<who>, <when>)` is added under `## Answers` in the task's text.
// The commit is the news: the agent that follows the task hears of it (feed.js).
import { repoOf } from "./feed.js";
import { answerAsk, isTaskPath, messageOf, parseTask } from "./public/tasks-model.js";

const asksOf = (file, source) => parseTask(file, source).humanAsk;

/** `itx.config.answerTask({ file, ask, answer, by, repo? })`: one commit to the task file `file`
 *  of the tasks repo (or of the repo `repo` names). `ask` is the ask's whole text, as the file has
 *  it; `by` is the person who answered, as they are known (an address). It answers
 *  `{ repo, file, commitOid, stillAsked }`. An ask that the file does not have is refused, with
 *  the asks it does have. A commit that another one overtook is made again on the new tip, once. */
export async function answerTask(itx, input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("answerTask takes { file, ask, answer, by, repo? }.");
  const { file, ask, answer, by } = input;
  for (const [name, value] of Object.entries({ file, ask, answer, by }))
    if (typeof value !== "string" || !value.trim())
      throw new Error(`answerTask: ${name} is a text, and it is not empty.`);
  if (!isTaskPath(file))
    throw new Error('answerTask: file is a task\'s path, like "tasks/a-task.md".');
  const repo = await repoOf("answerTask", itx, input.repo);
  const handle = itx.repos.get(repo);
  const change = { kind: "answer", path: file, ask, answer, by, at: now.toISOString() };
  for (let attempt = 0; ; attempt += 1) {
    const tip = await handle.tip();
    const source = tip ? await handle.readFile(file, { commitOid: tip }) : null;
    if (source === null) throw new Error(`answerTask: ${repo} has no ${file}.`);
    const next = answerAsk(source, change);
    if (next === source) {
      const asks = asksOf(file, source);
      throw new Error(
        `answerTask: ${file} does not ask that. It asks: ${asks.length > 0 ? asks.map((each) => JSON.stringify(each)).join(", ") : "nothing"}.`,
      );
    }
    try {
      const { commitOid } = await handle.commitFiles({
        message: messageOf([change]),
        changes: [{ path: file, content: next }],
        parent: tip,
      });
      return { repo, file, commitOid, stillAsked: asksOf(file, next) };
    } catch (error) {
      // main moved between the read and the commit: read again, once
      if (attempt > 0) throw error;
    }
  }
}
