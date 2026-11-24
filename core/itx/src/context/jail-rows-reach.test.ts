// WHAT A SCRIPT IN A USERLAND JAIL REACHES, by the real resolver (./itx-expression-rewriting.ts).
// The rows are those a config writes for a jail (`jailRowsOf`, `jailAgent`) and for a child path
// that holds an agent's scripts (`cloudMindRows`, `cloudScriptRows`).
//
// THE JAIL'S FORM: the agent's own context is NOT masked. It keeps its parent link, and one row,
// `itx.run => itx.cd(<jail>).run`, sends its scripts to a context of the jail's own, whose table
// starts with the bare `itx => null`. A script is loaded code of that context
// (../iterate-context.ts `ItxEntrypoint`, bound to it by a prop that the host mints).
import {
  InvokeHandle,
  itxExpressionStepName,
  normalizedItxExpression,
  print,
  type ItxExpressionInput,
} from "iterate/expression";
import { expect, test } from "vitest";
import type { Caller } from "../caller.ts";
import { defineItxHost } from "../host.ts";
import {
  entersOwnRoot,
  type ItxExpressionRewriteRule,
  ItxExpressionResolver,
  normalizeRewriteRuleConfigured,
} from "./itx-expression-rewriting.ts";

const REFUSED = "refused";
const AGENT = "/agents/voice/phone-1";
const JAIL = "/jails/outside-callers/aaaaaaaaaaaa/bbbbbbbbbbbb";
const X_AGENT = "/agents/x-posts/1";
const X_JAIL = "/jails/x-posts/aaaaaaaaaaaa/cccccccccccc";
const CLOUD_MIND = "/apps/cloud/minds/mind_aaaaaaaaaaaaaaaaaaaa";
const CLOUD_SCRIPTS = `${CLOUD_MIND}/scripts`;

test("the agent's own context sends each script to its jail: `itx.run` there resolves to the jail's run, and the run lands on the jail", async () => {
  const mind = mindWithJails();
  expect(mind.resolved(AGENT, "itx.run('s')")).toBe(`itx.builtins.cd('${JAIL}').run('s')`);
  expect(await mind.live(AGENT, "itx.run('s')")).toBe(`${JAIL}: run("s")`);
});

test("the jail gives back exactly its rows: a run in the jail, the group's fetch, the agent's own log, the three appends through the config, the files of its own results", async () => {
  const mind = mindWithJails();
  const config = '/: facets.get("config")';
  expect(await mind.script(JAIL, "itx.run('s')")).toBe(`${JAIL}: run("s")`);
  expect(await mind.script(JAIL, "itx.fetch('u')")).toBe(
    `${config}.jailFetch("outside-callers", "u")`,
  );
  expect(await mind.script(JAIL, `itx.cd("${AGENT}").readEvents(0)`)).toBe(
    `${AGENT}: readEvents(0)`,
  );
  expect(await mind.script(JAIL, `itx.cd("${AGENT}").append({})`)).toBe(
    `${config}.jailAppend("outside-callers", "${AGENT}", {})`,
  );
  expect(await mind.script(JAIL, "itx.files.get('p')")).toBe(
    `${config}.jailFile("outside-callers", "${AGENT}", "p")`,
  );
  // a row's name is a prefix: steps after it are called on what the config's function answers
  // (jail.ts `JailFile` has `bytes()` alone)
  expect(await mind.script(JAIL, "itx.files.get('p').put({})")).toBe(
    `${config}.jailFile("outside-callers", "${AGENT}", "p").put({})`,
  );
  // a group's tool, as jail-groups.ts `x-posts` names it
  expect(await mind.script(X_JAIL, "itx.xPosts.mx('p', {})")).toBe(
    `${config}.xPosts("mx", "p", {})`,
  );
});

