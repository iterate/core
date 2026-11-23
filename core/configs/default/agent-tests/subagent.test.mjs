// subagent.test.mjs: A SUBAGENT IS ONE FACT, on two (or three) in-memory logs, with the agent and
// the request makers hosted on each. A script appends `agent/subagent-requested`. A fake of the
// mind's worker side answers it (the real one is the kind's `processEvent` in agent-kinds/agent.ts,
// which has its own test): the child gets ONE append, the parent gets the answer and its note in
// ONE append. With `copyContext` the child's first request begins with the bytes of the parent's
// last request under the parent's cache key, and a script in the child reads its ancestors'
// results by number.
//
// Run from the config's root: node --test "agent-tests/*.test.mjs"

import assert from "node:assert/strict";
import { test } from "node:test";

import { agentStartEvents, contextCopiedEvents } from "../agent/start.ts";
import { agentOnALog, openai } from "./test-support.mjs";

const T = "events.iterate.com/";
const PARENT = "/agents/test";
const CHILD = "/agents/test/hotel";
const GRANDCHILD = "/agents/test/hotel/rooms";
const SOURCE = ["itx", ["cd", "/"], "repos", ["get", "/repos/config"], ["modules", {}]];
const CODE = { source: SOURCE, mainModule: "facets.ts", cacheKey: "agent:abc" };
const FACETS = [
  { name: "agent", className: "AgentFacet", consumes: [`${T}agent/context-added`] },
  { name: "llm-api-openai-responses", className: "OpenaiResponsesFacet", consumes: [] },
];

/** The mind: every agent's context by its path, and the requests its worker has answered. */
const worldOf = () => ({ agents: {}, answered: new Set() });

/** An agent on its own log. A parent is started as start.ts starts one; a child (`child: true`)
 *  is started by the mind's worker. */
async function started(world, path, model, child = false) {
  const logsOf = Object.fromEntries(
    Object.entries(world.agents).map(([at, other]) => [at, () => other.log.events]),
  );
  const agent = agentOnALog({ path, model, logsOf });
  world.agents[path] = agent;
  if (!child) await agent.append(...(await agentStartEvents(path, { facets: FACETS, code: CODE })));
  return agent;
}

/** THE MIND'S WORKER SIDE, as a fake: each `agent/subagent-requested` of any log, once. */
async function mindWorker(world) {
  for (const [path, parent] of Object.entries(world.agents))
    for (const request of parent.durable(`${T}agent/subagent-requested`)) {
      const key = `${path}@${request.offset}`;
      if (world.answered.has(key)) continue;
      world.answered.add(key);
      await answer(world, parent, request);
    }
}

/** ONE append to the child: the start facts, the model, the copy and the brief. ONE append to the
 *  parent: the answer and its note. */
