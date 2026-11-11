import { codedError } from "iterate/lib";
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

test("a key's name that the mind's table gives to something else lends nothing, and its own lend from before is lent again", async () => {
  const app = session("agents.create", "itx.cd('/agents').facets.get('agents').create");
  await expect(app.root.provide("itx.agents.create", stub)).rejects.toThrow(
    /a name this mind uses already/,
  );
  const under = session("whatsapp.jonas", "itx.builtins.rpcStubs.get('itx.whatsapp').jonas");
  await expect(under.root.provide("itx.whatsapp.jonas", stub)).rejects.toThrow(/uses already/);
  const again = session("whatsapp.jonas", "itx.builtins.rpcStubs.get('itx.whatsapp.jonas')");
  await again.root.provide("itx.whatsapp.jonas", stub);
  expect([app.lent, under.lent, again.lent]).toEqual([[], [], [["itx.whatsapp.jonas", stub, {}]]]);
});

test("a key's session has no other name of itx", () => {
  const names = Object.getOwnPropertyNames(LenderRoot.prototype).toSorted();
  expect(names).toEqual(["constructor", "provide", "whoami"]);
});

// the options come off the wire, so a caller can send any
type Call = { match: string; target: unknown; options: Record<string, unknown> };

function stub() {}

/** `resolved`: what the mind's table makes of the key's name now. None: no rule matches it. */
function session(provide = "whatsapp.jonas", resolved?: string) {
  const lent: unknown[][] = [];
  const root = new LenderRoot(
    {
      provide: async (...call: unknown[]) => void lent.push(call),
      invoke: async () => {
        if (!resolved) throw codedError("NO_ITX_EXPRESSION_MATCH", "no rewrite rule matches");
        return [`itx.${provide}`, resolved];
      },
    } as never,
    { actor: "bridge-whatsapp-jonas", key: "key:k1", provide },
    new Set(["secrets", "fetch", "email", "repos", "run"]),
  );
  return { root, lent };
}
