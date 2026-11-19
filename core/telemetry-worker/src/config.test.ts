import assert from "node:assert/strict";
import { test } from "node:test";
import { telemetryWorkerConfigOf } from "./config.ts";

void test("the stack's variables become the Worker's settings, and a binding beside them is not read", () => {
  const config = telemetryWorkerConfigOf({ ...stackVariables(), METRICS: {} });
  assert.equal(config.controlPlaneHostname, "iterate.example.com");
  assert.equal(config.telemetryBucketName, "iterate-example-com-telemetry");
  assert.deepEqual(config.workerNamesThatQueriesReadWhole, [
    "iterate-example-com-mind",
    "iterate-example-com-boundary",
  ]);
  assert.equal(config.eventsWriterName, "iterate-example-com-mind");
  assert.equal(config.otlpSecret.exposeSecret(), "the-otlp-secret");
  assert.equal(config.catalogToken?.exposeSecret(), "the-catalog-token");
  assert.equal(config.analyticsToken?.exposeSecret(), "the-analytics-token");
});

void test("no secret prints", () => {
  const printed = JSON.stringify(telemetryWorkerConfigOf(stackVariables()));
  for (const secret of ["the-otlp-secret", "the-catalog-token", "the-analytics-token"])
    assert.equal(printed.includes(secret), false);
});

void test("a missing otlpSecret is refused by its name, while catalogToken and analyticsToken are optional", () => {
  const { ITERATE__OTLP_SECRET: _, ...withoutOtlp } = stackVariables();
  assert.throws(
    () => telemetryWorkerConfigOf(withoutOtlp),
    /ITERATE otlpSecret \(ITERATE__OTLP_SECRET\)/,
  );

  const {
    ITERATE__CATALOG_TOKEN: _catalog,
    ITERATE__ANALYTICS_TOKEN: _analytics,
    ...withoutTelemetryTokens
  } = stackVariables();
  const config = telemetryWorkerConfigOf(withoutTelemetryTokens);
  assert.equal(config.catalogToken, undefined);
  assert.equal(config.analyticsToken, undefined);
});

void test("one env is parsed once", () => {
  const env = stackVariables();
  assert.equal(telemetryWorkerConfigOf(env), telemetryWorkerConfigOf(env));
});

function stackVariables() {
  return {
    ITERATE: JSON.stringify({
      mindId: "a".repeat(64),
      controlPlaneHostname: "iterate.example.com",
      zones: ["example.com"],
      ownerEmails: ["ada@example.org"],
      topology: "full-cloudflare",
      accountId: "the-account-id",
      telemetryBucketName: "iterate-example-com-telemetry",
      metricsDatasetName: "iterate_example_com_metrics",
      workerNamesThatQueriesReadWhole: ["iterate-example-com-mind", "iterate-example-com-boundary"],
      eventsWriterName: "iterate-example-com-mind",
    }),
    ITERATE__OTLP_SECRET: "the-otlp-secret",
    ITERATE__CATALOG_TOKEN: "the-catalog-token",
    ITERATE__ANALYTICS_TOKEN: "the-analytics-token",
  };
}
