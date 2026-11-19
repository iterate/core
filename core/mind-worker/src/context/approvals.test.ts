import type { ItxHostRootContext } from "core-itx";
import { ActRule } from "iterate/acts";
import { expect, test } from "vitest";
import { approvalsRoot } from "./approvals.ts";

test("what the gate answers the mind's own code is released when it has been read: rules, a set and a proposal", async () => {
  const gate = pretendGate();
  appended = gate.mindAppended;
  const approvals = approvalsRoot(mind(), gate.egress, "https://iterate.example.com");

  expect(await approvals.rules()).toEqual({ locked: false, rules: [rule] });
  expect(gate.open()).toBe(0);
  // an answer with facts: its facts are appended from the copy, and its session is let go
  expect(await approvals.setRules([rule])).toEqual([rule]);
  expect(gate.open()).toBe(0);
  expect(await approvals.propose(rule)).toEqual({
    id: "p1",
    // the page's address and the place of the proposed rules on it: no word of the rule
    signAt: "https://iterate.example.com/secrets/approvals#proposed",
  });
  expect(gate.open()).toBe(0);
  expect(gate).toMatchObject({ asked: 3, released: 3, appended: 2 });
});

test("a proposed statement names the calling context as its asker and answers the page's link", async () => {
  const asked: unknown[] = [];
  const egress = {
    ...pretendGate().egress,
    proposeStatement: async (input: unknown) => {
      asked.push(input);
      return {
        draft: "d1",
        signAt: "https://iterate.example.com/statements/sign?draft=d1",
        expires: 1,
      };
    },
  };
  const caller = { ...mind(), caller: () => ({ principal: null, path: "/agents/onboarding" }) };
  const approvals = approvalsRoot(
    caller as unknown as ItxHostRootContext,
    egress,
    "https://iterate.example.com",
  );
  expect(
    await approvals.proposeStatement({
      path: "/minds/example.org",
      type: "demo/statement-asked",
      payload: { append: ["/"] },
    }),
  ).toEqual({
    draft: "d1",
    signAt: "https://iterate.example.com/statements/sign?draft=d1",
    expires: 1,
  });
  expect(asked).toEqual([
    {
      path: "/minds/example.org",
      type: "demo/statement-asked",
      payload: { append: ["/"] },
      from: "/agents/onboarding",
      // no member, person or mind behind the call: the agent's own turn
      by: { kind: "code" },
    },
  ]);
});

test.for([
  [
    "a member",
    { principal: { actor: "user_ada", email: "ada@example.org" } },
    { kind: "member", email: "ada@example.org" },
  ],
  [
    "a signed-in person who is no member",
    { principal: null, person: { email: "bo@example.org", name: "Bo" } },
    { kind: "person", email: "bo@example.org" },
  ],
  [
    "a guest, by the name they typed",
    { principal: null, person: { email: "", name: "Cy" } },
    { kind: "guest", name: "Cy" },
  ],
  [
    "another mind",
    {
      principal: null,
      mind: { actor: "a".repeat(64), kind: "mind", hostname: "peer.example.net" },
    },
    { kind: "mind", hostname: "peer.example.net" },
  ],
] as const)(
  "a statement that %s proposes names them as the platform stamped them",
  async ([, stamp, by]) => {
    const asked: { by?: unknown }[] = [];
    const egress = {
      ...pretendGate().egress,
      proposeStatement: async (input: { by?: unknown }) => {
        asked.push(input);
        return { draft: "d1", signAt: "", expires: 1 };
      },
    };
    const caller = { ...mind(), caller: () => ({ ...stamp, path: "/" }) };
    const approvals = approvalsRoot(
      caller as unknown as ItxHostRootContext,
      egress,
      "https://iterate.example.com",
    );
    await approvals.proposeStatement({ path: "/minds/example.org", type: "demo/statement-asked" });
    expect(asked.map((input) => input.by)).toEqual([by]);
  },
);

const rule = ActRule.parse({ verb: "itx.whatsapp.sendMessage" });

/** The boundary's calls of the gate, as Workers RPC answers them: each answer holds its call's
 *  session open until its disposer runs. */
function pretendGate() {
  let open = 0;
  const counts = { asked: 0, released: 0, appended: 0 };
  const held = <T extends object>(answer: T): T => {
    counts.asked += 1;
    open += 1;
    return Object.defineProperty(answer, Symbol.dispose, {
      value: () => {
        open -= 1;
        counts.released += 1;
      },
    });
  };
  const facts = [{ path: "/approvals", events: [{ type: "proof/fact" }] }];
  return {
    egress: {
      actRules: async () => held({ locked: false, rules: [rule] }),
      setActRules: async () => held({ rules: [rule], facts }),
      proposeActRule: async () => held({ id: "p1", facts }),
      proposeStatement: async () => held({ draft: "d0", signAt: "", expires: 0 }),
    },
    open: () => open,
    get asked() {
      return counts.asked;
    },
    get released() {
      return counts.released;
    },
    get appended() {
      return counts.appended;
    },
    mindAppended: () => void (counts.appended += 1),
  };
}

let appended: () => void = () => {};
/** A mind whose contexts take the gate's facts. */
function mind(): ItxHostRootContext {
  return {
    path: "/",
    caller: () => ({ principal: null }),
    context: () => ({ invoke: async () => void appended() }),
  } as unknown as ItxHostRootContext;
}
