// agent-kinds/agent.test.mjs — how the kind `agent` (agent.ts) starts an agent (../agent-start.ts),
// its guard, and where the Dash is told of it (index.ts), with a fake `itx`. Run it from the
// config's root with `node --test agent-kinds/agent.test.mjs`.
//
// IT LIVES IN THIS FOLDER, NOT IN THE ROOT: a publish loads every module file in the config's root,
// and a `node:` import there refuses the publish (lint/config-published-modules.test.ts).
//
// The platform's loader makes `import agentFiles from "./agent/"` every file under agent/, by path.
// Node has no such import: the hooks below give the same module.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "./agent/") return next(specifier, context);
    return { url: `${new URL(specifier, context.parentURL).href}?folder`, shortCircuit: true };
  },
  load(url, context, next) {
    if (!url.endsWith("?folder")) return next(url, context);
    const dir = fileURLToPath(url.slice(0, -"?folder".length));
    const files = Object.fromEntries(
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const path = `${entry.parentPath}/${entry.name}`;
          return [`agent/${path.slice(dir.length)}`, readFileSync(path, "utf8")];
        }),
    );
    return {
      format: "module",
      source: `export default ${JSON.stringify(files)};`,
      shortCircuit: true,
    };
  },
});

const { default: agentKind } = await import("./agent.ts");
const { agentKinds } = await import("./index.ts");
const { agentPrompt } = await import("../agent-prompt.ts");

const T = "events.iterate.com/";
/** A fake root: each context's log, and the hosted rows of the contexts that have some. */
function fakeItx(logs = {}, rows = {}) {
  return {
    logs,
    // the config repo, as the prompt reads it: no file
    repos: { get: () => ({ readFile: async () => null }) },
    cd: (path) => ({
      rewriteRules: { list: async () => [] },
      whoami: async () => ({ path }),
      append: async (...events) => {
        (logs[path] ??= []).push(...events);
        return events;
      },
      readEvents: async (after, limit) => ({
        events: (logs[path] ?? []).slice(after, after + limit),
      }),
      waitForEvent: async () => ({}),
      processors: { list: async () => rows[path] ?? [] },
    }),
  };
}

/** What the Dash's New agent does first: it appends the kind's own start fact to the new path. */
async function newAgentFromTheDash(itx, path) {
  const [start, ...more] = agentKind.newAgent.start({ choice: "agent", fields: {}, path });
  assert.deepEqual(more, []);
  await itx.cd(path).append(start);
  await agentKind.processEvent({ event: { ...start, path, offset: 1 }, itx });
  return start;
}

const facetRows = (events) =>
  events.filter((e) => e.type === `${T}itx/subscription-configured` && e.payload.target);
const hasFacetRows = (itx, path) =>
  facetRows(itx.logs[path] ?? []).some((e) => e.payload.name === "agent");

test("the Dash's New agent starts this agent by the kind's own start fact", async () => {
  // the Dash starts the kind whose file says so, on its first choice
  assert.equal(agentKind.newAgent.default, true);
  assert.deepEqual(agentKind.newAgent.choices, [{ id: "agent", label: "Agent", byPerson: true }]);
  const itx = fakeItx();
  const path = "/agents/people/ada/agent/2026-11-23t10-00-00";
  const start = await newAgentFromTheDash(itx, path);
  assert.equal(start.type, `${T}agent-ui/agent-requested`);
  assert.equal(start.idempotencyKey, `agent-ui/agent-requested:${path}`);
  const log = itx.logs[path];
  const configured = log.find((e) => e.type === `${T}agent/configured`);
  assert.equal(configured.payload.kind, "agent");
  assert.deepEqual(
    facetRows(log)
      .map((e) => e.payload.name)
      .filter((name) => !name.startsWith("agent-catalog-")),
    [
      "agent",
      "llm-api-openai-responses",
      "llm-api-anthropic-messages",
      "llm-api-chat-completions",
      "llm-api-google-generate-content",
    ],
  );
  // every fact of the start has a key: a second start writes the same facts, and the log keeps one
  assert.equal(
    log.filter((e) => e !== start).every((e) => typeof e.idempotencyKey === "string"),
    true,
  );
});

