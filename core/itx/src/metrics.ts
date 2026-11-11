// Indexed by path so a busy context cannot crowd a quiet one out of the sample. Queries read the
// blobs by position, so the layout only grows at the end.
export function metrics(
  dataset: Pick<AnalyticsEngineDataset, "writeDataPoint"> | undefined,
  path: string,
) {
  return (name: string, value: number | number[], label = ""): void => {
    try {
      dataset?.writeDataPoint({
        indexes: [path],
        blobs: [name, path, label],
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

export type Metrics = ReturnType<typeof metrics>;

let droppedDataPointWarned = false;
