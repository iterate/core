import { expect, test } from "vitest";
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
  ]).toEqual([true, true, false, false, false]);
});

// some of the kernel's roots and of a host's
const roots = new Set(["secrets", "fetch", "email", "run", "repos", "whoami"]);
