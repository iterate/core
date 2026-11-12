import { expect, test } from "vitest";
import { admitLoadedCodeRow } from "./itx-expression-rewriting.ts";

const ROWS = [
  "events.iterate.com/itx/rewrite-rule-configured",
  "events.iterate.com/itx/subscription-configured",
  // its target answers the next request on the mind's hosts, as the person who makes it
  "events.iterate.com/itx/ingress-configured",
];

test.for(ROWS)("loaded code writes no %s row whose target is a built-in", (type) => {
  for (const target of ["itx.builtins.cd('/').secrets", ["itx", "builtins", "fetch"]])
    expect(() =>
      admitLoadedCodeRow({ type, payload: { match: "itx.x", target } }, "/apps/x"),
    ).toThrow("is not a loaded worker's word");
});

test.for(ROWS)("loaded code writes a %s row whose target is a name of its own context", (type) => {
  expect(() =>
    admitLoadedCodeRow({ type, payload: { match: "itx.x", target: "itx.site.fetch" } }, "/apps/x"),
  ).not.toThrow();
  // no target: the row is taken away, or ingress is off
  expect(() => admitLoadedCodeRow({ type, payload: { target: null } }, "/apps/x")).not.toThrow();
});
