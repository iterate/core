import { expect, test } from "vitest";
import { LenderRoot } from "./lender-root.ts";

test("a key's session lends a live stub at its own name, with a description and nothing more", async () => {
  const { root, lent } = session();
  await root.provide("itx.whatsapp.jonas", stub, { description: "WhatsApp" });
  await root.provide(["itx", "whatsapp", "jonas"], stub);
  expect(lent).toEqual([
    ["itx.whatsapp.jonas", stub, { description: "WhatsApp" }],
    ["itx.whatsapp.jonas", stub, {}],
  ]);
  expect(root.whoami()).toEqual({
    path: "/",
    principal: { actor: "bridge-whatsapp-jonas" },
    lends: "itx.whatsapp.jonas",
  });
});

test.for([
  ["another name", { match: "itx.secrets" }, /lends itx.whatsapp.jonas and nothing else/],
  ["a name under its own", { match: "itx.whatsapp.jonas.x" }, /nothing else/],
  ["a row that names something of the mind's", { target: "itx.secrets" }, /a live stub/],
  ["a lend taken away", { target: null }, /a live stub/],
  [
    "a fetch route",
    { options: { fetchRoute: { fetchRouteName: "x", hostname: "example.com" } } },
    /no other option/,
  ],
] as const)("a key's session refuses %s", ([, call, why]) => {
  const { root, lent } = session();
  // each row changes one part of a call that would be taken
  const sent: Call = { match: "itx.whatsapp.jonas", target: stub, options: {}, ...call };
  expect(() => root.provide(sent.match, sent.target, sent.options)).toThrow(why);
  expect(lent).toEqual([]);
});

test.for([
  "secrets",
  "fetch",
  "email.send",
  "repos",
  "run",
  "config",
  "config.whatsapp",
  "builtins",
])("a key enrolled to lend itx.%s lends nothing: the name is the platform's own", (provide) => {
  const { root, lent } = session(provide);
  expect(() => root.provide(`itx.${provide}`, stub)).toThrow(/is the platform's own name/);
  expect(lent).toEqual([]);
});

const TAKEN: [what: string, provide: string, row: { match: string; target: string | null }][] = [
  [
    "a row of an app above it",
    "agents.create",
    { match: "itx.agents", target: "itx.cd('/agents').facets.get('agents')" },
  ],
  [
    "another key's lend above it",
    "whatsapp.jonas",
    { match: "itx.whatsapp", target: "itx.builtins.rpcStubs.get('itx.whatsapp')" },
  ],
  ["a row at it that is no lend", "whatsapp", { match: "itx.whatsapp", target: "itx.config.wa" }],
  // the mind said that nothing answers here: a lend under the mask would answer
  ["a mask above it", "foo.bar", { match: "itx.foo", target: null }],
  ["a mask at it", "foo", { match: "itx.foo", target: null }],
  // the key would take every name of `foo` but this one
  ["a row under it", "foo", { match: "itx.foo.sub", target: "itx.config.sub" }],
];
test.for(TAKEN)(
  "a key's name with %s in the mind's table lends nothing",
  async ([, provide, row]) => {
    const { root, lent } = session(provide, [row]);
    await expect(root.provide(`itx.${provide}`, stub)).rejects.toThrow(
      /a name this mind uses already/,
    );
    expect(lent).toEqual([]);
  },
);

test("a key's own lend from before, and rows of other names, leave its name free", async () => {
  const { root, lent } = session("whatsapp.jonas", [
    { match: "itx.whatsapp.jonas", target: "itx.builtins.rpcStubs.get('itx.whatsapp.jonas')" },
    { match: "itx.whatsapp.jeeves", target: "itx.builtins.rpcStubs.get('itx.whatsapp.jeeves')" },
    { match: "itx.agents", target: "itx.cd('/agents').facets.get('agents')" },
    { match: "itx.secrets", target: "itx.builtins.secrets" },
  ]);
  await root.provide("itx.whatsapp.jonas", stub);
  expect(lent).toEqual([["itx.whatsapp.jonas", stub, {}]]);
});

test("a table that cannot be read lends nothing", async () => {
  const { root, lent } = session("whatsapp.jonas", new Error("the mind is away"));
  await expect(root.provide("itx.whatsapp.jonas", stub)).rejects.toThrow("the mind is away");
  expect(lent).toEqual([]);
});

test("a key's session has no other name of itx", () => {
  const names = Object.getOwnPropertyNames(LenderRoot.prototype).toSorted();
  expect(names).toEqual(["constructor", "provide", "whoami"]);
});

// the options come off the wire, so a caller can send any
type Call = { match: string; target: unknown; options: Record<string, unknown> };

function stub() {}

/** `rows`: the rows of the mind's root, as `rewriteRules.list()` answers, or why it cannot. */
function session(
  provide = "whatsapp.jonas",
  rows: { match: string; target: string | null }[] | Error = [],
) {
  const lent: unknown[][] = [];
  const root = new LenderRoot(
    {
      provide: async (...call: unknown[]) => void lent.push(call),
      invoke: async () => {
        if (rows instanceof Error) throw rows;
        return rows.map((row) => ({ ...row, context: "/" }));
      },
    } as never,
    { actor: "bridge-whatsapp-jonas", key: "key:k1", provide },
    new Set(["secrets", "fetch", "email", "repos", "run"]),
  );
  return { root, lent };
}
