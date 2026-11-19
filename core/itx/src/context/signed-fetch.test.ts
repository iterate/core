// A REQUEST SIGNED AS THE MIND IS THE CALLER'S OWN `itx.fetch(request, { signFor })`, by the real
// resolver (./itx-expression-rewriting.ts) and the real built-in fetch (./built-ins.ts
// `buildPortableBuiltIns`): the calling context's table decides it as it decides any fetch, and the
// built-in signs only when the call reaches it with the option. `itx.minds` here is a stand-in that
// makes the one call core/mind-worker/src/context/minds.ts `signedMindFetch` makes (its own test
// pins that call). Each case runs on a stateful resolver (the context's own live table) and on a
// stateless one (loaded code's: every table a snapshot).
import { normalizedItxExpression, type ItxExpressionInput } from "iterate/expression";
import { codedError, errorCode } from "iterate/lib";
import type { StreamEventInput } from "iterate/stream/processor";
import { expect, test, vi } from "vitest";
import { type Caller, refuseNonPlatformWrites, stampCaller } from "../caller.ts";
import { defineItxHost } from "../host.ts";
import { buildPortableBuiltIns, SIGNED_REQUEST_SENT } from "./built-ins.ts";
import { egress as kernelEgress } from "./egress.ts";
import { requestForLoadedCode } from "./rpc-stubs.ts";
import {
  entersOwnRoot,
  type ItxExpressionRewriteRule,
  ItxExpressionResolver,
  normalizeRewriteRuleConfigured,
} from "./itx-expression-rewriting.ts";

const PEER = "peer.example";
const JAIL = "/jails/outside-callers/aaaaaaaaaaaa/bbbbbbbbbbbb";
const APP = "/apps/notes";

test("(e) at the mind's root and at an app's context under its parent link, as the default config makes one, the request goes out signed for the peer, and one fact lands after the answer", async () => {
  for (const at of ["/", APP])
    for (const stateless of [false, true]) {
      const mind = mindWith({ [APP]: [linkTo("/")] });
      expect(await mind.signedFrom(at, { stateless })).toBe("sent");
      expect({ egress: mind.egress }).toEqual({
        egress: [{ url: "https://peer.example/who?q=1", signFor: PEER }],
      });
      await mind.afterTheAnswer();
      // on the calling context's log: who asked, the peer, the method, the URL with no query
      expect({ appended: mind.appended }).toEqual({
        appended: [
          {
            path: at,
            type: SIGNED_REQUEST_SENT,
            payload: {
              peer: PEER,
              method: "POST",
              url: "https://peer.example/who",
              callerPath: at,
              app: stateless,
              outcome: { status: 200 },
            },
          },
        ],
      });
    }
});

test("the fact is the platform's own: loaded code's append of it is refused, and the built-in's lands as the platform's", () => {
  const forged = [{ type: SIGNED_REQUEST_SENT, payload: { peer: PEER } }];
  expect(() => refuseNonPlatformWrites(forged, { principal: null, app: true })).toThrow(
    "is the platform's own fact",
  );
  expect(() => refuseNonPlatformWrites(forged, { principal: null, platform: true })).not.toThrow();
});

test("each fact names its own caller, read before the send: two sends of two callers that overlap, and loaded code's send with its principal", async () => {
  const mind = mindWith({ [APP]: [linkTo("/")] }, { oneStore: true });
  const ada: Caller = { principal: { actor: "user_ada" }, path: "/agents/ada" };
  const bob: Caller = { principal: { actor: "user_bob" }, app: true };
  // the first is at egress, waiting, when the second begins and sets the one store
  const first = mind.signedAs(APP, ada, false);
  await vi.waitUntil(() => mind.egress.length === 1);
  const second = mind.signedAs(APP, bob, true);
  await vi.waitUntil(() => mind.egress.length === 2);
  mind.openEgress();
  expect(await Promise.all([first, second])).toEqual(["sent", "sent"]);
  await mind.afterTheAnswer();
  expect(mind.appended.map(({ payload }) => payload)).toMatchObject([
    { principal: "user_ada", callerPath: "/agents/ada", app: false },
    { principal: "user_bob", callerPath: APP, app: true },
  ]);
});

