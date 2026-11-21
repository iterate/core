// The row that a mind's turn-on of its own telemetry tables writes (core/configs/default/telemetry.ts),
// by the real resolver (./itx-expression-rewriting.ts).
import { parse, print } from "iterate/expression";
import { expect, test } from "vitest";
import {
  normalizeRewriteRuleConfigured,
  resolveItxExpression,
} from "./itx-expression-rewriting.ts";

test("`itx.telemetry.query ⇒ itx.config.telemetryQuery` carries the call's arguments, and leaves `itx.telemetry.cut` to the built-in", () => {
  const rule = normalizeRewriteRuleConfigured({
    match: "itx.telemetry.query",
    target: "itx.config.telemetryQuery",
  });
  const chain = (call: string) =>
    resolveItxExpression(() => [rule], parse(call), new Set(["telemetry", "config"])).map((step) =>
      print(step),
    );
  expect(chain("itx.telemetry.query('x', { hours: 1 })")[1]).toBe(
    print(parse("itx.config.telemetryQuery('x', { hours: 1 })")),
  );
  expect(chain("itx.telemetry.cut('x', { hours: 1 })")).toEqual([
    print(parse("itx.telemetry.cut('x', { hours: 1 })")),
    print(parse("itx.builtins.telemetry.cut('x', { hours: 1 })")),
  ]);
});