async function answer(world, parent, request) {
  const { path, brief, model, copyContext } = request.payload;
  const child = world.agents[path];
  const { offset, state } = await parent.snapshot();
  const key = `${request.path}@${request.offset}`;
  // oxlint-disable-next-line iterate/simple-truthiness-check -- a request without a model leaves the child's config without a `model` key
  const llm = { ...(model && { model }) };
  const config = copyContext
    ? {
        instructions: state.config.instructions,
        llm: {
          model: state.config.llm.model,
          promptCacheKey: state.config.llm.promptCacheKey ?? request.path,
          ...llm,
        },
      }
    : model
      ? { llm }
      : {};
  const items = [...state.copiedItems, ...state.items];
  const copied = copyContext
    ? contextCopiedEvents(
        { path: request.path, throughOffset: offset, lineage: state.lineage, items },
        key,
      )
    : [];
  const briefed = brief
    ? [
        {
          type: `${T}agent/context-added`,
          idempotencyKey: `agent/subagent-brief:${key}`,
          payload: { role: "user", content: brief },
        },
      ]
    : [];
  const start = await agentStartEvents(path, { config, facets: FACETS, code: CODE });
  await child.append(...start, ...copied, ...briefed);
  await parent.append(
    {
      type: `${T}agent/subagent-started`,
      idempotencyKey: `agent/subagent-answered:${request.offset}`,
      payload: { requestOffset: request.offset, path, copiedItems: copyContext ? items.length : 0 },
    },
    {
      type: `${T}agent/context-added`,
      idempotencyKey: `agent/subagent-note:${request.offset}`,
      payload: {
        role: "developer",
        content: `[subagent] Your subagent at ${path} has started.`,
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    },
  );
}

/** Wait until no log of the world grows any more, the mind's worker answering as it goes. */
async function quiet(world) {
  for (let total = -1; ;) {
    for (const agent of Object.values(world.agents)) await agent.quiet();
    await mindWorker(world);
    const now = Object.values(world.agents).reduce((sum, a) => sum + a.log.pushedEvents.length, 0);
    if (now === total) return;
    total = now;
  }
}

/** A model that runs `scripts[n]` for the n-th call, and is silent after them. */
const scripted =
  (...scripts) =>
  (_call, calls) =>
    openai(calls.length <= scripts.length ? { script: scripts[calls.length - 1] } : {});

/** The fact a script appends, appended by the test on the agent's own log. */
async function requestSubagent(world, agent, payload) {
  const [request] = await agent.append({ type: `${T}agent/subagent-requested`, payload });
  await quiet(world);
  return request;
}

test("a script appends `agent/subagent-requested` with `copyContext`: the child gets ONE append, the parent the answer and its note in ONE append, and the child's first request begins with the bytes of the parent's last request under its key", async () => {
  const world = worldOf();
  const request = { path: CHILD, brief: "book the hotel", copyContext: true };
  const parent = await started(
    world,
    PARENT,
    scripted(
      "const a = 1;",
      `itx.append({ type: "events.iterate.com/agent/subagent-requested", payload: ${JSON.stringify(request)} });`,
    ),
  );
  const child = await started(world, CHILD, scripted("const c = 3;"), true);
  await parent.say("plan the trip");
  await parent.say("and fork for the hotel");
  await quiet(world);

  const [requested] = parent.durable(`${T}agent/subagent-requested`);
  assert.deepEqual(requested.payload, request);
  // ONE append to the child: the start facts, the copy, the brief
  assert.deepEqual(child.appends()[0], [
    "itx/rewrite-rule-configured",
    "agent/configured",
    "itx/subscription-configured",
    "itx/subscription-configured",
    "agent/context-copied",
    "agent/context-added",
  ]);
  const [copied] = child.durable(`${T}agent/context-copied`);
  const { offset } = await parent.snapshot();
  assert.ok(Number(copied.payload.lineage[0].throughOffset) > 0);
  // the parent's items as they were: the response with the request's script is among them
  const parentState = await parent.state();
  const items = copied.payload?.items;
  assert.deepEqual(items, parentState.items.slice(0, items.length));
  assert.ok(items.some((item) => item.text.includes("agent/subagent-requested")));
  assert.ok(offset >= requested.offset);
  // the child's config: the parent's instructions and model, with the key the parent's requests carry
  const [configured] = child.durable(`${T}agent/configured`);
  const config = configured.payload?.config;
  assert.equal(config.instructions, parentState.config.instructions);
  assert.equal(config.llm.model, parentState.config.llm.model);
  assert.equal(config.llm.promptCacheKey, PARENT);

  // ONE append to the parent: the answer and its note, which starts no request
  assert.ok(
    parent.appends().some((kinds) => kinds.join() === "agent/subagent-started,agent/context-added"),
  );
  const [answered] = parent.durable(`${T}agent/subagent-started`);
  assert.deepEqual(answered.payload, {
    requestOffset: requested.offset,
    path: CHILD,
    copiedItems: items.length,
  });
  assert.equal(parent.calls.length, 2, "the note starts no request");

  // the child's first request is whole, and begins with the bytes of the parent's last request
  const [childRequest] = child.durable(`${T}llm-request/requested`);
  assert.equal(childRequest.payload?.extends, null);
  assert.equal(childRequest.payload?.promptCacheKey, PARENT);
  const [first] = child.calls;
  const last = parent.calls.at(-1);
  assert.equal(first.body.instructions, last.body.instructions);
  assert.equal(first.body.prompt_cache_key, PARENT);
  const lastBytes = JSON.stringify(last.body);
  assert.ok(JSON.stringify(first.body).startsWith(lastBytes.slice(0, -"]}".length)));
  assert.deepEqual(first.body.input.at(-1), { role: "user", content: "book the hotel" });
  assert.deepEqual(child.invalidFacts(), []);
  assert.deepEqual(parent.invalidFacts(), []);
});

test("with no `copyContext`: the child gets the start facts, its model and the brief, and nothing of the parent's conversation", async () => {
  const world = worldOf();
  const parent = await started(world, PARENT, scripted("const a = 1;"));
  const child = await started(world, CHILD, scripted(), true);
  await parent.say("plan the trip");
  const request = await requestSubagent(world, parent, {
    path: CHILD,
    brief: "book the hotel",
    model: "anthropic/claude-opus-5.5",
  });
  assert.deepEqual(child.appends()[0], [
    "itx/rewrite-rule-configured",
    "agent/configured",
    "itx/subscription-configured",
    "itx/subscription-configured",
    "agent/context-added",
  ]);
  const [configured] = child.durable(`${T}agent/configured`);
  assert.deepEqual(configured.payload, {
    kind: "agent",
    config: { llm: { model: "anthropic/claude-opus-5.5" } },
  });
  assert.deepEqual(child.durable(`${T}agent/context-copied`), []);
  const childState = await child.state();
  assert.deepEqual(
    childState.items.map((item) => item.text),
    ["book the hotel"],
  );
  assert.deepEqual(childState.lineage, []);
  const [answered] = parent.durable(`${T}agent/subagent-started`);
  assert.deepEqual(answered.payload, {
    requestOffset: request.offset,
    path: CHILD,
    copiedItems: 0,
  });
});

test("in a fork, a script reads a parent's result by its number, and the fork's own first result is numbered after the parent's offset", async () => {
  const world = worldOf();
  const parent = await started(world, PARENT, scripted("return { nights: 3 };"));
  await parent.say("how many nights?");
  const parentResult = parent.durable(`${T}itx/run-settled`)[0].offset;
  // the parent read `[result <parentResult>]`, and so does the copy
  const child = await started(
    world,
    CHILD,
    scripted(`return (await result(${parentResult})).nights * 2;`),
    true,
  );
  await requestSubagent(world, parent, {
    path: CHILD,
    brief: "double the nights",
    copyContext: true,
  });
  const [copied] = child.durable(`${T}agent/context-copied`);
  const [{ throughOffset }] = copied.payload.lineage;
  const [own] = child.durable(`${T}itx/run-settled`);
  assert.deepEqual(own.payload?.settlement, { status: "succeeded", result: 6 });
  const number = own.offset + throughOffset;
  assert.ok(number > throughOffset);
  assert.equal(
    child.calls[1].body.input.at(-1).content,
    `Result of script 1:\n[result ${number}]\n6`,
  );
  assert.deepEqual((await child.state()).lineage, [{ path: PARENT, throughOffset }]);
});

test("a fork of a fork reads its first ancestor's result, and its own numbers come after both offsets", async () => {
  const world = worldOf();
  const parent = await started(world, PARENT, scripted("return 'first';"));
  await parent.say("go");
  const firstResult = parent.durable(`${T}itx/run-settled`)[0].offset;
  const child = await started(world, CHILD, scripted("return 'second';"), true);
  await requestSubagent(world, parent, { path: CHILD, brief: "go on", copyContext: true });
  const [{ throughOffset: one }] = child.durable(`${T}agent/context-copied`)[0].payload.lineage;
  const secondResult = child.durable(`${T}itx/run-settled`)[0].offset + one;
  const grandchild = await started(
    world,
    GRANDCHILD,
    scripted(`return [await result(${firstResult}), await result(${secondResult})];`),
    true,
  );
  await requestSubagent(world, child, { path: GRANDCHILD, brief: "both", copyContext: true });
  const [copied] = grandchild.durable(`${T}agent/context-copied`);
  const lineage = copied.payload?.lineage;
  assert.deepEqual(
    lineage.map((ancestor) => ancestor.path),
    [PARENT, CHILD],
  );
  const two = lineage[1].throughOffset;
  const [own] = grandchild.durable(`${T}itx/run-settled`);
  assert.deepEqual(own.payload?.settlement, { status: "succeeded", result: ["first", "second"] });
  const number = own.offset + one + two;
  assert.match(grandchild.calls[1].body.input.at(-1).content, new RegExp(`\\[result ${number}\\]`));
  // every request of the line carries the first ancestor's key
  assert.equal(grandchild.calls[0].body.prompt_cache_key, PARENT);
});

test("a conversation too large for one fact is copied in several, in the one append, and the child's conversation is the same", async () => {
  // (an agent's state is one storage cell of 2 MB, and a request maker keeps two conversations:
  // so two inputs of 550,000 characters, over the 1,000,000 of one fact together)
  const world = worldOf();
  const parent = await started(world, PARENT, scripted("const a = 1;", "const b = 2;"));
  for (const letter of ["a", "b"]) await parent.say(letter.repeat(550_000));
  const child = await started(world, CHILD, scripted(), true);
  const before = await parent.state();
  await requestSubagent(world, parent, { path: CHILD, copyContext: true });
  const copies = child.durable(`${T}agent/context-copied`);
  assert.deepEqual(
    copies.map((copy) => [copy.payload?.part, copy.payload?.parts]),
    [
      [0, 2],
      [1, 2],
    ],
  );
  assert.equal(child.appends()[0].filter((kind) => kind === "agent/context-copied").length, 2);
  for (const copy of copies) assert.ok(JSON.stringify(copy.payload?.items).length <= 1_000_000);
  assert.deepEqual((await child.state()).copiedItems, before.items);
  // no brief: the copy starts nothing
  assert.equal(child.calls.length, 0);
});
