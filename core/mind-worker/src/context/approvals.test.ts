import type { ItxHostRootContext } from "core-itx";
import { ActRule } from "iterate/acts";
import { expect, test } from "vitest";
import { approvalsRoot } from "./approvals.ts";

test("what the gate answers the mind's own code is released when it has been read: rules, a set and a proposal", async () => {
  const gate = pretendGate();
  appended = gate.mindAppended;
  const approvals = approvalsRoot(mind(), gate.egress, "example.com");

  expect(await approvals.rules()).toEqual({ locked: false, rules: [rule] });
  expect(gate.open()).toBe(0);
  // an answer with facts: its facts are appended from the copy, and its session is let go
  expect(await approvals.setRules([rule])).toEqual([rule]);
  expect(gate.open()).toBe(0);
  expect(await approvals.propose(rule)).toEqual({
    id: "p1",
    signAt: "https://iterate.example.com/secrets/approvals",
  });
  expect(gate.open()).toBe(0);
  expect(gate).toMatchObject({ asked: 3, released: 3, appended: 2 });
});

test("the link for a secret's rule holds the lists that are given, and a list given as nothing is no part of it", () => {
  const approvals = approvalsRoot(mind(), pretendGate().egress, "example.com");
  const page = "https://iterate.example.com/secrets/approvals";
  expect(
    approvals.secretRuleLink("/secrets/fastmail", {
      methods: ["POST"],
      hosts: ["api.fastmail.com"],
      jsonStrings: ["EmailSubmission/set"],
      freePaths: ["/jmap/upload/"],
    }),
  ).toBe(
    `${page}?path=%2Fsecrets%2Ffastmail&methods=POST&hosts=api.fastmail.com&jsonStrings=EmailSubmission%2Fset&freePaths=%2Fjmap%2Fupload%2F#offered`,
  );
  // a caller that spreads an object with the two lists unset, or empty, hands them over so
  expect(
    approvals.secretRuleLink("/secrets/x", {
      methods: ["POST", "PUT"],
      hosts: ["example.com"],
      jsonStrings: undefined,
      freePaths: [],
    }),
  ).toBe(`${page}?path=%2Fsecrets%2Fx&methods=POST%2CPUT&hosts=example.com#offered`);
});

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
