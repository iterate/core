import type { StreamEvent } from "iterate/stream/processor";
import { expect, test } from "vitest";
import { defineItxHost } from "../host.ts";
import { CoreContract, reduceCoreEventBatch } from "../stream/core-processor.ts";
import {
  describeRewriteRules,
  normalizeRewriteRuleConfigured,
} from "./itx-expression-rewriting.ts";
import { isLendOf, lendRefusal } from "./lent-names.ts";

test.for([
  "itx.secrets",
  "itx.secrets.set",
  "itx.fetch",
  "itx.email.send",
  "itx.run",
  "itx.builtins.rpcStubs",
  "itx.config",
  "itx.config.whatsapp",
  // a call step pins arguments and names the same root
  "itx.secrets('x')",
])("a stub is not lent as %s: the name is the platform's own", (match) => {
  expect(lendRefusal(match, roots)).toMatch(/is the platform's own name/);
});

test.for(["itx.whatsapp", "itx.whatsapp.jonas", "itx.secretsBridge", "itx.myConfig.secrets"])(
  "a stub is lent as %s",
  (match) => {
    expect(lendRefusal(match, roots)).toBeNull();
  },
);

test("the structured form of a name is read as its dotted form is", () => {
  expect([
    lendRefusal(["itx", "secrets", "set"], roots),
    lendRefusal(["itx", "whatsapp", "jonas"], roots),
  ]).toEqual([expect.stringContaining("itx.secrets"), null]);
});

test("a lend that names nothing is refused", () => {
  expect(lendRefusal("itx", roots)).toMatch(/names what it lends/);
});

test("a resolved call is a name's own lend only when it ends at the stub lent under that very name", () => {
  expect([
    isLendOf("itx.builtins.rpcStubs.get('itx.whatsapp.jonas')", "itx.whatsapp.jonas"),
    isLendOf(["itx", "builtins", "rpcStubs", ["get", "itx.whatsapp.jonas"]], "itx.whatsapp.jonas"),
    // another lend above it, a row of the mind's own, a built-in root
    isLendOf("itx.builtins.rpcStubs.get('itx.whatsapp').jonas", "itx.whatsapp.jonas"),
    isLendOf("itx.cd('/agents').facets.get('agents').create", "itx.agents.create"),
    isLendOf("itx.builtins.secrets", "itx.secrets"),
    // a rule above the name that points into the stub lent under that name
    isLendOf("itx.builtins.rpcStubs.get('itx.whatsapp.jonas').jonas", "itx.whatsapp.jonas"),
  ]).toEqual([true, true, false, false, false, false]);
});

test("a rule's event keeps the grant that lent it, and refuses one that is no short string", () => {
  const rule = (lentBy: unknown) =>
    normalizeRewriteRuleConfigured({ ...lendOfJonas, lentBy } as never);
  expect(rule("key:k1")).toMatchObject({ lentBy: "key:k1" });
  expect(rule(undefined)).not.toHaveProperty("lentBy");
  for (const bad of [7, {}, "k".repeat(201)])
    expect(() => rule(bad)).toThrow(/lentBy is the grant that lent it/);
});

test("the table stores who lent a row, and the same lend by another lender replaces it", () => {
  const reduced = (payloads: Record<string, unknown>[]) =>
    reduceCoreEventBatch(
      payloads.map((payload, index) => ruleEvent(index + 1, payload)),
      CoreContract.initialState(),
      (error) => {
        throw error;
      },
    );
  const once = reduced([{ ...lendOfJonas, lentBy: "grant:member" }]);
  expect(once).toMatchObject({
    snapshotVersion: 1,
    itxExpressionRewriteRules: { "itx.whatsapp.jonas": { lentBy: "grant:member" } },
  });
  const again = reduced([
    { ...lendOfJonas, lentBy: "grant:member" },
    { ...lendOfJonas, lentBy: "grant:member" },
  ]);
  expect(again).toMatchObject({ snapshotVersion: 1 });
  const replaced = reduced([
    { ...lendOfJonas, lentBy: "grant:member" },
    { ...lendOfJonas, lentBy: "key:k1" },
  ]);
  expect(replaced).toMatchObject({
    snapshotVersion: 2,
    itxExpressionRewriteRules: { "itx.whatsapp.jonas": { lentBy: "key:k1" } },
  });
  // a mask (under a row, where a mask is stored) records no lender
  const masked = reduced([
    { match: "itx.whatsapp", target: "itx.builtins.rpcStubs.get('itx.whatsapp')" },
    { match: "itx.whatsapp.jonas", target: null, lentBy: "key:k1" },
  ]);
  expect(masked.itxExpressionRewriteRules["itx.whatsapp.jonas"]).toEqual({
    match: ["itx", "whatsapp", "jonas"],
    target: null,
  });
});

test("a context's list answers who lent each of its own rows", async () => {
  const rules = Object.values(
    reduceCoreEventBatch(
      [ruleEvent(1, { ...lendOfJonas, lentBy: "key:k1" })],
      CoreContract.initialState(),
      (error) => {
        throw error;
      },
    ).itxExpressionRewriteRules,
  );
  const rows = await describeRewriteRules({
    rules,
    implicitRoots: new Set(),
    path: "/",
    depth: 0,
    inherit: async () => [],
  });
  expect(rows).toEqual([{ ...lendOfJonas, lentBy: "key:k1", context: "/" }]);
});

// some of the kernel's roots and of a host's
const roots = new Set(["secrets", "fetch", "email", "run", "repos", "whoami"]);

defineItxHost({ firstPartyFacets: {} });

const lendOfJonas = {
  match: "itx.whatsapp.jonas",
  target: "itx.builtins.rpcStubs.get('itx.whatsapp.jonas')",
};

function ruleEvent(offset: number, payload: Record<string, unknown>): StreamEvent {
  return {
    offset,
    path: "/",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: { origin: "/" },
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload,
  };
}