test("(a) A SCRIPT IN THE JAIL ENTERS NO OTHER CONTEXT AND MAKES NONE: every `cd` but the two of its rows is refused, a child of the jail and a child of the agent too", async () => {
  const mind = mindWithJails();
  for (const call of [
    // a child of the jail, by each spelling
    "itx.cd('./child').append({})",
    "itx.cd('child').run('s')",
    `itx.cd("${JAIL}/child").run('s')`,
    `itx.cd("${JAIL}").cd('child').run('s')`,
    // the root, a sibling, the agents' base
    "itx.cd('/').secrets.list()",
    "itx.cd('/').config.x()",
    "itx.cd('..').readEvents(0)",
    "itx.cd('/agents').readEvents(0)",
    "itx.cd('/agents/coding-chief-of-staff').readEvents(0)",
    // the agent's own context, by any verb but the two of the rows
    `itx.cd("${AGENT}")`,
    `itx.cd("${AGENT}").run('s')`,
    `itx.cd("${AGENT}").appendOffsets({})`,
    `itx.cd("${AGENT}").rewriteRules.list()`,
    `itx.cd("${AGENT}").facets.get('agent').snapshot()`,
    `itx.cd("${AGENT}").processors.enable('p', {})`,
    `itx.cd("${AGENT}").subscriptions.list()`,
    `itx.cd("${AGENT}").schedules.set({})`,
    `itx.cd("${AGENT}").workers.get({}).run()`,
    `itx.cd("${AGENT}").fetch('u')`,
    `itx.cd("${AGENT}").secrets.list()`,
    `itx.cd("${AGENT}").cd('/').secrets.list()`,
    `itx.cd("${AGENT}").cd('child').append({})`,
    // another spelling of the agent's path, and a child of the agent
    `itx.cd("${AGENT}/").readEvents(0)`,
    `itx.cd("${AGENT}/child").readEvents(0)`,
    `itx.cd("${AGENT}", "x").readEvents(0)`,
    // every root that makes a context or runs code in one
    "itx.agents.create('/agents/x')",
    "itx.agents.get('/agents/coding-chief-of-staff').message('m')",
    "itx.sandboxes.create('/sandboxes/x')",
    "itx.workers.get({}).run()",
    "itx.processors.enable('p', {})",
    "itx.facets.get('f', {}).x()",
    "itx.repos.get('/repos/config').files()",
  ])
    expect(await mind.script(JAIL, call), call).toBe(REFUSED);
});

test("(c) a script in the jail reaches none of the roots that the jail masks: secrets, mail, the config, files, minds, its own table and log", async () => {
  const mind = mindWithJails();
  for (const call of [
    "itx.secrets.list()",
    "itx.secrets.get('/secrets/openai')",
    "itx.email.send({})",
    "itx.config.x()",
    "itx.files.list('/')",
    "itx.r2.get('k')",
    "itx.kv.get('k')",
    "itx.contexts.list({})",
    "itx.minds.get('peer').deliverEvents([])",
    "itx.webhooks.get({}).deliverEvent({})",
    "itx.url({})",
    "itx.whoami()",
    "itx.append({})",
    "itx.appendOffsets({})",
    "itx.readEvents(0)",
    "itx.rewriteRules.list()",
    "itx.rpcStubs.list()",
    "itx.subscriptions.list()",
    "itx.schedules.set({})",
    "itx.abort()",
    // the fixed point is no loaded code's word (FORBIDDEN, by the wall on its input)
    "itx.builtins.cd('/').secrets.list()",
    "itx.builtins.append({})",
  ])
    expect(await mind.script(JAIL, call), call).toMatch(/^(refused|forbidden)$/);
});

test("a host's root of every context, with `fetch` as the last step, meets the jail's own mask: `itx.minds…fetch`, `itx.webhooks…fetch` and `itx.url…fetch` are refused (loaded code sends such a call to the stateless resolver, which reads the context's snapshot)", async () => {
  const mind = mindWithJails();
  for (const jail of [JAIL, X_JAIL, CLOUD_SCRIPTS]) {
    for (const call of [
      "itx.minds.get('peer').fetch()",
      "itx.webhooks.get({}).fetch()",
      "itx.url.fetch()",
      "itx.minds.get('peer').deliverEvents([])",
    ])
      expect(await mind.script(jail, call), `${jail} ${call}`).toBe(REFUSED);
  }
  // a context with no mask of these names still reaches them, with no row of its own
  expect(await mind.script(AGENT, "itx.minds.get('peer').fetch()")).toBe(
    `${AGENT}: minds.get("peer").fetch()`,
  );
});

