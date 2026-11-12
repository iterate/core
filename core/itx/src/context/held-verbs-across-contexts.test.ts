import { actOfText, actText, type ActRule, type GateAnswer } from "iterate/acts";
import { expect, test } from "vitest";
import type { Caller } from "../caller.ts";
import { defineItxHost } from "../host.ts";
import {
  type ItxExpressionRewriteRule,
  ItxExpressionResolver,
} from "./itx-expression-rewriting.ts";

test("a rule for a verb whose row crosses to another context holds the call where it is walked, and the act says that the root read its name", async () => {
  const mind = mindWith([{ verb: "itx.agents.delete" }]);

  await expect(mind.at("/").invoke("itx.agents.delete", "/agents/one")).rejects.toThrow(
    "itx.agents.delete: a member rejected this call: not this one",
  );
  // a verb beside it, which no rule names, runs
  await mind.at("/").invoke("itx.agents.list()");

  expect({ ran: mind.ran, held: mind.held() }).toEqual({
    ran: ["/agents: list"],
    held: [
      {
        act: "itx.agents.delete",
        args: ["/agents/one"],
        at: "/",
        resolved: expect.any(String),
        from: "/",
      },
    ],
  });
});

test("the facet's own name, with no spec, is the same verb to the root's rule", async () => {
  const mind = mindWith([{ verb: "itx.agents.delete" }]);

  await expect(
    mind
      .at("/")
      .invoke(["itx", ["cd", "/agents"], "facets", ["get", "agents"], ["delete", "/agents/one"]]),
  ).rejects.toThrow("itx.agents.delete: a member rejected this call");

  expect({ ran: mind.ran, held: mind.held() }).toMatchObject({
    ran: [],
    held: [{ act: "itx.agents.delete", args: ["/agents/one"], at: "/" }],
  });
});

test("a name of the context's own table is read there, and the act says so", async () => {
  const mind = mindWith([{ verb: "itx.own.delete" }]);

  await expect(mind.at("/agents").invoke("itx.own.delete", "/agents/one")).rejects.toThrow(
    "rejected this call",
  );

  expect({ ran: mind.ran, held: mind.held() }).toMatchObject({
    ran: [],
    held: [{ act: "itx.own.delete", at: "/agents", from: "/agents" }],
  });
});

test("a late approval calls the name at the context that read it: the act's own text runs once there, and another text does not", async () => {
  const mind = mindWith([{ verb: "itx.agents.delete" }]);
  await mind
    .at("/")
    .invoke("itx.agents.delete", "/agents/one")
    .catch(() => undefined);
  const text = mind.asked[0]!.text;
  const approved = (approvedAct: string) =>
    mind
      .at("/", { principal: null, path: "/agents/web/caller" })
      .invokeApproved(approvedAct, "itx.agents.delete", ["/agents/one"]);

  await approved(text);
  await expect(
    approved(actText({ act: "itx.agents.delete", args: ["/agents/two"], at: "/" })),
  ).rejects.toThrow("changed while it waited for a member's approval");

  expect({ ran: mind.ran, asks: mind.asked.length }).toEqual({
    ran: ["/agents: delete /agents/one"],
    asks: 1,
  });
});

test("a call by the facet's own name is the same act as a call by the root's name, so its late approval, which calls the act's name, runs", async () => {
  const mind = mindWith([{ verb: "itx.agents.delete" }]);
  const refused = (call: Promise<unknown>) => call.catch(() => undefined);
  await refused(
    mind
      .at("/")
      .invoke(["itx", ["cd", "/agents"], "facets", ["get", "agents"], ["delete", "/agents/one"]]),
  );
  await refused(mind.at("/").invoke("itx.agents.delete", "/agents/one"));
  const [byTheFacetsName, byTheRootsName] = mind.asked.map((ask) => ask.text);

  await mind.at("/").invokeApproved(byTheFacetsName!, "itx.agents.delete", ["/agents/one"]);

  expect({ same: byTheFacetsName === byTheRootsName, ran: mind.ran }).toEqual({
    same: true,
    ran: ["/agents: delete /agents/one"],
  });
});

