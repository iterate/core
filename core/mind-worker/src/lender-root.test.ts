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

test("a key's session has no other name of itx", () => {
  const names = Object.getOwnPropertyNames(LenderRoot.prototype).toSorted();
  expect(names).toEqual(["constructor", "provide", "whoami"]);
});

// the options come off the wire, so a caller can send any
type Call = { match: string; target: unknown; options: Record<string, unknown> };

function stub() {}

function session() {
  const lent: unknown[][] = [];
  const root = new LenderRoot(
    { provide: async (...call: unknown[]) => void lent.push(call) } as never,
    { actor: "bridge-whatsapp-jonas", key: "key:k1", provide: "whatsapp.jonas" },
  );
  return { root, lent };
}