test("A FETCH WITH A SECOND ARGUMENT (a signed fetch: the caller's own `itx.fetch(request, { signFor })`) meets the jail's row for itx.fetch, and `@` hands on BOTH arguments", async () => {
  const mind = mindWithJails();
  const config = '/: facets.get("config")';
  // jail.ts `jailFetch(group, ...args)` then builds `new Request(...args)`
  expect(await mind.script(JAIL, "itx.fetch('u', { signFor: 'peer' })")).toBe(
    `${config}.jailFetch("outside-callers", "u", {"signFor":"peer"})`,
  );
  expect(await mind.script(CLOUD_SCRIPTS, "itx.fetch('u', { signFor: 'peer' })")).toBe(REFUSED);
  // … and `new Request(input, init)` drops a key of `init` that it does not know: what jailFetch
  // sends on to the root's itx.fetch is one Request, with no `signFor`
  const built = new Request("https://peer.example/who", { signFor: "peer" } as RequestInit);
  expect(Reflect.get(built, "signFor")).toBeUndefined();
});

test("how each form of a row hands a second argument on: a row with no `@` and a row with a whole `@` pass both; a row with `@` inside an object refuses a call of two arguments", async () => {
  const withRow = (target: string) =>
    mindWithJails({ [JAIL]: [row("itx", null), row("itx.fetch", target)] });
  const call = "itx.fetch('u', { signFor: 'peer' })";
  // gives the built-in back: both arguments reach it (a stateless resolver walks a portable root)
  expect(await withRow("itx.builtins.fetch").script(JAIL, call)).toBe(
    `${JAIL}: fetch("u", {"signFor":"peer"})`,
  );
  expect(await withRow("itx.builtins.cd('/').config.egress('pinned', @)").script(JAIL, call)).toBe(
    '/: facets.get("config").egress("pinned", "u", {"signFor":"peer"})',
  );
  await expect(
    withRow("itx.builtins.cd('/').config.egress({ request: @ })").script(JAIL, call),
  ).rejects.toThrow("takes exactly one argument, got 2");
});

test("a mask of itx.minds stops a signed fetch spelled `itx.minds.get(peer).fetch(request)` by loaded code, while the jail's own `itx.fetch(request, { signFor })` meets its row for itx.fetch", async () => {
  // a jail that masks everything and gives the built-in fetch back: `itx.minds` is masked there
  const mind = mindWithJails({
    [JAIL]: [row("itx", null), row("itx.fetch", "itx.builtins.fetch")],
  });
  expect(await mind.script(JAIL, "itx.minds.get('peer').deliverEvents([])")).toBe(REFUSED);
  expect(await mind.script(JAIL, "itx.minds.get('peer').fetch('u')")).toBe(REFUSED);
  expect(await mind.script(JAIL, "itx.fetch('u', { signFor: 'peer' })")).toBe(
    `${JAIL}: fetch("u", {"signFor":"peer"})`,
  );
});

test("the Cloud's scripts context is a CHILD PATH of its agent's context, and holds by its own bare null: the parent's rows are not asked, and it reaches itx.cloud and its rows alone", async () => {
  const mind = mindWithJails();
  const cloud = `/: facets.get("config").cloudMind("${CLOUD_MIND}")`;
  expect(mind.resolved(CLOUD_MIND, "itx.run('s')")).toBe(
    `itx.builtins.cd('${CLOUD_SCRIPTS}').run('s')`,
  );
  expect(await mind.script(CLOUD_SCRIPTS, "itx.cloud.deploy({})")).toBe(`${cloud}.deploy({})`);
  expect(await mind.script(CLOUD_SCRIPTS, `itx.cd("${CLOUD_MIND}").readEvents(0)`)).toBe(
    `${CLOUD_MIND}: readEvents(0)`,
  );
  expect(await mind.script(CLOUD_SCRIPTS, `itx.cd("${CLOUD_MIND}").append({})`)).toBe(
    `${cloud}.envelopeAppend({})`,
  );
  for (const call of [
    "itx.fetch('u')",
    "itx.secrets.describe('/secrets/openai')",
    "itx.cd('..').fetch('u')",
    `itx.cd("${CLOUD_MIND}").fetch('u')`,
    `itx.cd("${CLOUD_MIND}").run('s')`,
    "itx.cd('./child').append({})",
    "itx.cd('/').secrets.list()",
    "itx.append({})",
    "itx.workers.get({}).run()",
    "itx.sandboxes.get('/apps/cloud/sandboxes/x').exec([])",
  ])
    expect(await mind.script(CLOUD_SCRIPTS, call), call).toBe(REFUSED);
});

