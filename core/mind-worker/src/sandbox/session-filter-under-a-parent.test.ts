// WHETHER A SANDBOX GETS A SESSION OF ITS OWN, by the rows of the contexts ABOVE it. Code in a
// container has no itx. Its two ways out are `itx.fetch` on the sandbox's own context (the bare
// name, which walks the parent links: core/itx/src/context/parent-rule-and-child.test.ts) and the
// session that ./egress.ts opens for a sandbox that no rule filters (./own-session.ts
// `egressFilterOf`, asked of the context's real `rewriteRules.list()`). That session is loaded
// code of the sandbox's own context, where `cd` is implicit: no rule of a context between it and
// `/` binds it, so a mask on that way gives no session; a mask at `/` binds the session too.
import { normalizedItxExpression, type ItxExpressionInput } from "iterate/expression";
import { expect, test } from "vitest";
import { defineItxHost } from "../../../itx/src/host.ts";
import {
  describeRewriteRules,
  implicitRootsAt,
  ItxExpressionResolver,
  type ItxExpressionRewriteRule,
  normalizeRewriteRuleConfigured,
} from "../../../itx/src/context/itx-expression-rewriting.ts";
import { egressFilterOf } from "./own-session.ts";

const BOX = "/agents/a/box";

test("a sandbox with a rule for itx.fetch of its own gets no session: the public game's box (its own row sends every request to a worker that refuses), and a box whose itx.fetch is masked", async () => {
  for (const own of [
    row("itx.fetch", "itx.cd('/').workers.get({ source: 'refuses' }).fetch"),
    row("itx.fetch", null),
  ])
    expect(await sessionFilter({ [BOX]: [own, linkTo("/")] })).toMatch(/filters what it sends/);
});

test("a sandbox under a parent that re-points or masks itx.fetch gets no session: the parent's row is the one a call from the box reaches", async () => {
  expect(
    await sessionFilter({
      "/agents/a": [row("itx.fetch", "itx.builtins.cd('/').config.jailFetch('g', @)"), linkTo("/")],
    }),
  ).toBe("the mind filters what it sends (the rule for itx.fetch at /agents/a)");
  expect(await sessionFilter({ "/agents/a": [row("itx.fetch", null), linkTo("/")] })).toMatch(
    /filters what it sends/,
  );
  // a jail above it, with no fetch given back
  expect(await sessionFilter({ "/agents/a": [row("itx", null)] })).toBe(
    "itx.fetch is masked for it",
  );
});

test("a sandbox under a parent that masks names, or that holds a bare null and gives the built-in itx.fetch back, gets no session: that session would pass the parent's rules", async () => {
  // a jail that gives the built-in fetch back
  expect(
    await sessionFilter({
      "/agents/a": [row("itx", null), row("itx.fetch", "itx.builtins.fetch")],
    }),
  ).toBe("the mind filters what it sends (the rule for itx.fetch at /agents/a)");
  // a parent that masks single names and links to the root
  expect(
    await sessionFilter({
      "/agents/a": [
        row("itx.secrets", null),
        row("itx.cd", null),
        row("itx.email", null),
        linkTo("/"),
      ],
    }),
  ).toBe("a context above it masks itx.secrets (at /agents/a)");
  // what the session would pass: it spells the root's name through its own `cd`, and reaches it
  // (a host's root is walked where the call is made)
  expect(
    await sessionCall(
      { "/agents/a": [row("itx.secrets", null), linkTo("/")] },
      "itx.cd('/').secrets.list()",
    ),
  ).toBe(`${BOX}: secrets.list()`);
  // a parent with no mask: the box gets its session
  expect(await sessionFilter({})).toBeNull();
});

test("a mask at the mind's root takes no session: the session's calls of the name meet the root's table, by the bare name and by `cd('/')`", async () => {
  const named = { "/": [row("itx.secrets", null)] };
  expect(await sessionFilter(named)).toBeNull();
  for (const call of ["itx.secrets.list()", "itx.cd('/').secrets.list()"])
    expect(await sessionCall(named, call), call).toBe(REFUSED);
  expect(await sessionCall(named, "itx.cd('/').kv.get('k')")).toBe(`${BOX}: kv.get("k")`);
});

