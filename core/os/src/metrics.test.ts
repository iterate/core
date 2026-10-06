// metrics.test.ts — the data point each call writes, and one Workers Analytics Engine refuses,
// dropped with one warning.
import { expect, test, vi } from "vitest";
import { metrics } from "./metrics.ts";

const env = { WORKER_NAME: "os" };
const context = { projectId: "prj_1", path: "/" };

test("a data point is the name, the Worker, the context and the label, indexed by the project", () => {
  const points: unknown[] = [];
  const metric = metrics(
    { ...env, TELEMETRY_METRICS: { writeDataPoint: (p) => points.push(p) } },
    context,
  );
  metric("subscription.halts", 1, "s");
  metric("subscription.lag_ms", 850);
  metric("context.size", [61_440, 4]);
  // exact: every query reads the blobs by position, so the layout only grows at the end
  expect(points).toEqual([
    { indexes: ["prj_1"], blobs: ["subscription.halts", "os", "prj_1", "/", "s"], doubles: [1] },
    { indexes: ["prj_1"], blobs: ["subscription.lag_ms", "os", "prj_1", "/", ""], doubles: [850] },
    { indexes: ["prj_1"], blobs: ["context.size", "os", "prj_1", "/", ""], doubles: [61_440, 4] },
  ]);
});

test("a call never throws: with no dataset it writes nothing, and only the first refused point warns", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  metrics(env, context)("subscription.retries", 1);
  const TELEMETRY_METRICS = {
    writeDataPoint() {
      throw new Error("Too many data points written in this invocation");
    },
  };
  const full = metrics({ ...env, TELEMETRY_METRICS }, context);
  full("subscription.retries", 1);
  full("subscription.backlog", 4);
  expect(warn.mock.calls).toMatchObject([
    [{ event: "metrics.data-point-dropped", name: "subscription.retries" }],
  ]);
});