test("the agent's OWN context is no jail: its own code (the agent's loop, a processor) keeps the mind's whole reach, so the jail holds only while every script goes through the `itx.run` row", async () => {
  const mind = mindWithJails();
  expect(await mind.script(AGENT, "itx.cd('/').secrets.list()")).toBe(`${AGENT}: secrets.list()`);
  expect(await mind.script(AGENT, "itx.secrets.list()")).toBe(`${AGENT}: secrets.list()`);
  // before the row is written (jail.ts `jailAgent`), a script of the agent runs at the agent
  const before = mindWithJails({ [AGENT]: [linkTo("/")] });
  expect(before.resolved(AGENT, "itx.run('s')")).toBe("itx.builtins.run('s')");
});

// ---------------------------------------------------------------------------------------------

const linkTo = (parent: string) => row("itx", `itx.builtins.cd(${JSON.stringify(parent)})`);
/** A row as the reduce stores it, from the payload of a `rewrite-rule-configured`. */
function row(match: string, target: string | null): ItxExpressionRewriteRule {
  return normalizeRewriteRuleConfigured({ match, target });
}

/** A config's `jailRowsOf(name, group, agent)`: the bare null, then what the jail gives back. */
function jailRowsOf(name: string, agent: string, tools: Record<string, string> = {}) {
  const n = JSON.stringify(name);
  const a = JSON.stringify(agent);
  return [
    row("itx", null),
    row("itx.run", "itx.builtins.run"),
    row("itx.fetch", `itx.builtins.cd("/").config.jailFetch(${n}, @)`),
    row(`itx.cd(${a}).readEvents`, `itx.builtins.cd(${a}).readEvents`),
    row(`itx.cd(${a}).append`, `itx.builtins.cd("/").config.jailAppend(${n}, ${a}, @)`),
    row("itx.files.get", `itx.builtins.cd("/").config.jailFile(${n}, ${a}, @)`),
    ...Object.entries(tools).map(([tool, target]) => row(`itx.${tool}`, target)),
  ];
}

/** What core/lib/src/agents/collection.ts `create` writes on an agent that the root's `itx.agents`
 *  made, and jail.ts `jailAgent` after it. */
const agentRowsOf = (agent: string, jail: string) => [
  linkTo("/"),
  row("itx.agents", `itx.cd('/').agents.at(${JSON.stringify(agent)})`),
  row("itx.run", `itx.cd(${JSON.stringify(jail)}).run`),
];

/** An agent whose scripts run at a child path of its own, held by that path's bare null. */
const cloudMindOf = `itx.builtins.cd("/").config.cloudMind(${JSON.stringify(CLOUD_MIND)})`;
const cloudMindRows = [
  linkTo("/"),
  row("itx.run", `itx.cd(${JSON.stringify(CLOUD_SCRIPTS)}).run`),
  row("itx.fetch", `${cloudMindOf}.fetch(@)`),
  row("itx.secrets.describe", `${cloudMindOf}.describeSecret(@)`),
  row("itx.files.get", `${cloudMindOf}.file(@)`),
];
const cloudScriptRows = [
  row("itx", null),
  row("itx.run", "itx.builtins.run"),
  row("itx.cloud", cloudMindOf),
  row(
    `itx.cd(${JSON.stringify(CLOUD_MIND)}).readEvents`,
    `itx.builtins.cd(${JSON.stringify(CLOUD_MIND)}).readEvents`,
  ),
  row(`itx.cd(${JSON.stringify(CLOUD_MIND)}).append`, `${cloudMindOf}.envelopeAppend(@)`),
  row("itx.files.get", `${cloudMindOf}.file(@)`),
];

// As core/mind-worker/src/itx-host.ts registers them: at the root alone, or at every context.
const HOST_ROOTS = {
  secrets: false,
  kv: false,
  r2: false,
  email: false,
  url: true,
  webhooks: true,
  minds: true,
};
defineItxHost({
  firstPartyFacets: {},
  roots: Object.fromEntries(
    Object.entries(HOST_ROOTS).map(([name, everyContext]) => [
      name,
      { description: name, build: () => ({}), everyContext },
    ]),
  ),
});

