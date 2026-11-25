// telemetry-query-rule.ts — `itx.telemetry.query` IS THE PLATFORM'S ALONE, UNDER THAT ONE NAME.
// A mind's root may hold a rewrite rule that points it at `itx.config.telemetryQuery`, a method
// that this config does not have. Such a rule gives the platform's query a second name, which an
// approval rule on one name misses. The publish hook removes it (init.ts, the step
// "telemetry-query-rule").
import type { IterateContextApi } from "iterate/api";

const OWN_QUERY_RULE = { match: "itx.telemetry.query", target: "itx.config.telemetryQuery" };

/** Removes the row `itx.telemetry.query ⇒ itx.config.telemetryQuery` from the root's rewrite
 *  rules. A row that a member pointed elsewhere stays. Answers whether it removed one. */
export async function removeOwnTelemetryQueryRule(itx: Pick<IterateContextApi, "cd">) {
  const root = itx.cd("/");
  const row = await root.rewriteRules.get(OWN_QUERY_RULE.match);
  if (row?.context !== "/" || row.target !== OWN_QUERY_RULE.target) return false;
  // a compare-and-set delete: a row pointed elsewhere meanwhile is not removed
  await root.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: OWN_QUERY_RULE.match, target: null, ifTarget: OWN_QUERY_RULE.target },
  });
  return true;
}
