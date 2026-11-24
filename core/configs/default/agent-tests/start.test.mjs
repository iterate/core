// start.test.mjs: the start facts of an agent. Their order and keys, the parent link that is written
// at the agent's birth alone, and on the platform's in-memory log, that two starts write each fact
// once. The copy facts of a forked subagent: parts and lineage.
//
// Run from the config's root: node --test "agent-tests/*.test.mjs"

import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStream } from "iterate/stream/test-support";
import { agentStartEvents, contextCopiedEvents, COPY_PART_MAX_CHARS } from "../agent/start.ts";

const T = "events.iterate.com/";
const PATH = "/agents/ada";
const SOURCE = ["itx", ["cd", "/"], "repos", ["get", "/repos/config"], ["modules", {}]];

function options(change = {}) {
  return {
    parent: "/",
    config: { llm: { model: "openai/gpt-6.2-sol" } },
    facets: [
      { name: "slack", className: "SlackFacet", consumes: [] },
      { name: "agent", className: "AgentFacet", consumes: [`${T}agent/context-added`] },
    ],
    code: { source: SOURCE, mainModule: "facets.ts", cacheKey: "agent:abc" },
    rows: [
      { name: "catalog-kind", consumes: [`${T}agent/configured`], target: { path: "/agents" } },
    ],
    ...change,
  };
}

test("the events and their order: parent link, rows, config, facets as the caller gives them", async () => {
  const events = await agentStartEvents(PATH, options());
  assert.deepEqual(
    events.map((event) => event.type.replace(T, "")),
    [
      "itx/rewrite-rule-configured",
      "itx/subscription-configured",
      "agent/configured",
      "itx/subscription-configured",
      "itx/subscription-configured",
    ],
  );
  const [parent, row, configured, first, second] = events;
  assert.deepEqual(parent.payload, { match: "itx", target: 'itx.cd("/")' });
  assert.equal(parent.idempotencyKey, `agent-parent:${PATH}`);
  assert.match(row.idempotencyKey, /^agent-row:catalog-kind:\/agents\/ada:[0-9a-f]{12}$/);
  assert.deepEqual(row.payload, options().rows[0]);
  assert.match(configured.idempotencyKey, /^agent-configured:\/agents\/ada:[0-9a-f]{16}$/);
  assert.equal(first.payload.name, "slack");
  assert.equal(first.idempotencyKey, `agent-facet:slack:${PATH}:agent:abc`);
  assert.deepEqual(second.payload, {
    name: "agent",
    target: [
      "itx",
      "facets",
      [
        "get",
        "agent",
        {
          source: SOURCE,
          cacheKey: "agent:abc",
          className: "AgentFacet",
          mainModule: "facets.ts",
        },
      ],
      "processEventBatch",
    ],
    consumes: [`${T}agent/context-added`],
  });
});

test("the config is written as given, with the kind that marks the start; with none, it is empty", async () => {
  const [, , configured] = await agentStartEvents(PATH, options());
  assert.deepEqual(configured.payload, {
    kind: "agent",
    config: { llm: { model: "openai/gpt-6.2-sol" } },
  });

  const bare = await agentStartEvents(PATH, { facets: [], code: options().code });
  assert.deepEqual(
    bare.map((event) => event.payload),
    [{ kind: "agent", config: {} }],
  );
  assert.match(bare[0].idempotencyKey, /^agent-configured:\/agents\/ada:[0-9a-f]{16}$/);
});

test("the parent link: none with no parent, and one fact under the path's key for the root or for another agent", async () => {
  const linkOf = async (parent) =>
    (await agentStartEvents(PATH, options({ parent }))).filter(
      (event) => event.type === `${T}itx/rewrite-rule-configured`,
    );
  assert.deepEqual(await linkOf(undefined), [], "a later start names no parent");
  const [toCreator, ...more] = await linkOf("/agents/people/grace/agent/one");
  assert.deepEqual(more, []);
  assert.deepEqual(toCreator.payload, {
    match: "itx",
    target: 'itx.cd("/agents/people/grace/agent/one")',
  });
  // the key holds the path alone: the first link stands, whatever a later start names
  assert.equal(toCreator.idempotencyKey, `agent-parent:${PATH}`);
  assert.equal((await linkOf("/"))[0].idempotencyKey, `agent-parent:${PATH}`);
  for (const parent of ["agents/ada", "/agents/", "/a b", "itx.cd('/')"])
    await assert.rejects(
      agentStartEvents(PATH, options({ parent })),
      /an agent's parent is a context/,
    );
});