const KERNEL_ROOTS = [
  "append",
  "appendOffsets",
  "abort",
  "newVersion",
  "schedules",
  "readEvents",
  "waitForEvent",
  "rpcStubs",
  "rewriteRules",
  "contexts",
  "facets",
  "subscriptions",
  "processors",
  "fetchRoutes",
  "whoami",
];
// ./built-ins.ts `buildPortableBuiltIns` and `buildIdentityRoots`: what a stateless resolver has
const PORTABLE = ["fetch", "run", "whoami", ...Object.keys(HOST_ROOTS)];

/** A mind with jails, as these tests need it: the root's names that are rules (`itx.config` and the
 *  library's), an outside caller's agent and its jail, a post's agent and its jail, and one mind
 *  of the Cloud's with its scripts' context. */
function mindWithJails(over: Record<string, ItxExpressionRewriteRule[]> = {}) {
  const tables: Record<string, ItxExpressionRewriteRule[]> = {
    "/": ["config", "files", "agents", "sandboxes", "repos"].map((name) =>
      row(`itx.${name}`, `itx.builtins.facets.get(${JSON.stringify(name)})`),
    ),
    [AGENT]: agentRowsOf(AGENT, JAIL),
    [JAIL]: jailRowsOf("outside-callers", AGENT),
    [X_AGENT]: agentRowsOf(X_AGENT, X_JAIL),
    [X_JAIL]: jailRowsOf("x-posts", X_AGENT, {
      "xPosts.mx": 'itx.builtins.cd("/").config.xPosts("mx", @)',
    }),
    [CLOUD_MIND]: cloudMindRows,
    [CLOUD_SCRIPTS]: cloudScriptRows,
    ...over,
  };
  const rowsOf = (path: string) => tables[path] ?? [];
  let ran: string[] = [];
  const recorder = (label: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) =>
        typeof key === "string" && key !== "then" ? recorder(`${label}.${key}`) : undefined,
      apply: (_target, _receiver, args: unknown[]) => {
        const called = `${label}(${args.map((value) => (value === undefined ? "" : JSON.stringify(value))).join(", ")})`;
        ran.push(called);
        return recorder(called);
      },
    });
  const resolverAt = (path: string, caller: Caller, stateless: boolean): ItxExpressionResolver => {
    const names = stateless ? PORTABLE : [...KERNEL_ROOTS, ...PORTABLE];
    const builtIns: Record<string, unknown> = {
      ...Object.fromEntries(names.map((name) => [name, recorder(`${path}: ${name}`)])),
      cd: (there: string) =>
        new InvokeHandle((steps) =>
          resolverAt(path, { ...caller, path: caller.path || path }, stateless).invoke([
            "itx",
            "builtins",
            ["cd", there],
            ...steps,
          ]),
        ),
      ...(!stateless && { workers: recorder(`${path}: workers`) }),
    };
    return new ItxExpressionResolver({
      path,
      caller: () => caller,
      ...(!stateless && { rewriteRules: () => rowsOf(path) }),
      builtIns,
      reach: {
        recordLoopLimit: () => undefined,
        snapshotOf: async (there) => ({
          rules: rowsOf(there),
          readAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
        located: (there, expression, args, callerThere) =>
          resolverAt(there, callerThere, false).invoke(expression, ...args),
        workersOf: (there) => recorder(`${there}: workers`),
      },
    });
  };
  const outcome = async (call: () => Promise<unknown>) => {
    ran = [];
    try {
      await call();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "NO_ITX_EXPRESSION_MATCH") return REFUSED;
      if (code === "FORBIDDEN") return "forbidden";
      throw error;
    }
    return ran.at(-1) ?? "nothing ran";
  };
  return {
    /** The context's own object and live table, the platform's own caller. */
    live: (path: string, call: ItxExpressionInput) =>
      outcome(() => resolverAt(path, { principal: null }, false).invoke(call)),
    /** How the context's own table reads a call (`rewriteRules.resolve`, and `#scriptExecution`). */
    resolved: (path: string, call: ItxExpressionInput) =>
      print(resolverAt(path, { principal: null }, false).resolve(call).at(-1)!),
    /** A script's call: loaded code's `env.ITX` at this context (`ItxEntrypoint.get`). */
    script: (path: string, call: ItxExpressionInput) => {
      const expression = normalizedItxExpression(call);
      const caller: Caller = { principal: null, app: true };
      const toTheObject =
        entersOwnRoot(expression) && itxExpressionStepName(expression.at(-1)) !== "fetch";
      return outcome(() => resolverAt(path, caller, !toTheObject).invoke(expression));
    },
  };
}