test("behind loaded code, each fact names the member it runs for, in the same source fields as any event of that code: two members' calls that overlap", async () => {
  const mind = mindWith({ [APP]: [linkTo("/")] }, { oneStore: true });
  const behalfOf = (actor: string, email: string): Caller => ({
    principal: null,
    app: true,
    onBehalfOf: { principal: { actor, email }, grant: `grant_${actor}`, run: `${APP}@7` },
  });
  const ada = behalfOf("user_ada", "ada@example.com");
  const bob = behalfOf("user_bob", "bob@example.com");
  const first = mind.signedAs(APP, ada, true);
  await vi.waitUntil(() => mind.egress.length === 1);
  const second = mind.signedAs(APP, bob, true);
  await vi.waitUntil(() => mind.egress.length === 2);
  mind.openEgress();
  expect(await Promise.all([first, second])).toEqual(["sent", "sent"]);
  await mind.afterTheAnswer();
  // the source an ordinary append by that code is stamped with, and that the platform wrote it
  const ordinary = (caller: Caller) => stampCaller({}, caller, APP).source;
  expect({ sources: mind.sources }).toEqual({
    sources: [
      { ...ordinary(ada), platform: true },
      { ...ordinary(bob), platform: true },
    ],
  });
  expect(mind.sources).toMatchObject([
    { onBehalfOf: { principal: { actor: "user_ada" } } },
    { onBehalfOf: { principal: { actor: "user_bob" } } },
  ]);
});

test("the fact's source carries the caller's own cause, on a stateless send as on a stateful one", async () => {
  for (const stateless of [false, true]) {
    const mind = mindWith({ [APP]: [linkTo("/")] });
    const cause = { chain: "2026-11-19T02:30:00.000Z the caller's own", depth: 2 };
    const caller: Caller = stateless
      ? { principal: null, app: true, cause }
      : { principal: null, cause };
    expect(await mind.signedAs(APP, caller, stateless)).toBe("sent");
    await mind.afterTheAnswer();
    expect(mind.sources).toMatchObject([{ cause: { chain: cause.chain, depth: 2 } }]);
  }
});

test("each send in one delivery is its own record: two POSTs to one path with different queries are two records, neither keyed by the delivery", async () => {
  const mind = mindWith({});
  const delivery: Caller = {
    principal: null,
    runsRow: true,
    cause: { chain: "2026-11-19T03:00:00.000Z a delivery", depth: 1, writeKey: "row-a:7" },
  };
  for (const part of [1, 2])
    expect(await mind.sendTo(`https://peer.example/job?part=${part}`, delivery)).toBe("sent");
  await mind.afterTheAnswer();
  // the same payload twice: the URL is kept without its query
  expect(mind.appended.map(({ payload }) => payload)).toMatchObject([
    { url: "https://peer.example/job", method: "POST" },
    { url: "https://peer.example/job", method: "POST" },
  ]);
  // the built-in append keys an event by `cause.writeKey` alone: neither record has one, so
  // neither is taken for the other, and the delivery's own cause is kept
  expect({ causes: mind.causes }).toEqual({
    causes: [
      { chain: delivery.cause!.chain, depth: 1 },
      { chain: delivery.cause!.chain, depth: 1 },
    ],
  });
});

test("what threw is a string: an AbortError's numeric code gives its name", async () => {
  const mind = mindWith(
    {},
    { egressError: new DOMException("the send was aborted", "AbortError") },
  );
  expect(await mind.signedFrom("/")).toBe("failed");
  await mind.afterTheAnswer();
  expect(mind.appended).toMatchObject([{ payload: { outcome: { threw: "AbortError" } } }]);
});

test("a fetch row back to the wrapper (`itx.fetch => itx.minds.get(x).fetch(@)`) ends at its first turn: the whole @ hands the wrapper the option too, and it takes one Request alone", async () => {
  for (const stateless of [false, true]) {
    const mind = mindWith({
      [APP]: [linkTo("/"), row("itx.fetch", `itx.minds.get("${PEER}").fetch(@)`)],
    });
    expect(await mind.fetchWith(APP, [], stateless)).toBe("invalid");
    expect(mind.refusal).toContain("takes one Request and nothing more");
    expect({ egress: mind.egress }).toEqual({ egress: [] });
  }
});

test("a fact that cannot be appended is reported, and the answer is the same", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const mind = mindWith({}, { appendFails: true });
    expect(await mind.signedFrom("/")).toBe("sent");
    await mind.afterTheAnswer();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ event: "itx.signed-request-unrecorded", context: "/", peer: PEER }),
    );
  } finally {
    report.mockRestore();
  }
});