test("a bare `itx => null` at the mind's root, with the built-in itx.fetch given back: the box's list cannot show the bare row, and needs not, since it binds the session as a named mask at the root does", async () => {
  const bare = { "/": [row("itx", null), row("itx.fetch", "itx.builtins.fetch")] };
  expect(await sessionFilter(bare)).toBeNull();
  for (const call of [
    "itx.secrets.list()",
    "itx.cd('/').secrets.list()",
    "itx.cd('/').kv.get('k')",
  ])
    expect(await sessionCall(bare, call), call).toBe(REFUSED);
});

// ---------------------------------------------------------------------------------------------

const REFUSED = "refused";
const HOST_ROOTS = ["secrets", "kv"];
defineItxHost({
  firstPartyFacets: {},
  roots: Object.fromEntries(
    HOST_ROOTS.map((name) => [name, { description: name, build: () => ({}) }]),
  ),
});

const linkTo = (parent: string) => row("itx", `itx.builtins.cd(${JSON.stringify(parent)})`);
function row(match: string, target: string | null): ItxExpressionRewriteRule {
  return normalizeRewriteRuleConfigured({ match, target });
}

/** The box holds its parent link (a collection's `create` writes it) unless the test gives it
 *  other rows; `/agents/a` links to `/`; `/` holds no row. */
function tablesWith(given: Record<string, ItxExpressionRewriteRule[]>) {
  const tables: Record<string, ItxExpressionRewriteRule[]> = {
    [BOX]: [linkTo("/agents/a")],
    "/agents/a": [linkTo("/")],
    ...given,
  };
  return (path: string) => tables[path] ?? [];
}

/** Why the box gets no session, or null when it gets one: `egressFilterOf` of the box's own
 *  `rewriteRules.list()`, as ./egress.ts `#filter` asks it. */
async function sessionFilter(given: Record<string, ItxExpressionRewriteRule[]>) {
  const rowsOf = tablesWith(given);
  // core/itx/src/iterate-context-durable-object.ts `#rewriteRuleListAt`
  const listAt = (path: string, depth: number): ReturnType<typeof describeRewriteRules> =>
    describeRewriteRules({
      rules: rowsOf(path),
      implicitRoots: implicitRootsAt(path),
      path,
      depth,
      inherit: (there, hopsLeft) => listAt(there, hopsLeft),
    });
  return egressFilterOf(await listAt(BOX, 32));
}

/** A call of the box's own session (./own-session.ts `ownSessionOf`: loaded code of the box's
 *  context), resolved by the real resolver: what ran, at which context, or "refused". A root's
 *  name records its call; a context the route reaches resolves with its live table. */
async function sessionCall(
  given: Record<string, ItxExpressionRewriteRule[]>,
  call: ItxExpressionInput,
) {
  const rowsOf = tablesWith(given);
  let ran = "nothing ran";
  const recorder = (label: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) =>
        typeof key === "string" && key !== "then" ? recorder(`${label}.${key}`) : undefined,
      apply: (_target, _receiver, args: unknown[]) =>
        (ran = `${label}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`),
    });
  const resolverAt = (
    path: string,
    caller: { principal: null; app?: true; path?: string },
  ): ItxExpressionResolver =>
    new ItxExpressionResolver({
      path,
      caller: () => caller,
      ...(!caller.app && { rewriteRules: () => rowsOf(path) }),
      builtIns: Object.fromEntries(
        [...HOST_ROOTS, "fetch"].map((name) => [name, recorder(`${path}: ${name}`)]),
      ),
      reach: {
        recordLoopLimit: () => undefined,
        snapshotOf: async (there) => ({
          rules: rowsOf(there),
          readAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
        located: (there, expression, args) =>
          resolverAt(there, { principal: null }).invoke(expression, ...args),
        workersOf: () => undefined,
      },
    });
  try {
    await resolverAt(BOX, { principal: null, app: true }).invoke(normalizedItxExpression(call));
  } catch (error) {
    if ((error as { code?: string }).code === "NO_ITX_EXPRESSION_MATCH") return REFUSED;
    throw error;
  }
  return ran;
}
