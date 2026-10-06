// metrics.ts — A CONTEXT'S CUSTOM METRICS: Workers Analytics Engine data points, written through
// the Worker's `TELEMETRY_METRICS` dataset and read back with the SQL API (docs/telemetry.md).

/** The custom metrics of one context (docs/telemetry.md): each call writes ONE data
 *  point, indexed by the project so a busy one cannot crowd a quiet one out of the sample, its
 *  blobs the name, `WORKER_NAME`, the project, the path and the label, its doubles the value or
 *  values: values one point holds land together or not at all. Queries read the blobs by
 *  position, so the layout only grows at the end. Never awaited: call it once per batch, never per
 *  item. A call never throws, and with no dataset bound (local dev, tests) writes nothing. */
export function metrics(
  env: { TELEMETRY_METRICS?: AnalyticsEngineDataset; WORKER_NAME: string },
  { projectId, path }: { projectId: string; path: string },
) {
  const { TELEMETRY_METRICS: dataset, WORKER_NAME: worker } = env;
  return (name: string, value: number | number[], label = ""): void => {
    try {
      dataset?.writeDataPoint({
        indexes: [projectId],
        blobs: [name, worker, projectId, path, label],
        doubles: Array.isArray(value) ? value : [value],
      });
    } catch (error) {
      // past an invocation's 250 data points `writeDataPoint` throws, and the point is lost
      if (droppedDataPointWarned) return;
      droppedDataPointWarned = true;
      console.warn({
        event: "metrics.data-point-dropped",
        message: "a data point was dropped (at most 250 per invocation); later drops say nothing",
        name,
        error: String(error),
      });
    }
  };
}

/** One context's custom metrics: `(name, value, label?)`, one data point a call. */
export type Metrics = ReturnType<typeof metrics>;

/** Once per isolate, not per invocation: the first drop says what every later one would. */
let droppedDataPointWarned = false;