test("a signed try whose egress throws (the Door's refusal, or a failure after signing: the built-in cannot tell them apart) is recorded with the error's code, and the caller gets the same throw", async () => {
  for (const stateless of [false, true]) {
    const mind = mindWith({}, { egressThrows: "INVALID_INPUT" });
    expect(await mind.signedFrom("/", { stateless })).toBe("invalid");
    expect(mind.refusal).toContain("the Door refuses");
    await mind.afterTheAnswer();
    expect(mind.appended).toMatchObject([{ payload: { outcome: { threw: "INVALID_INPUT" } } }]);
  }
});

test("(a, g) in iterate.com's jail, whose itx.fetch is a narrow function of the request (`jailFetch(n, @)`), nothing is signed: the mask refuses the minds form on both paths, and itx.fetch(request, { signFor }) meets the jail's fetch row: a whole @ hands the function the request AND the option, and it passes the request on alone", async () => {
  for (const stateless of [false, true]) {
    const mind = mindWith({ [JAIL]: jailRows("jailFetch", '"outside-callers", @') });
    // the jail's own bare null masks itx.minds, on both paths: a call of a host's root of every
    // context reads the table too (./itx-expression-rewriting.ts, K1)
    expect(await mind.signedFrom(JAIL, { stateless })).toBe("refused");
    // loaded code's own call, with the option written by hand, meets the jail's fetch row
    expect(await mind.fetchFrom(JAIL, { stateless, signFor: PEER })).toBe("narrowed");
    expect(mind.narrowed.map(({ args }) => args)).toEqual([
      ["outside-callers", "https://peer.example/who?q=1", { signFor: PEER }],
    ]);
    expect({ egress: mind.egress }).toEqual({
      egress: [{ url: "https://peer.example/who?q=1", signFor: "" }],
    });
  }
});

test("a row that puts the call's argument inside an object (`{ request: @ }`, `{ ...@ }`) takes exactly one: a signed fetch through it is refused, and nothing is sent", async () => {
  for (const args of ['"outside-callers", { request: @ }', '"outside-callers", { n: 1, ...@ }'])
    for (const stateless of [false, true]) {
      const mind = mindWith({ [JAIL]: jailRows("jailFetch", args) });
      expect(await mind.fetchFrom(JAIL, { stateless, signFor: PEER })).toBe("failed");
      expect({ narrowed: mind.narrowed, egress: mind.egress }).toEqual({
        narrowed: [],
        egress: [],
      });
    }
});

test("a fetch row that forwards its arguments whole (`itx.builtins.cd('/').fetch(@)`) is raw fetch: it signs as the mind, the doc's 'a narrow fetch passes the request on and nothing else'", async () => {
  const forwarding = [row("itx", null), row("itx.fetch", "itx.builtins.cd('/').fetch(@)")];
  for (const stateless of [false, true]) {
    const mind = mindWith({ [JAIL]: forwarding });
    expect(await mind.fetchFrom(JAIL, { stateless, signFor: PEER })).toBe("sent");
    expect({ egress: mind.egress }).toEqual({
      egress: [{ url: "https://peer.example/who?q=1", signFor: PEER }],
    });
  }
});

test("a mask of itx.minds does not keep a context from signing; only its rule for itx.fetch does: the minds form is refused on both paths, and itx.fetch(request, { signFor }) signs", async () => {
  for (const stateless of [false, true]) {
    const mind = mindWith({ [APP]: [linkTo("/"), row("itx.minds", null)] });
    expect(await mind.signedFrom(APP, { stateless })).toBe("refused");
    expect(await mind.fetchFrom(APP, { stateless, signFor: PEER })).toBe("sent");
    expect({ egress: mind.egress }).toEqual({
      egress: [{ url: "https://peer.example/who?q=1", signFor: PEER }],
    });
  }
});

