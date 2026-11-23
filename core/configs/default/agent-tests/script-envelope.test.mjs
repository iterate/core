// script-envelope.test.mjs: WHAT THE NOTEBOOK IS SHOWN TO DO. Every script here REALLY RUNS: the
// test's runner evaluates the code of each `itx/run-requested` fact, envelope and all, against the
// in-memory log, as the platform runs it against the agent's context. The fake model writes its
// next script from what it read last, as a real one does: that is where it gets a result's number.
//
// Run from the config's root: node --test "agent-tests/*.test.mjs"

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reduceProcessor } from "iterate/stream/test-support";
import { Agent } from "../agent/processor.ts";
import { scriptRunCode, scriptRunOutcome } from "../agent/script-envelope.ts";
import { agentOnALog, openai } from "./test-support.mjs";

test("a later script reads an earlier result by its number, whole, from the log", async () => {
  const agent = agentOnALog({
    model: (call, calls) => {
      const read = lastResult(call);
      if (calls.length === 1)
        return openai({
          script: "return Array.from({ length: 5000 }, (_, i) => ({ i, square: i * i }))",
        });
      if (calls.length === 2)
        return openai(
          {
            script: `const all = await result(${numberOf(read)}); return all.find((row) => row.i === 4321).square`,
          },
          "2",
        );
      return openai({ say: `It is ${read.split("\n")[1]}.` });
    },
  });
  await agent.say("square the numbers below 5000, then tell me the square of 4321");

  // the model was shown the shape of the value, not the value: about 150,000 characters stay out
  const shown = lastResult(agent.calls[1]);
  const [first] = agent.durable("events.iterate.com/itx/run-settled");
  assert.match(shown, /^\[result \d+\] \d+ characters of JSON, too long to show/);
  assert.equal(numberOf(shown), first.offset, "the number is the offset of the settled fact");
  assert.match(shown, /"… 4997 more"/);
  assert.match(shown, /"square": 4/, "the first rows are shown, so the model sees the fields");
  assert.ok(shown.length < 1_000);

  // the second script read the whole value from the log
  assert.deepEqual(agent.said(), ["It is 18671041."]);

  // ONE COPY: the value is in its settled fact only. The second script's code carries no result,
  // and the agent's state keeps none.
  const [, second] = agent.durable("events.iterate.com/itx/run-requested");
  assert.ok(!String(second.payload?.code).includes("18671041"));
  assert.ok(JSON.stringify(await agent.state()).length < 20_000);
  assert.deepEqual(agent.invalidFacts(), []);
});

test("the number of a failed script throws its error; a wrong number says so; `script(n)` is the source", async () => {
  const agent = agentOnALog({
    model: (call, calls) => {
      const failed = numberOf(lastResult(call));
      if (calls.length === 1) return openai({ script: 'throw new Error("no such user")' });
      if (calls.length === 2)
        return openai(
          {
            script: `const caught = await result(${failed}).catch((error) => error.message);
               const wrong = await result(1).catch((error) => error.message);
               return { caught, wrong, source: await script(${failed}) };`,
          },
          "2",
        );
      return openai({ say: "Understood." });
    },
  });
  await agent.say("look up the user");
  const [failed, read] = agent.durable("events.iterate.com/itx/run-settled");
  assert.deepEqual(read.payload.settlement.result, {
    caught: `the script of result ${failed.offset} failed: no such user`,
    wrong:
      "no script result has the number 1: the number is at the head of a result, as [result n]",
    source: 'throw new Error("no such user")',
  });
});

test("words and status are appends the script does not await: they still land before the run settles", async () => {
  // The appends of the fake `itx` take a moment, as real ones do, and none is awaited here. The
  // platform's runner ends a run when its script returns, and an append still in flight is lost.
  // So the envelope waits for every append: on the script's `itx`, and on `itx.cd(…)` and a `cd`
  // of that.
  const script = `itx.append({ type: "events.iterate.com/agent/summary-updated", payload: { activity: "Squaring" } });
    itx.append({ type: "events.iterate.com/agent-ui/message-sent", payload: { message: "On it." } });
    itx.cd("/agents/test").append({ type: "events.iterate.com/agent/summary-updated", payload: { title: "Also" } });
    itx.cd("/agents").cd("/agents/test").append({ type: "events.iterate.com/agent/summary-updated", payload: { description: "Deep" } });
    return { big: 10n, bytes: new Uint8Array(3), failure: new TypeError("not a number") };`;
  const agent = agentOnALog({
    model: (_call, calls) => (calls.length === 1 ? openai({ script }) : openai({ say: "Done." })),
  });
  await agent.say("square it");
  const [settled] = agent.durable("events.iterate.com/itx/run-settled");
  const updates = agent.durable("events.iterate.com/agent/summary-updated");
  const [words] = agent.durable("events.iterate.com/agent-ui/message-sent");
  assert.deepEqual(
    updates.map((update) => update.payload),
    [{ activity: "Squaring" }, { title: "Also" }, { description: "Deep" }],
  );
  assert.deepEqual(words.payload, { message: "On it." });
  for (const landed of [...updates, words]) assert.ok(landed.offset < settled.offset);
  assert.deepEqual(agent.said(), ["On it.", "Done."]);
  assert.deepEqual(settled.payload.settlement.result, {
    big: "10",
    bytes: "[binary: 3 bytes. Store it in a file and return the path]",
    failure: { name: "TypeError", message: "not a number" },
  });
  assert.deepEqual(agent.invalidFacts(), []);
});