test("the same input gives the same keys; a change gives a new key for its event only", async () => {
  const keys = async (o) => (await agentStartEvents(PATH, o)).map((event) => event.idempotencyKey);
  const base = await keys(options());
  assert.deepEqual(await keys(options()), base);
  const differ = (other) => other.flatMap((key, index) => (key === base[index] ? [] : [index]));

  assert.deepEqual(differ(await keys(options({ config: { llm: { model: "x/y" } } }))), [2]);
  assert.deepEqual(
    differ(await keys(options({ code: { ...options().code, cacheKey: "agent:def" } }))),
    [3, 4],
    "a new version of the code: each facet's row",
  );
  assert.deepEqual(
    differ(await keys(options({ rows: [{ ...options().rows[0], filter: "true" }] }))),
    [1],
  );
});

test("a path that is not a context path is refused", async () => {
  for (const path of ["", "agents/ada", "/", "/agents/", "/agents/ada smith", "/-x", "/a//b"])
    await assert.rejects(agentStartEvents(path, options()), /an agent runs on a context/);
});

test("on the in-memory log, two starts write each fact once", async () => {
  const log = memoryStream(PATH);
  const events = await agentStartEvents(PATH, options());
  await log.stream.append(...events);
  await log.stream.append(...(await agentStartEvents(PATH, options())));
  assert.equal(log.events.length, events.length);
  // a new config in the same batch: only the config is written again
  await log.stream.append(...(await agentStartEvents(PATH, options({ config: {} }))));
  assert.equal(log.events.length, events.length + 1);
  assert.equal(log.events.at(-1).type, `${T}agent/configured`);
});

test("on the in-memory log, a later start with no parent writes no link, and one that names another parent is refused whole", async () => {
  const log = memoryStream(PATH);
  const birth = await agentStartEvents(PATH, options({ parent: "/agents/creator" }));
  await log.stream.append(...birth);
  const links = () =>
    log.events.filter((event) => event.type === `${T}itx/rewrite-rule-configured`);
  assert.equal(links().length, 1);

  // a new version of the code, sent with no parent: its rows are written, and the link stands
  const later = options({ parent: undefined, code: { ...options().code, cacheKey: "agent:def" } });
  await log.stream.append(...(await agentStartEvents(PATH, later)));
  assert.equal(log.events.length, birth.length + 2);
  assert.equal(links().length, 1);

  // a start that names the root for an agent whose parent is another agent: nothing of it is written
  const before = log.events.length;
  const input = { type: `${T}agent/context-added`, payload: { role: "user", content: "hello" } };
  const relinked = await agentStartEvents(PATH, options({ parent: "/", config: { other: 1 } }));
  await assert.rejects(
    async () => await log.stream.append(...relinked, input),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(log.events.length, before);
  assert.deepEqual(links()[0].payload, { match: "itx", target: 'itx.cd("/agents/creator")' });
});

test("the copy of a conversation: its parts in order, each under the limit, the lineage after the parent's, and keys that name the request", () => {
  const item = (text) => ({ atOffset: 1, rank: 0, tag: "words", role: "user", text });
  const items = [item("a".repeat(600_000)), item("b".repeat(600_000)), item("c")];
  const ancestor = { path: "/agents/first", throughOffset: 9 };
  const parent = { path: PATH, throughOffset: 40, lineage: [ancestor], items };
  const events = contextCopiedEvents(parent, `${PATH}@38`);
  assert.deepEqual(
    events.map((event) => [event.idempotencyKey, event.payload.part, event.payload.parts]),
    [
      [`agent/context-copied:${PATH}@38:0`, 0, 2],
      [`agent/context-copied:${PATH}@38:1`, 1, 2],
    ],
  );
  for (const event of events) {
    assert.ok(JSON.stringify(event.payload.items).length <= COPY_PART_MAX_CHARS);
    assert.deepEqual(event.payload.lineage, [ancestor, { path: PATH, throughOffset: 40 }]);
  }
  assert.deepEqual(
    events.flatMap((event) => event.payload.items),
    items,
  );
  // an empty conversation is one part: the lineage is written
  const [empty] = contextCopiedEvents({ ...parent, items: [] }, "k");
  assert.deepEqual(empty.payload, {
    lineage: [ancestor, { path: PATH, throughOffset: 40 }],
    part: 0,
    parts: 1,
    items: [],
  });
});
