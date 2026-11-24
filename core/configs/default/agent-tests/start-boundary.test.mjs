// start-boundary.test.mjs: THE AGENT BEGINS AT ITS START FACT (agent/contract.ts `startsTheAgent`).
// A context can hold the log of the platform's own agent, which ran there first. That agent wrote
// `agent/configured`, `agent/context-added`, `agent/paused` and the run facts too, with another
// meaning, and it kept its checkpoint under the same slug in the storage of the facet `agent`.
// These tests show that the agent and its request makers fold nothing of it: no item, no config,
// no request. Then the roles of an input: what `assistant` and `system` are in the conversation.
//
// `OTHER_AGENT` is such a log, written by hand in the shapes of core/lib/src/agents/contract.ts.
//
// Run from the config's root: node --test "agent-tests/*.test.mjs"

import assert from "node:assert/strict";
import { test } from "node:test";
import { reduceProcessor } from "iterate/stream/test-support";
import { AgentContract, startsTheAgent } from "../agent/contract.ts";
import { Agent } from "../agent/processor.ts";
import { agentOnALog, logged, openai } from "./test-support.mjs";

const T = "events.iterate.com/";
const fact = (kind, payload) => ({ type: `${T}${kind}`, payload });
const START = fact("agent/configured", { kind: "agent", config: {} });

/** One exchange of the platform's own agent, and a pause: every type the two contracts share, and
 *  every role. Its config names a model that this agent has no provider for. */
const OTHER_AGENT = [
  fact("agent/create-requested", {}),
  fact("agent/configured", {
    config: { llm: { model: "gpt-6.2-sol", apiKeys: ['getSecret("/secrets/openai")'] } },
  }),
  fact("agent/created", {}),
  fact("agent/message-received", { message: "Say MANGO." }),
  fact("agent/context-added", {
    role: "user",
    content: "Say MANGO.",
    actor: { type: "user" },
    messageOffset: 4,
  }),
  fact("agent/llm-request-requested", { model: "gpt-6.2-sol", triggerOffset: 5 }),
  fact("agent/context-added", {
    role: "user",
    content: "[the mind now] 4 other agents are at work.",
    actor: { type: "agent" },
    llmRequestOffset: 6,
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
    mindSnapshot: true,
  }),
  fact("agent/context-added", {
    role: "system",
    content: "[standing instructions]",
    llmRequestOffset: 6,
    sections: { identity: "You are the mind's agent." },
    snapshot: true,
  }),
  fact("agent/context-added", {
    role: "assistant",
    content: "<codemode>return true</codemode>",
    llmRequestOffset: 6,
    providerModel: "gpt-6.2-sol",
    providerItems: [{ type: "function_call", name: "codemode", arguments: "{}" }],
    call: { callId: "call_1", script: "return true", status: "Checking the sender" },
  }),
  fact("itx/run-requested", { code: "async (itx) => true" }),
  fact("itx/run-settled", {
    requestOffset: 10,
    settlement: { status: "succeeded", result: true },
  }),
  fact("agent/context-added", {
    role: "developer",
    content: "Your script returned: true",
    actor: { type: "script", requestOffset: 10 },
  }),
  fact("agent/context-added", { role: "assistant", content: "MANGO", llmRequestOffset: 6 }),
  fact("agent/web-message-sent", { message: "MANGO" }),
  fact("agent/paused", { reason: "an operator paused it", triggerOffset: 5 }),
];

/** That agent's checkpoint, as its facet's storage holds it: its own version and state. */
const OTHER_CHECKPOINT = {
  version: "20",
  state: {
    creation: { status: "created", offset: 3 },
    contextItems: [{ offset: 5, role: "user", content: "Say MANGO." }],
    config: { llm: { model: "gpt-6.2-sol" } },
    paused: { reason: "an operator paused it" },
  },
};

const fold = (...facts) => reduceProcessor(new Agent(), facts);
const requests = (agent) => agent.durable(`${T}llm-request/requested`);

/** The issues that the engine reports while `work` runs: a payload that its contract refuses is
 *  one of them. */
async function issuesWhile(work) {
  const issues = [];
  const consoleError = console.error;
  console.error = (...args) =>
    args[0]?.event === "issue" ? void issues.push(args[0]) : consoleError(...args);
  try {
    await work();
  } finally {
    console.error = consoleError;
  }
  return issues;
}

// ── the rule, by the pure fold ──

test('the start fact is an `agent/configured` that says `kind: "agent"`, and no other fact', () => {
  assert.equal(startsTheAgent(START), true);
  assert.equal(startsTheAgent(fact("agent/configured", { config: {} })), false);
  assert.equal(startsTheAgent(fact("agent/configured", { kind: "herdr", config: {} })), false);
  assert.equal(startsTheAgent(fact("agent/context-added", { kind: "agent" })), false);
  assert.equal(startsTheAgent({ type: `${T}agent/configured` }), false);
});

test("with no start fact the state is as it began: another agent's facts and a person's words are not read", () => {
  const words = fact("agent/context-added", { role: "user", content: "hello" });
  const state = fold(...OTHER_AGENT, words);
  assert.deepEqual(logged(state), logged(AgentContract.initialState()));
  assert.equal(state.startedAtOffset, null);
});