test("words to another agent are ONE append of its input on its path, not awaited, with no `from`; the agent there reads who sent it", async () => {
  const script =
    'itx.cd("/agents/planner").append({ type: "events.iterate.com/agent/context-added", payload: { role: "user", content: "Plan it." } });';
  const agent = agentOnALog({
    model: (_call, calls) => (calls.length === 1 ? openai({ script }) : {}),
  });
  await agent.say("ask the planner");
  const [settled] = agent.durable("events.iterate.com/itx/run-settled");
  assert.deepEqual(settled.payload?.settlement, { status: "succeeded" });
  // it landed there once, before the run settled, and the platform's stamp names the sender
  const landed = agent.appendedTo("/agents/planner");
  assert.deepEqual(
    landed.map(({ event }) => event),
    [
      {
        type: "events.iterate.com/agent/context-added",
        payload: { role: "user", content: "Plan it." },
        source: { origin: "/agents/test" },
      },
    ],
  );
  assert.ok(landed[0].afterOffset < settled.offset, "the run settled after it landed");
  // nothing of it is in the agent's own log: only the person's input is
  assert.equal(agent.durable("events.iterate.com/agent/context-added").length, 1);
  assert.equal(agent.calls.length, 1, "the script returned nothing: no further request");

  // the agent at `/agents/planner` reads the words after the sender's path
  const planner = reduceProcessor(new Agent(), [{ ...landed[0].event, path: "/agents/planner" }]);
  assert.deepEqual(
    planner.items.map((item) => item.text),
    ["[from /agents/test]\nPlan it."],
  );
});

test("several things at once are `Promise.all` in the one script, and the result comes back in one request", async () => {
  const script =
    "const [count, triple] = await Promise.all([[1, 2, 3].length, 3 * 5]);\nreturn { count, triple };";
  const agent = agentOnALog({
    model: (_call, calls) => openai([{ script }, { say: "3 and 15." }][calls.length - 1]),
  });
  await agent.say("count to three, and triple 5");
  assert.deepEqual(agent.scripts()[0], script);
  assert.match(
    agent.calls[1].body.input.at(-1).content,
    /^Result of script 1:\n\[result \d+\]\n\{"count":3,"triple":15\}$/,
  );
  assert.equal(agent.calls.length, 2);
  assert.deepEqual(agent.said(), ["3 and 15."]);
});

test("what the model reads of a result: its number, how long a slow one ran, the start of a long text", () => {
  const read = (settlement, ranMs = 0) =>
    scriptRunOutcome({ settlement, resultNumber: 45, ranMs, historyLimit: 100 });
  assert.equal(read({ status: "succeeded", result: { a: 1 } }), '[result 45]\n{"a":1}');
  assert.equal(read({ status: "succeeded", result: "x" }, 2_340), "[result 45, 2.3 s]\nx");
  // a script that returned nothing asks for no request; `null` is a value
  assert.equal(read({ status: "succeeded" }), null);
  assert.equal(read({ status: "succeeded", result: null }), "[result 45]\nnull");
  assert.equal(
    read({ status: "succeeded", result: "a".repeat(500) }),
    `[result 45] A text of 500 characters. Its first 100:\n${"a".repeat(100)}\n` +
      "A later script reads the whole value with `await result(45)`: filter it there, and return only what you need.",
  );
  assert.match(
    read({ status: "failed", failureKind: "deadline", error: "ran out of time" }) ?? "",
    /^\[result 45\] The script failed \(deadline\): ran out of time\nIt did not finish within its 10 minutes/,
  );
});

// ── test functions ──

/** The newest script result in a request, as the model reads it: a developer item. */
function lastResult(call) {
  const outputs = call.body.input.filter(
    (item) => item.role === "developer" && String(item.content).startsWith("Result of script"),
  );
  return String(outputs.at(-1)?.content ?? "").replace(/^Result of script \d+:\n/, "");
}

/** The number at the head of a result. */
const numberOf = (result) => Number(/^\[result (\d+)/.exec(result)?.[1]);

test("the script's scope hides no fact: no `say`, `send`, `ask` or `fork`, and `llmRequestOffset` is the offset of the script's request", async () => {
  // words, a subagent and a side request are facts that a script appends (fragments.ts)
  const names = ["messages", "llm", "agents", "say", "send", "ask", "fork"];
  const script = `return { offset: llmRequestOffset, names: [${names.map((name) => `typeof ${name}`).join(", ")}] };`;
  const agent = agentOnALog({
    model: (_call, calls) => openai(calls.length === 1 ? { script } : {}),
  });
  await agent.say("where am I?");
  const [request] = agent.durable("events.iterate.com/llm-request/requested");
  const [settled] = agent.durable("events.iterate.com/itx/run-settled");
  assert.deepEqual(settled.payload?.settlement, {
    status: "succeeded",
    result: { offset: request.offset, names: names.map(() => "undefined") },
  });
  const code = scriptRunCode({
    script: "return 1;",
    agentPath: "/agents/test",
    llmRequestOffset: 7,
  });
  assert.match(code, /const llmRequestOffset = 7;/);
  for (const name of [...names, "__ask"])
    assert.doesNotMatch(code, new RegExp(`\\b${name}\\s*[:=(]`), name);
  const source = readFileSync(new URL("../agent/script-envelope.ts", import.meta.url), "utf8");
  for (const name of ["llm.ask", "agents.fork", "messages.say", "messages.send"])
    assert.ok(!source.includes(name), name);
});