test("a person's first words reach the agent when they are handled before the request", async () => {
  // events reach a kind in no order: the log has the request first, the kind sees the words first
  const path = "/agents/people/ada/agent/2026-11-23t10-00-01";
  const [start] = agentKind.newAgent.start({ choice: "agent", fields: {}, path });
  const words = { type: `${T}agent-ui/message-received`, payload: { message: "hello" } };
  const itx = fakeItx({ [path]: [start, words] });
  await agentKind.processEvent({ event: { ...words, path, offset: 2 }, itx });
  assert.equal(hasFacetRows(itx, path), true);
  const added = itx.logs[path].filter((e) => e.type === `${T}agent/context-added`);
  assert.equal(added.length, 1);
  assert.match(JSON.stringify(added[0].payload), /hello/);
  await agentKind.processEvent({ event: { ...start, path, offset: 1 }, itx });
});

test("the platform can load the agent's facets: the folder names the entry module of the facet rows", async () => {
  // a facet row's source is the folder agent/ of the config repo, and the platform reads the entry
  // module from that folder's package.json: without it no facet loads, and the agent never answers
  const manifest = JSON.parse(
    readFileSync(new URL("../agent/package.json", import.meta.url), "utf8"),
  );
  const itx = fakeItx();
  const path = "/agents/people/ada/agent/2026-11-23t10-00-02";
  await newAgentFromTheDash(itx, path);
  const entries = facetRows(itx.logs[path])
    .filter((row) => !row.payload.name.startsWith("agent-catalog-"))
    .map((row) => row.payload.target[2][2].mainModule);
  assert.equal(entries.length, 5);
  assert.deepEqual([...new Set(entries)], [manifest.main]);
  assert.equal(readdirSync(new URL("../agent/", import.meta.url)).includes(manifest.main), true);
});

test("a new agent gets its system prompt once it starts, and a fork gets none", async () => {
  const itx = fakeItx();
  const path = "/agents/people/ada/agent/2026-11-23t10-00-03";
  await newAgentFromTheDash(itx, path);
  // the start's own fact, as every-event.ts hands it to the hook
  const started = itx.logs[path].find((e) => e.type === `${T}agent/configured`);
  assert.equal(started.payload.kind, "agent");
  await agentPrompt(itx, { ...started, path });
  const prompts = itx.logs[path].filter(
    (e) => e.type === `${T}agent/configured` && typeof e.payload.config?.instructions === "string",
  );
  assert.equal(prompts.length, 1);
  // the prompt says how words reach the person
  assert.match(prompts[0].payload.config.instructions, /agent-ui\/message-sent/);
  // a fork's start brings its parent's instructions: no prompt of its own
  const fork = "/agents/people/ada/agent/2026-11-23t10-00-03/fork";
  await agentPrompt(itx, {
    type: `${T}agent/configured`,
    path: fork,
    payload: { kind: "agent", config: { instructions: "the parent's" } },
  });
  assert.equal(itx.logs[fork], undefined);
  // every agent of the mind is this agent, at any path: the onboarding agent gets its prompt too
  await agentPrompt(itx, {
    type: `${T}agent/configured`,
    path: "/agents/onboarding",
    payload: { kind: "agent", config: {} },
  });
  assert.match(
    itx.logs["/agents/onboarding"][0].payload.config.instructions,
    /You are the agent at \/agents\/onboarding/,
  );
  // a config fact that is no start (a later patch, another kind's) gets none
  await agentPrompt(itx, {
    type: `${T}agent/configured`,
    path: "/agents/x",
    payload: { config: {} },
  });
  assert.equal(itx.logs["/agents/x"], undefined);
});