test("the agent begins at its start fact: what stood before is no item, no config and no pause, and the first input after it owes one request that reads that input alone", () => {
  const startOffset = OTHER_AGENT.length + 1;
  const started = fold(...OTHER_AGENT, START);
  assert.equal(started.startedAtOffset, startOffset);
  assert.deepEqual(started.items, []);
  assert.deepEqual(started.obligations, []);
  assert.equal(started.paused, null);
  // the other agent's model name is not this agent's: its config was not merged in
  assert.equal(started.config.llm.model, AgentContract.initialState().config.llm.model);

  const state = fold(
    ...OTHER_AGENT,
    START,
    fact("agent/context-added", { role: "user", content: "hello" }),
  );
  assert.equal(state.startedAtOffset, startOffset, "a later start fact does not move it");
  const [owed, ...more] = state.obligations;
  assert.deepEqual(more, []);
  const [request] = owed.events;
  assert.equal(request.idempotencyKey, "llm-request/requested:answer/1");
  assert.deepEqual(logged(request.payload.itemsAdded), [
    { atOffset: startOffset + 1, rank: 0, tag: "words", role: "user", text: "hello" },
  ]);
  assert.equal(request.payload.triggerOffset, startOffset + 1);

  const again = fold(...OTHER_AGENT, START, START, fact("agent/paused", { reason: "x" }));
  assert.equal(again.startedAtOffset, startOffset);
  assert.equal(again.paused?.reason, "x", "after the start, every fact is the agent's");
});

// ── on a log, with the other agent's checkpoint in the facet's storage ──

test("a context that another agent ran: the start facts start no request, the engine reports no fact of the old log, and the next input is answered from that input alone", async () => {
  const agent = agentOnALog({
    before: { events: OTHER_AGENT, checkpoint: OTHER_CHECKPOINT },
    model: () => openai({ say: "Four." }),
  });
  const issues = await issuesWhile(async () => {
    await agent.quiet();
    assert.deepEqual(requests(agent), [], "the old conversation is answered by no one");
    assert.equal(agent.calls.length, 0);
    const started = await agent.snapshot();
    assert.equal(started.state.startedAtOffset, OTHER_AGENT.length + 1);
    assert.deepEqual(started.state.items, []);
    assert.equal(started.state.paused, null);

    await agent.say("What is 2 + 2?");
  });
  assert.deepEqual(issues, []);
  assert.deepEqual(agent.invalidFacts(), [], "every fact of the old log parses: none is reported");

  // one request, to this agent's own model: after the prompt, the new words and nothing of the
  // old log
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].model, "openai/gpt-6.2-sol");
  assert.deepEqual(agent.calls[0].body.input.slice(1), [
    { role: "user", content: "What is 2 + 2?" },
  ]);
  assert.deepEqual(agent.said(), ["Four."]);
  const { state } = await agent.snapshot();
  assert.deepEqual(
    state.items.map((item) => item.tag),
    ["words", "llm-response", "script-result"],
  );
});

test("the same context with no start fact: an input there starts nothing, for the agent and for every request maker", async () => {
  const agent = agentOnALog({
    start: false,
    before: { events: OTHER_AGENT, checkpoint: OTHER_CHECKPOINT },
    model: () => openai({ say: "never" }),
  });
  await agent.say("hello");
  assert.deepEqual(requests(agent), []);
  assert.equal(agent.calls.length, 0);
  assert.equal((await agent.state()).startedAtOffset, null);
  // the facts of the test and no other: no host wrote one
  assert.equal(agent.log.events.length, OTHER_AGENT.length + 1);
});

// ── the roles of an input ──

test("what was said in the agent's name and the system's words start nothing, and the next request reads them as the assistant's and as developer context", async () => {
  const agent = agentOnALog({ model: () => openai({ say: "Four." }) });
  const add = (role, content, more = {}) =>
    agent.append(fact("agent/context-added", { role, content, ...more }));
  await add("assistant", "Welcome. I am your agent.");
  await add("system", "The person is on the sign-up page.");
  assert.deepEqual(requests(agent), []);
  assert.deepEqual(agent.invalidFacts(), []);

  await agent.say("What is 2 + 2?");
  assert.equal(agent.calls.length, 1);
  // (the prompt is the first item)
  assert.deepEqual(agent.calls[0].body.input.slice(1), [
    { role: "assistant", content: "Welcome. I am your agent." },
    { role: "developer", content: "The person is on the sign-up page." },
    { role: "user", content: "What is 2 + 2?" },
  ]);
  const { items } = await agent.state();
  assert.deepEqual(
    items.slice(0, 2).map((item) => [item.tag, item.role, item.text]),
    [
      ["llm-response", "assistant", "Welcome. I am your agent."],
      ["context", "developer", "The person is on the sign-up page."],
    ],
  );
});

test("an `assistant` or `system` input whose own policy says so starts a request", () => {
  for (const role of ["assistant", "system"]) {
    const quiet = fold(START, fact("agent/context-added", { role, content: "a line" }));
    assert.deepEqual(quiet.obligations, [], role);
    const asked = fold(
      START,
      fact("agent/context-added", {
        role,
        content: "a line",
        llmRequestPolicy: { behaviour: "after-current-request" },
      }),
    );
    assert.equal(asked.obligations.length, 1, role);
    assert.equal(asked.obligations[0].idempotencyKey, "llm-request/requested:answer/1");
  }
});