test("a call by the stub's own invoke is the same act as a call by the lent name, so its late approval runs", async () => {
  const mind = mindWith([{ verb: "itx.bridge.send" }]);
  await mind
    .at("/")
    .invoke(["itx", "rpcStubs", ["get", "k"], ["invoke", [["send", "jo"]]]])
    .catch(() => undefined);
  const text = mind.asked[0]!.text;

  await mind.at("/").invokeApproved(text, "itx.bridge.send", ["jo"]);

  expect({ held: mind.held(), ran: mind.ran }).toMatchObject({
    held: [{ act: "itx.bridge.send", args: ["jo"], at: "/" }],
    ran: ["/: send jo"],
  });
});

test("an approved text for a call that no rule holds now is refused: the member read a call that a rule held", async () => {
  const mind = mindWith([{ verb: "itx.agents.delete" }]);
  await mind
    .at("/")
    .invoke("itx.agents.delete", "/agents/one")
    .catch(() => undefined);
  const text = mind.asked[0]!.text;

  mind.gate.rules = [];

  await expect(
    mind.at("/").invokeApproved(text, "itx.agents.delete", ["/agents/one"]),
  ).rejects.toThrow("itx.agents.delete changed while it waited for a member's approval");
  expect(mind).toMatchObject({ ran: [] });
});

test.for(["the same context", "another context, where the call is sent on"] as const)(
  "a call whose name goes, while it waits, to a function of %s that no rule holds is not run when the member approves",
  async (where) => {
    // the rule names the bridge: it holds the bridge's verbs and no other function
    const mind = mindWith([{ verb: "itx.bridge" }]);
    const target: ItxExpressionRewriteRule["target"] =
      where === "the same context"
        ? ["itx", "facets", ["get", "agents", spec], "list"]
        : ["itx", "agents", "list"];
    mind.gate.answer = () => {
      // while the call waits, a row for the verb's own name sends it elsewhere; then the member's yes
      mind.rows["/"]!.push({ match: ["itx", "bridge", "send"], target });
      return { state: "go", digest: "d", facts: [] };
    };

    await expect(mind.at("/").invoke("itx.bridge.send", "jo")).rejects.toThrow(
      "itx.bridge.send changed while it waited for a member's approval",
    );
    expect(mind).toMatchObject({ ran: [] });
  },
);

test("an act that loaded code asked for says so, and its late approval runs as loaded code or not at all", async () => {
  const mind = mindWith([{ verb: "itx.agents.delete" }]);
  const loadedCode = { principal: null, app: true } as const;
  await mind
    .at("/", loadedCode)
    .invoke("itx.agents.delete", "/agents/one")
    .catch(() => undefined);
  const text = mind.asked[0]!.text;
  const approved = (caller: Caller) =>
    mind.at("/", caller).invokeApproved(text, "itx.agents.delete", ["/agents/one"]);

  await expect(approved({ principal: null })).rejects.toThrow(
    "changed while it waited for a member's approval",
  );
  await approved(loadedCode);

  expect({ held: mind.held(), ran: mind.ran }).toMatchObject({
    held: [{ act: "itx.agents.delete", at: "/", byLoadedCode: true }],
    ran: ["/agents: delete /agents/one"],
  });
});

test("an act that a stored row's run asked for says so, and its late approval runs as a row's run or not at all", async () => {
  const mind = mindWith([{ verb: "itx.agents.delete" }]);
  // as the ingress row's target is run for a request: the person who asks, and the mark
  const rowsRun = { principal: null, runsRow: true } as const;
  await mind
    .at("/", rowsRun)
    .invoke("itx.agents.delete", "/agents/one")
    .catch(() => undefined);
  const text = mind.asked[0]!.text;
  const approved = (caller: Caller) =>
    mind.at("/", caller).invokeApproved(text, "itx.agents.delete", ["/agents/one"]);

  // without the mark the call is another act: what it writes would not be checked
  await expect(approved({ principal: null })).rejects.toThrow(
    "changed while it waited for a member's approval",
  );
  await approved(rowsRun);

  expect({ held: mind.held(), ran: mind.ran }).toMatchObject({
    held: [{ act: "itx.agents.delete", at: "/", byRow: true }],
    ran: ["/agents: delete /agents/one"],
  });
});