test("a signed try past the loop limit: the kernel's egress refuses it before anything is sent, so no fact is written and no issue is reported; at the limit it goes and its fact lands", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const [depth, expected] of [
      [17, "failed"],
      [16, "sent"],
    ] as const) {
      const mind = mindWith({}, { throughTheKernel: true });
      const caller: Caller = {
        principal: null,
        cause: { chain: "2026-11-19T06:00:00.000Z a loop", depth },
      };
      expect(await mind.signedAs("/", caller, false)).toBe(expected);
      await mind.afterTheAnswer();
      expect({ sends: mind.egress.length, facts: mind.appended.length }).toEqual(
        depth === 17 ? { sends: 0, facts: 0 } : { sends: 1, facts: 1 },
      );
      if (depth === 17) expect(mind.refusal).toContain("refused");
    }
    // a LOOP_LIMIT that comes back from egress later writes no fact either, and a record whose
    // own append is refused past the limit is no issue
    const late = mindWith({}, { egressThrows: "LOOP_LIMIT" });
    expect(await late.signedFrom("/")).toBe("failed");
    await late.afterTheAnswer();
    expect({ appended: late.appended }).toEqual({ appended: [] });
    const refusedRecord = mindWith({}, { appendThrows: "LOOP_LIMIT" });
    expect(await refusedRecord.signedFrom("/")).toBe("sent");
    await refusedRecord.afterTheAnswer();
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

test("(b) a bare null and no fetch row: refused, and nothing reaches egress", async () => {
  for (const stateless of [false, true]) {
    const mind = mindWith({ [JAIL]: [row("itx", null)] });
    expect(await mind.signedFrom(JAIL, { stateless })).toBe("refused");
    expect(await mind.fetchFrom(JAIL, { stateless, signFor: PEER })).toBe("refused");
    expect({ egress: mind.egress }).toEqual({ egress: [] });
  }
});

test("(c) an approval rule on itx.fetch: the call is refused, not held, since a Request is no plain JSON a member could read; nothing is sent, so no approval of a signed fetch exists to come late", async () => {
  for (const stateless of [false, true]) {
    const mind = mindWith({ [APP]: [linkTo("/")] }, { heldVerbs: [{ verb: "itx.fetch" }] });
    expect(await mind.signedFrom(APP, { stateless })).toBe("forbidden");
    expect(mind.refusal).toContain("must be plain JSON");
    expect({ egress: mind.egress }).toEqual({ egress: [] });
  }
});

test("(d) a fetch row to another context's object, or to a worker: the routed call carries the request and the option as its arguments (to a stand-in here); the real workers root and a loaded facet hand the code ONE Request made of both (`requestForLoadedCode`), so it never sees an option; what the target sends on goes unsigned", async () => {
  // the option, read as a RequestInit, adds nothing to the one Request
  const one = requestForLoadedCode(
    [new Request("https://peer.example/who?q=1"), { signFor: PEER }],
    { principal: null },
    undefined,
  );
  expect({ url: one.url, method: one.method }).toEqual({
    url: "https://peer.example/who?q=1",
    method: "GET",
  });
  for (const target of [
    "itx.builtins.cd('/').facets.get('egress').fetch",
    "itx.builtins.cd('/').workers.get('egress').fetch",
  ])
    for (const stateless of [false, true]) {
      const mind = mindWith({ [APP]: [linkTo("/"), row("itx.fetch", target)] });
      expect(await mind.signedFrom(APP, { stateless })).toBe("narrowed");
      expect({ narrowed: mind.narrowed }).toEqual({
        narrowed: [
          {
            at: "/",
            args: ["https://peer.example/who?q=1", { signFor: PEER }],
          },
        ],
      });
      expect({ egress: mind.egress }).toEqual({
        egress: [{ url: "https://peer.example/who?q=1", signFor: "" }],
      });
    }
});

test("the built-in takes nothing but exactly { signFor: <a mind's hostname> } beside the request: anything else is refused before anything is sent, with what to do, and leaves no fact", async () => {
  for (const options of [
    {},
    { signFor: "Not A Host" },
    { signFor: PEER, as: "mind" },
    "x",
    // what an agent's script may have written before: an init beside a Request
    { headers: { accept: "application/json" } },
  ]) {
    const mind = mindWith({});
    expect(await mind.fetchWith("/", [options])).toBe("invalid");
    expect(mind.refusal).toContain("the method, headers and body go INTO the Request");
    await mind.afterTheAnswer();
    expect({ egress: mind.egress, appended: mind.appended }).toEqual({ egress: [], appended: [] });
  }
  // `fetch(request, undefined)` is no option at all
  const absent = mindWith({});
  expect(await absent.fetchWith("/", [undefined])).toBe("sent");
  expect({ egress: absent.egress }).toEqual({
    egress: [{ url: "https://peer.example/who?q=1", signFor: "" }],
  });
  // a first argument that is no Request is refused with what to do
  const url = mindWith({});
  expect(await url.fetchFirst("/", "https://peer.example/who")).toBe("invalid");
  expect(url.refusal).toContain("the first argument is one Request");
  const twice = mindWith({});
  expect(await twice.fetchWith("/", [{ signFor: PEER }, {}])).toBe("invalid");
});

