// The default config's old-rule cleanup (core/configs/default/telemetry-query-rule.ts): at each
// publish, an old row `itx.telemetry.query ⇒ itx.config.telemetryQuery` goes, so the platform's
// query keeps one name.
import { expect, test } from "vitest";
import { removeOwnTelemetryQueryRule } from "../../configs/default/telemetry-query-rule.ts";

test("the publish removes the old row on `itx.telemetry.query`, by a compare-and-set delete", async () => {
  const { itx, appended } = rootWith({
    match: "itx.telemetry.query",
    target: "itx.config.telemetryQuery",
    context: "/",
  });
  expect(await removeOwnTelemetryQueryRule(itx)).toBe(true);
  expect(appended).toEqual([
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: "itx.telemetry.query",
        target: null,
        ifTarget: "itx.config.telemetryQuery",
      },
    },
  ]);
});

test("a mind with no such row, or a row a member pointed elsewhere, keeps what it has", async () => {
  for (const row of [
    null,
    { match: "itx.telemetry.query", target: "itx.config.myOwnQuery", context: "/" },
    { match: "itx.telemetry.query", target: null, context: "/" },
  ]) {
    const { itx, appended } = rootWith(row);
    expect(await removeOwnTelemetryQueryRule(itx)).toBe(false);
    expect(appended).toEqual([]);
  }
});

/** A root whose `rewriteRules.get("itx.telemetry.query")` answers `row`, and that records each
 *  append. */
function rootWith(row: { match: string; target: string | null; context: string } | null) {
  const appended: unknown[] = [];
  const root = {
    rewriteRules: {
      get: async (match: string) => (match === "itx.telemetry.query" ? row : null),
    },
    append: async (event: unknown) => {
      appended.push(event);
    },
  };
  const itx = { cd: () => root } as unknown as Parameters<typeof removeOwnTelemetryQueryRule>[0];
  return { itx, appended };
}