test("a subscription does not deliver to a verb that a rule holds across contexts, and delivers to the verb beside it", async () => {
  const mind = mindWith([{ verb: "itx.agents.delete" }]);

  await expect(mind.at("/").refuseHeldVerb(["itx", "agents", "delete"])).rejects.toThrow(
    "waits for a member's approval when it is called, so a subscription does not deliver to it",
  );
  await expect(mind.at("/").refuseHeldVerb(["itx", "agents", "list"])).resolves.toBeUndefined();
});

// A mind of two contexts. The root's `itx.agents` is a facet of `/agents`, found with a spec: a
// call of it is sent on to `/agents` and walked there, and the table there has no name `itx.agents`.
const spec = { className: "AgentCollection" };
const tables: Record<string, ItxExpressionRewriteRule[]> = {
  "/": [
    {
      match: ["itx", "agents"],
      target: ["itx", ["cd", "/agents"], "facets", ["get", "agents", spec]],
    },
    // a bridge that is lent at the root
    { match: ["itx", "bridge"], target: ["itx", "rpcStubs", ["get", "k"]] },
  ],
  "/agents": [{ match: ["itx", "own"], target: ["itx", "facets", ["get", "agents", spec]] }],
};

type Ask = { text: string; from?: string };
type Gate = { rules: ActRule[]; asked: Ask[]; answer: (ask: Ask) => GateAnswer };
/** What the one host of this file reads: the gate of the test that runs. */
let now: Gate = { rules: [], asked: [], answer: rejects };
function rejects(): GateAnswer {
  return { state: "rejected", digest: "d", reason: "not this one", by: "a member", facts: [] };
}
defineItxHost({
  firstPartyFacets: {},
  acts: {
    verbRules: async () => now.rules,
    ask: async ({ text, from }) => {
      now.asked.push({ text, from });
      return now.answer({ text, from });
    },
  },
});

/** The mind with these approval rules, and a member who rejects each act at once unless the test
 *  gives the gate another answer: a resolver at each context, each context's rows, what its
 *  functions ran, and what the gate was asked. */
function mindWith(rules: ActRule[]) {
  const ran: string[] = [];
  const gate: Gate = { rules, asked: [], answer: rejects };
  now = gate;
  const rows = Object.fromEntries(
    Object.entries(tables).map(([path, table]) => [path, [...table]]),
  );
  const at = (path: string, caller: Caller = { principal: null }): ItxExpressionResolver => {
    const collection = {
      list: () => ran.push(`${path}: list`),
      delete: (agent: string) => ran.push(`${path}: delete ${agent}`),
    };
    return new ItxExpressionResolver({
      path,
      caller: () => caller,
      rewriteRules: () => rows[path]!,
      builtIns: {
        facets: { get: () => collection },
        rpcStubs: { get: () => ({ send: (to: string) => ran.push(`${path}: send ${to}`) }) },
      },
      reach: {
        recordLoopLimit: () => undefined,
        snapshotOf: async (there) => ({
          rules: rows[there]!,
          readAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
        // as a context's own entry does: an approved text is taken off the caller for that call
        located: (there, expression, args, { approvedAct, ...callerThere }) =>
          approvedAct
            ? at(there, callerThere).invokeApproved(approvedAct, expression, args)
            : at(there, callerThere).invoke(expression, ...args),
        workersOf: () => ({}),
      },
    });
  };
  return {
    at,
    gate,
    rows,
    asked: gate.asked,
    ran,
    held: () => gate.asked.map(({ text, from }) => ({ ...actOfText(text), from })),
  };
}