let heldVerbsNow: { verb: string }[] = [];
let hostEgressNow: (request: Request, options: { signFor?: string }) => Promise<Response>;
defineItxHost({
  firstPartyFacets: {},
  egress: (request, options) => hostEgressNow(request, options),
  // the one call core/mind-worker `signedMindFetch` makes, on a root of every context
  roots: {
    minds: {
      description: "another mind",
      everyContext: true,
      build: (scope) => ({
        get: (peer: string) => ({
          fetch: (request: Request, ...more: unknown[]) => {
            // as strict as signedMindFetch: one Request and nothing more
            if (more.length)
              throw codedError("INVALID_INPUT", "takes one Request and nothing more");
            return scope.invokeAs(scope.caller(), ["itx", ["fetch", request, { signFor: peer }]]);
          },
        }),
      }),
    },
  },
  acts: {
    verbRules: async () => heldVerbsNow,
    ask: async () => {
      throw new Error("no member is asked here");
    },
  },
});

const row = (match: string, target: string | null): ItxExpressionRewriteRule =>
  normalizeRewriteRuleConfigured({ match, target });
/** A parent link, as core/mind-worker/src/mind/collection.ts writes it. */
const linkTo = (parent: string) => row("itx", `itx.builtins.cd(${JSON.stringify(parent)})`);
/** iterate-config jail.ts `jailRowsOf`: the bare null, and the narrow fetch of its config. */
const jailRows = (name: string, args: string) => [
  row("itx", null),
  row("itx.fetch", `itx.builtins.cd("/").config.${name}(${args})`),
];
/** The root's names that are rules, as iterate.com writes `itx.config`. */
const ROOT_ROWS = [row("itx.config", 'itx.builtins.facets.get("config")')];

