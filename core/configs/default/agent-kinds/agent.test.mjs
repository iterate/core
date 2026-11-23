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
const { kindsForTheDash } = await import("./index.ts");

const T = "events.iterate.com/";
/** A fake root: each context's log. */
function fakeItx(logs = {}) {
  return {
    logs,
    cd: (path) => ({
      append: async (...events) => {
        (logs[path] ??= []).push(...events);
        return events;
      },
      readEvents: async (after, limit) => ({
        events: (logs[path] ?? []).slice(after, after + limit),
      }),
      waitForEvent: async () => ({}),
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

test("the kind does nothing on the onboarding agent or on any agent of the platform", async () => {
  const platformChat = "/agents/people/ada/web/2026-11-01t09-00-00";
  const itx = fakeItx({
    // the platform's agent: its own birth, and no start of this agent
    [platformChat]: [{ type: `${T}agent/create-requested`, payload: {} }],
    "/agents/onboarding": [{ type: `${T}agent/create-requested`, payload: {} }],
  });
  const facts = [
    [`${T}agent-ui/agent-requested`, {}],
    [`${T}agent-ui/message-received`, { message: "hello" }],
    [`${T}agent/message-received`, { message: "hello" }],
    [`${T}agent/subagent-requested`, { path: "/agents/onboarding/job", brief: "go" }],
  ];
  for (const path of ["/agents/onboarding", "/agents/onboarding/job", "/agents/mail/ada/x"])
    for (const [type, payload] of facts)
      await agentKind.processEvent({ event: { type, path, offset: 1, payload }, itx });
  for (const [type, payload] of facts.slice(1))
    await agentKind.processEvent({ event: { type, path: platformChat, offset: 1, payload }, itx });
  for (const path of Object.keys(itx.logs)) assert.equal(hasFacetRows(itx, path), false, path);
  assert.equal(itx.logs[platformChat].length, 1);
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

test("the Dash is told of the kind agent in a new mind only, and the choice is kept", async () => {
  const CHOICE = "config:new-chats-are-the-agent";
  const mind = (entries) => {
    const kept = new Map(Object.entries(entries));
    return {
      kept,
      kv: {
        get: async (key) => kept.get(key) ?? null,
        put: async (key, value) => void kept.set(key, value),
      },
    };
  };
  const kinds = (...names) =>
    JSON.stringify(Object.fromEntries(names.map((name) => [name, `agent-kinds/${name}.ts`])));
  /** The kinds init.ts tells the Dash of, by file name. */
  const told = async (itx) =>
    (await kindsForTheDash(itx)).map((kind) => kind.path.split("/").at(-1).replace(/\.js$/, ".ts"));
  // a mind's first publish: the Dash was never told of a kind
  const fresh = mind({});
  assert.deepEqual(await told(fresh), ["iterate.ts", "agent.ts"]);
  assert.equal(fresh.kept.get(CHOICE), "yes");
  // a mind that existed before this kind: it told the Dash its kinds, and `agent` was not one
  const older = mind({ "agent-kinds": kinds("iterate") });
  assert.deepEqual(await told(older), ["iterate.ts"]);
  assert.equal(older.kept.get(CHOICE), "no");
  // a mind that was born with this kind, before the choice was kept
  const born = mind({ "agent-kinds": kinds("iterate", "agent") });
  assert.deepEqual(await told(born), ["iterate.ts", "agent.ts"]);
  // the choice is kept: a new mind's second publish, after the first wrote a list
  fresh.kept.set("agent-kinds", kinds("iterate"));
  assert.deepEqual(await told(fresh), ["iterate.ts", "agent.ts"]);
  // an owner's own choice stands
  older.kept.set(CHOICE, "yes");
  assert.deepEqual(await told(older), ["iterate.ts", "agent.ts"]);
  // a list that cannot be read is an older mind's
  assert.deepEqual(await told(mind({ "agent-kinds": "not json" })), ["iterate.ts"]);
});
