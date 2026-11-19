// DOES A PARENT'S RULE BIND A CALL MADE FROM A CHILD CONTEXT? One answer per kind of root, proved
// against the real resolver (./itx-expression-rewriting.ts `ItxExpressionResolver`). The answer:
// no rule of a parent binds a child's code; only a context's own bare `itx => null` holds it.
//
// THE MIND OF THESE TESTS: `/` has an empty table. `/box` is the parent: its rows are each test's,
// and it links to `/`. `/box/child` holds its parent link alone, as a collection's `create` writes
// it (core/lib/src/agents/collection.ts `create`). `/box/plain` has no row at all: a path that code
// reached by `cd` and never linked.
//
// A call is made as each of the kernel's two entries makes it:
//   - `live`: the context's own object and its live table (`IterateContextDurableObject.invoke`);
//   - `loaded`: loaded code's `env.ITX` (../iterate-context.ts `ItxEntrypoint.get`), which sends a
//     call into the context's own root to the object, and resolves every other call in a
//     stateless resolver that reads each table as a snapshot.
import {
  InvokeHandle,
  itxExpressionStepName,
  normalizedItxExpression,
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

test("a root of every context (the kernel's own: append, readEvents, run, facets …) is read by the child's own table alone: the parent's mask of the name does not bind the child", async () => {
  for (const root of ["append", "readEvents", "run", "facets", "processors", "rewriteRules"]) {
    const mind = mindWith({ "/box": [mask(`itx.${root}`), linkTo("/")] });
    // the parent's own code is refused
    expect(await mind.live("/box", `itx.${root}.x()`), root).toBe(REFUSED);
    // the child's is not, by either entry: the call runs at the child
    for (const entry of [mind.live, mind.loaded]) {
      expect(await entry("/box/child", `itx.${root}.x()`), root).toBe(`/box/child: ${root}.x()`);
      expect(await entry("/box/plain", `itx.${root}.x()`), root).toBe(`/box/plain: ${root}.x()`);
    }
  }
});

test("the parent's bare `itx => null` binds no root of every context either: the child keeps its own log, its own run and its own cd", async () => {
  const mind = mindWith({ "/box": [mask("itx")] });
  expect(await mind.live("/box", "itx.append({})")).toBe(REFUSED);
  for (const entry of [mind.live, mind.loaded]) {
    expect(await entry("/box/child", "itx.append({})")).toBe("/box/child: append({})");
    expect(await entry("/box/child", "itx.run('s')")).toBe('/box/child: run("s")');
    // a host's root is portable: the caller's own resolver walks it, so the line names the child
    expect(await entry("/box/child", "itx.cd('/').secrets.list()")).toBe(
      "/box/child: secrets.list()",
    );
  }
});

test("`cd` is a root of every context: where the parent masks `itx.cd`, a child still crosses to any context, the root too", async () => {
  const mind = mindWith({ "/box": [mask("itx.cd"), linkTo("/")] });
  expect(await mind.live("/box", "itx.cd('/').secrets.list()")).toBe(REFUSED);
  for (const entry of [mind.live, mind.loaded])
    for (const child of ["/box/child", "/box/plain"]) {
      expect(await entry(child, "itx.cd('/').secrets.list()")).toBe(`${child}: secrets.list()`);
      expect(await entry(child, "itx.cd('/other').readEvents(0)")).toBe("/other: readEvents(0)");
    }
});

test("`workers` is a root of every context: where the parent masks `itx.workers`, a child still loads code, with the child's own authority", async () => {
  const mind = mindWith({ "/box": [mask("itx.workers"), linkTo("/")] });
  expect(await mind.loaded("/box", "itx.workers.get({}).run()")).toBe(REFUSED);
  expect(await mind.loaded("/box/child", "itx.workers.get({}).run()")).toBe(
    "/box/child: workers.get({}).run()",
  );
});

test("a host's root of every context (itx.minds, itx.webhooks, itx.url) is read by the child's own table alone: the parent's mask, or its bare null, does not bind the child", async () => {
  for (const parent of [[mask("itx.minds"), linkTo("/")], [mask("itx")]]) {
    const mind = mindWith({ "/box": parent });
    expect(await mind.live("/box", "itx.minds.get('peer').x()")).toBe(REFUSED);
    for (const entry of [mind.live, mind.loaded])
      expect(await entry("/box/child", "itx.minds.get('peer').x()")).toBe(
        '/box/child: minds.get("peer").x()',
      );
  }
});

test("a host's root of every context, called by loaded code with `fetch` as its last step, meets the context's OWN table: its mask, and its own bare null, refuse it as they refuse any other call of the name", async () => {
  // ../iterate-context.ts:541 sends a call into the context's own root to the object, but one that
  // ends in `fetch` to the stateless resolver; `#route` there reads the context's snapshot for a
  // host's root.
  for (const own of [[mask("itx.minds"), mask("itx.webhooks"), linkTo("/")], [mask("itx")]]) {
    const mind = mindWith({ "/box": own });
    expect(await mind.live("/box", "itx.minds.get('peer').x()")).toBe(REFUSED);
    expect(await mind.loaded("/box", "itx.minds.get('peer').x()")).toBe(REFUSED);
    expect(await mind.loaded("/box", "itx.minds.get('peer').fetch()")).toBe(REFUSED);
    expect(await mind.loaded("/box", "itx.webhooks.get({}).fetch()")).toBe(REFUSED);
  }
  // with no mask of its own, the context reaches them
  const mind = mindWith({ "/box": [mask("itx.minds"), linkTo("/")] });
  expect(await mind.loaded("/box/child", "itx.minds.get('peer').fetch()")).toBe(
    '/box/child: minds.get("peer").fetch()',
  );
});

test("the kernel's own root of every context, with `fetch` as its last step, still meets the context's table: it is not portable, so it goes to the object", async () => {
  const mind = mindWith({ "/box": [mask("itx")] });
  expect(await mind.loaded("/box", "itx.facets.get('f').fetch()")).toBe(REFUSED);
});

test("a root of the mind's root alone (itx.fetch, itx.secrets, a rule's name such as itx.config) walks the parent links: the parent's mask binds a child that spells the bare name", async () => {
  for (const name of ["fetch", "secrets.list", "kv.get", "config.x"]) {
    const root = name.split(".")[0]!;
    const mind = mindWith({
      "/": [row("itx.config", "itx.builtins.facets.get('config')")],
      "/box": [mask(`itx.${root}`), linkTo("/")],
    });
    for (const entry of [mind.live, mind.loaded]) {
      expect(await entry("/box/child", `itx.${name}()`), name).toBe(REFUSED);
      // a context with no link has no such name at all
      expect(await entry("/box/plain", `itx.${name}()`), name).toBe(REFUSED);
    }
  }
});

test("the parent's re-point of such a root binds the child too: the child's call runs the parent's target", async () => {
  const mind = mindWith({
    "/box": [row("itx.fetch", "itx.builtins.cd('/').facets.get('egress').send(@)"), linkTo("/")],
  });
  for (const entry of [mind.live, mind.loaded])
    expect(await entry("/box/child", "itx.fetch('u')")).toBe('/: facets.get("egress").send("u")');
});

test("the parent's bare `itx => null` refuses such a root for a linked child, and what the parent gives back the child gets", async () => {
  const mind = mindWith({ "/box": [mask("itx"), row("itx.fetch", "itx.builtins.fetch")] });
  for (const entry of [mind.live, mind.loaded]) {
    expect(await entry("/box/child", "itx.secrets.list()")).toBe(REFUSED);
    expect(await entry("/box/child", "itx.fetch('u')")).toMatch(/fetch\("u"\)$/);
  }
});

test("BUT THE CHILD SPELLS THE SAME ROOT THROUGH ITS OWN `cd`, AND NO PARENT ROW IS ASKED: a mask, a re-point and a bare null of the parent are all passed", async () => {
  for (const parent of [
    [mask("itx.fetch"), mask("itx.secrets"), mask("itx.config"), linkTo("/")],
    [row("itx.fetch", "itx.builtins.cd('/').facets.get('egress').send(@)"), linkTo("/")],
    [mask("itx")],
    // the parent masks cd too: the child's cd is its own
    [mask("itx"), mask("itx.cd")],
  ]) {
    const mind = mindWith({
      "/": [row("itx.config", "itx.builtins.facets.get('config')")],
      "/box": parent,
    });
    for (const entry of [mind.live, mind.loaded])
      for (const child of ["/box/child", "/box/plain"]) {
        expect(await entry(child, "itx.cd('/').fetch('u')")).toMatch(/fetch\("u"\)$/);
        expect(await entry(child, "itx.cd('/').secrets.list()")).toBe(`${child}: secrets.list()`);
        expect(await entry(child, "itx.cd('/').config.x()")).toBe('/: facets.get("config").x()');
        // and any other context's log
        expect(await entry(child, "itx.cd('/agents/a').readEvents(0)")).toBe(
          "/agents/a: readEvents(0)",
        );
      }
  }
});

test("only the context's OWN bare `itx => null` holds its code: the same calls from a context that has the mask itself are all refused", async () => {
  const mind = mindWith({ "/jail": [mask("itx")] });
  for (const entry of [mind.live, mind.loaded])
    for (const call of [
      "itx.cd('/').secrets.list()",
      "itx.cd('./child').append({})",
      "itx.cd('/jail/child').run('s')",
      "itx.append({})",
      "itx.run('s')",
      "itx.workers.get({}).run()",
      "itx.fetch('u')",
      "itx.minds.get('peer').x()",
      "itx.whoami()",
    ])
      expect(await entry("/jail", call), call).toBe(REFUSED);
});

test("a call that reaches INTO a context meets that context's table: a parent crosses into its jailed child and is refused what the child's mask refuses", async () => {
  const mind = mindWith({
    "/box/child": [mask("itx"), row("itx.readEvents", "itx.builtins.readEvents")],
  });
  expect(await mind.live("/box", "itx.cd('/box/child').append({})")).toBe(REFUSED);
  expect(await mind.live("/box", "itx.cd('/box/child').secrets.list()")).toBe(REFUSED);
  expect(await mind.live("/box", "itx.cd('/box/child').readEvents(0)")).toBe(
    "/box/child: readEvents(0)",
  );
});

// ---------------------------------------------------------------------------------------------

/** A parent link, as core/lib/src/agents/collection.ts `create` writes it. */
const linkTo = (parent: string) => row("itx", `itx.builtins.cd(${JSON.stringify(parent)})`);
const mask = (match: string) => row(match, null);
/** A row as the reduce stores it, from the payload of a `rewrite-rule-configured`. */
function row(match: string, target: string | null): ItxExpressionRewriteRule {
  return normalizeRewriteRuleConfigured({ match, target });
}

// As core/mind-worker/src/itx-host.ts registers them: `secrets` and `kv` at the root alone, and
// `url`, `webhooks` and `minds` at every context. The harness below builds what each answers.
const HOST_ROOTS = { secrets: false, kv: false, url: true, webhooks: true, minds: true };
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

/** A mind with these tables (a path with none has an empty table, and the child its parent link):
 *  a resolver for each context, and the two entries. Each answers what ran, as
 *  `<the context whose built-in ran>: <the call>`, or REFUSED when a table refused the call. */
function mindWith(given: Record<string, ItxExpressionRewriteRule[]>) {
  const tables: Record<string, ItxExpressionRewriteRule[]> = {
    "/box/child": [linkTo("/box")],
    ...given,
  };
  const rowsOf = (path: string) => tables[path] ?? [];
  let ran: string[] = [];
  /** A value that records the call made of it or under it, whatever the steps. */
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
      // ./built-ins.ts `buildPortableBuiltIns`: the handle of a bare `itx.cd(path)`
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
        // a call that is sent on arrives at that context's object, which resolves it by its live table
        located: (there, expression, args, callerThere) =>
          resolverAt(there, callerThere, false).invoke(expression, ...args),
        workersOf: (there) => recorder(`${there}: workers`),
      },
    });
  };
  const outcome = async (call: Promise<unknown>) => {
    ran = [];
    try {
      await call;
    } catch (error) {
      if ((error as { code?: string }).code === "NO_ITX_EXPRESSION_MATCH") return REFUSED;
      throw error;
    }
    return ran.at(-1) ?? "nothing ran";
  };
  return {
    /** The context's own object: `IterateContextDurableObject.invoke`, the platform's own caller. */
    live: (path: string, call: ItxExpressionInput) =>
      outcome(resolverAt(path, { principal: null }, false).invoke(call)),
    /** Loaded code's `env.ITX` at this context: ../iterate-context.ts `ItxEntrypoint.get`. */
    loaded: (path: string, call: ItxExpressionInput) => {
      const expression = normalizedItxExpression(call);
      const caller: Caller = { principal: null, app: true };
      const toTheObject =
        entersOwnRoot(expression) && itxExpressionStepName(expression.at(-1)) !== "fetch";
      return outcome(resolverAt(path, caller, !toTheObject).invoke(expression));
    },
  };
}