/** A mind of these tables. Every call that reaches egress, a narrow function or a log is kept. */
function mindWith(
  over: Record<string, ItxExpressionRewriteRule[]>,
  {
    appendFails = false,
    egressThrows = undefined as "INVALID_INPUT" | "LOOP_LIMIT" | undefined,
    appendThrows = undefined as "LOOP_LIMIT" | undefined,
    // the kernel's own egress (./egress.ts), with its loop guard, before the host's (below)
    throughTheKernel = false,
    egressError = undefined as Error | undefined,
    heldVerbs = [] as { verb: string }[],
    // as a context's Durable Object reads its caller: one store, which the latest call sets
    oneStore = false,
  } = {},
) {
  heldVerbsNow = heldVerbs;
  const tables: Record<string, ItxExpressionRewriteRule[]> = { "/": ROOT_ROWS, ...over };
  const rowsOf = (path: string) => tables[path] ?? [];
  const egress: { url: string; signFor: string }[] = [];
  const narrowed: { at: string; args: unknown[] }[] = [];
  const appended: ({ path: string } & StreamEventInput)[] = [];
  // each record's `source`, as the append boundary stamps it (../caller.ts `stampCaller`)
  const sources: NonNullable<StreamEventInput["source"]>[] = [];
  // the cause each record is appended with: the built-in append keys by its `writeKey`
  const causes: Caller["cause"][] = [];
  const background: Promise<unknown>[] = [];
  let refusal = "";
  let store: Caller | undefined;
  const gates: (() => void)[] = [];
  // what a narrow function does: the request alone goes on to the built-in, through the root
  const narrowAt =
    (at: string) =>
    async (...args: unknown[]) => {
      narrowed.push({ at, args: args.map((arg) => (arg instanceof Request ? arg.url : arg)) });
      const request = args.find((arg) => arg instanceof Request);
      if (request)
        await resolverAt("/", { principal: null }, false).invoke(["itx", ["fetch", request]]);
      return "narrowed";
    };
  // the host's egress: what the Door would do
  const hostEgress = async (request: Request, options?: { signFor?: string }) => {
    egress.push({ url: request.url, signFor: options?.signFor || "" });
    if (oneStore) await new Promise<void>((resolve) => gates.push(resolve));
    if (egressThrows) throw codedError(egressThrows, "the Door refuses");
    if (egressError) throw egressError;
    return new Response("sent");
  };
  hostEgressNow = hostEgress;
  const resolverAt = (path: string, caller: Caller, stateless: boolean): ItxExpressionResolver => {
    const portable = buildPortableBuiltIns({
      path,
      caller: () => (oneStore ? store! : caller),
      context: (there: string) =>
        ({
          invoke: async (call: unknown[], _args: unknown[], asCaller: Caller) => {
            if (appendFails) throw new Error("the log is away");
            if (appendThrows) throw codedError(appendThrows, "an act past the limit");
            // the one call the record makes: the built-in append, as the platform
            const [, , [verb, ...events]] = call as [
              string,
              string,
              [string, ...StreamEventInput[]],
            ];
            refuseNonPlatformWrites(events, asCaller);
            if (verb !== "append") throw new Error("the record appends");
            appended.push(...events.map((event) => ({ path: there, ...event })));
            sources.push(...events.map((event) => stampCaller(event, asCaller, there).source));
            causes.push(asCaller.cause);
            return [];
          },
        }) as never,
      egress: (request, options) =>
        throughTheKernel
          ? kernelEgress(request, { cause: (oneStore ? store! : caller).cause, path, ...options })
          : hostEgress(request, options),
      afterTheAnswer: (work) => background.push(work),
      invokeAs: (callerThere, call) => resolverAt(path, callerThere, stateless).invoke(call),
      itx: {} as never,
    });
    const builtIns: Record<string, unknown> = {
      ...portable,
      ...(!stateless && {
        facets: {
          get: (name: string) =>
            name === "config" ? { jailFetch: narrowAt(path) } : { fetch: narrowAt(path) },
        },
      }),
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
        workersOf: (there) => ({ get: () => ({ fetch: narrowAt(there) }) }),
      },
    });
  };
  /** A call from `at`: the context's own (stateful), or loaded code's (stateless), as
   *  ../iterate-context.ts `ItxEntrypoint` sends it. */
  const outcome = async (
    at: string,
    call: ItxExpressionInput,
    stateless: boolean,
    caller: Caller = stateless ? { principal: null, app: true } : { principal: null },
  ) => {
    const expression = normalizedItxExpression(call);
    store = caller;
    try {
      const answer = await resolverAt(at, caller, stateless).invoke(expression);
      return answer instanceof Response ? await answer.text() : answer;
    } catch (error) {
      refusal = String(error);
      const code = errorCode(error);
      if (code === "NO_ITX_EXPRESSION_MATCH") return "refused";
      if (code === "FORBIDDEN") return "forbidden";
      if (code === "INVALID_INPUT") return "invalid";
      return "failed";
    }
  };
  const request = () => new Request("https://peer.example/who?q=1", { method: "POST", body: "b" });
  return {
    egress,
    narrowed,
    appended,
    sources,
    causes,
    get refusal() {
      return refusal;
    },
    afterTheAnswer: () => Promise.all(background),
    /** Lets every egress that waits go on, in the order they began. */
    openEgress: () => gates.splice(0).forEach((open) => open()),
    sendTo: (url: string, caller: Caller) =>
      outcome(
        "/",
        ["itx", "minds", ["get", PEER], ["fetch", new Request(url, { method: "POST" })]],
        false,
        caller,
      ),
    signedAs: (at: string, caller: Caller, stateless: boolean) =>
      outcome(at, ["itx", "minds", ["get", PEER], ["fetch", request()]], stateless, caller),
    signedFrom: (at: string, { stateless = false } = {}) => {
      // as loaded code's entrypoint routes it: stateless, as this file's caller says
      expect(entersOwnRoot(["itx", "minds"])).toBe(true);
      return outcome(at, ["itx", "minds", ["get", PEER], ["fetch", request()]], stateless);
    },
    fetchFrom: (at: string, { stateless = false, signFor = PEER } = {}) =>
      outcome(at, ["itx", ["fetch", request(), { signFor }]], stateless),
    fetchFirst: (at: string, first: unknown) => outcome(at, ["itx", ["fetch", first]], false),
    fetchWith: (at: string, more: unknown[], stateless = false) =>
      outcome(at, ["itx", ["fetch", request(), ...more]], stateless),
  };
}