test("the kind acts where the agent runs, at any path, and nowhere else", async () => {
  const words = [
    [`${T}agent-ui/message-received`, { message: "hello" }],
    [`${T}agent/message-received`, { message: "hello" }],
  ];
  // NOWHERE ELSE: a context that runs another kind of agent, or none, gets nothing
  const other = fakeItx(
    { "/agents/claude/s1": [{ type: `${T}claude/session-started`, payload: {} }] },
    { "/agents/claude/s1": [{ name: "claude", hostedFacet: { className: "ClaudeFacet" } }] },
  );
  for (const path of ["/agents/claude/s1", "/agents/nobody"])
    for (const [type, payload] of [
      ...words,
      [`${T}agent/subagent-requested`, { path: `${path}/job`, brief: "go" }],
    ])
      await agentKind.processEvent({ event: { type, path, offset: 2, payload }, itx: other });
  assert.equal(other.logs["/agents/claude/s1"].length, 1);
  assert.equal(other.logs["/agents/nobody"], undefined);
  assert.equal(other.logs["/agents/nobody/job"], undefined);

  // AN AGENT THAT `itx.agents.create` STARTED, at any path: its start facts are its first facts
  const { startEvents } = await import("../agent-start.ts");
  const created = "/agents/onboarding";
  const itx = fakeItx({ [created]: await startEvents(created, { parent: "/" }) });
  for (const [type, payload] of words)
    await agentKind.processEvent({ event: { type, path: created, offset: 20, payload }, itx });
  // the two raw facts have the same offset here, so their transcriptions have two keys
  assert.equal(itx.logs[created].filter((e) => e.type === `${T}agent/context-added`).length, 2);

  // A TAKE-OVER: the platform's old agent ran here, so the start facts stand at the END of a long
  // log, past the first facts. The row `agent` says that this agent runs here now.
  const old = "/agents/email/t12";
  const long = Array.from({ length: 150 }, () => ({
    type: `${T}agent/context-added`,
    payload: {},
  }));
  const taken = fakeItx(
    { [old]: [{ type: `${T}agent/create-requested`, payload: {} }, ...long] },
    { [old]: [{ name: "agent", hostedFacet: { className: "AgentFacet" } }] },
  );
  await agentKind.processEvent({
    event: { type: words[1][0], path: old, offset: 152, payload: words[1][1] },
    itx: taken,
  });
  const landed = taken.logs[old].slice(151);
  assert.equal(landed.at(-1).type, `${T}agent/context-added`);
  assert.match(landed.at(-1).payload.content, /^hello/);
  // the words come with the start facts, and with NO parent link: the link of its birth stands
  assert.equal(
    landed.some((e) => e.type === `${T}agent/configured`),
    true,
  );
  assert.equal(
    landed.some((e) => e.type === `${T}itx/rewrite-rule-configured`),
    false,
  );
  // a row `agent` of the platform's old class is not this agent
  const stillOld = fakeItx(
    { [old]: [{ type: `${T}agent/create-requested`, payload: {} }] },
    { [old]: [{ name: "agent", hostedFacet: { className: "AgentDurableObject" } }] },
  );
  await agentKind.processEvent({
    event: { type: words[1][0], path: old, offset: 2, payload: words[1][1] },
    itx: stillOld,
  });
  assert.equal(stillOld.logs[old].length, 1);
});

test("the Dash gives birth to an agent with a link to the root; a subagent is linked to its parent", async () => {
  const itx = fakeItx();
  const parent = "/agents/people/ada/agent/2026-11-23t10-00-04";
  await newAgentFromTheDash(itx, parent);
  const linkOf = (path) =>
    itx.logs[path].find((e) => e.type === `${T}itx/rewrite-rule-configured`).payload.target;
  assert.equal(linkOf(parent), 'itx.cd("/")');
  await agentKind.processEvent({
    event: {
      type: `${T}agent/subagent-requested`,
      path: parent,
      offset: 50,
      payload: { path: `${parent}/job`, brief: "go" },
    },
    itx,
  });
  assert.equal(linkOf(`${parent}/job`), `itx.cd(${JSON.stringify(parent)})`);
});

test("a subagent goes under its parent's own path, never onto another agent", async () => {
  const itx = fakeItx();
  const parent = "/agents/people/ada/agent/2026-11-23t10-00-00";
  await newAgentFromTheDash(itx, parent);
  const request = (offset, path) =>
    agentKind.processEvent({
      event: { type: `${T}agent/subagent-requested`, path: parent, offset, payload: { path } },
      itx,
    });
  await request(100, "/agents/onboarding");
  await request(101, `${parent}/research`);
  assert.equal(itx.logs["/agents/onboarding"], undefined);
  assert.equal(hasFacetRows(itx, `${parent}/research`), true);
  const answers = itx.logs[parent].filter((e) => e.type.startsWith(`${T}agent/subagent-`));
  assert.deepEqual(
    answers.map((e) => e.type.slice(T.length)),
    ["agent/subagent-failed", "agent/subagent-started"],
  );
});

test("the mind runs one kind of agent, and the Dash is told of its file", () => {
  assert.deepEqual(
    agentKinds.map((kind) => kind.path.split("/").at(-1).replace(/\.js$/, ".ts")),
    ["agent.ts"],
  );
});
