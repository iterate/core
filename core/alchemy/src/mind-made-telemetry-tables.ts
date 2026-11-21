// mind-made-telemetry-tables.ts — THE TELEMETRY TABLES THAT A MIND MADE ITSELF, AS A RESOURCE. A
// stack with no telemetry token makes the bucket and the streams, and the mind's own code makes
// the catalog, the sinks and the pipelines (core/configs/default/telemetry.ts). This resource makes
// nothing. Its delete removes what the mind made, with the deploy's own credential: the pipelines,
// then the sinks, then the catalog with its tables. It reads the bucket's and the streams' names
// from their resources, so a destroy runs it before they go.
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as catalog from "@distilled.cloud/cloudflare/r2-data-catalog";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export type MindMadeTelemetryTables = Resource<
  "Iterate.MindMadeTelemetryTables",
  {
    accountId: string;
    bucket: string;
    /** Read for the order of a destroy alone. */
    streams: string[];
    /** The start of every name (core/alchemy/src/config.ts `namesOf().telemetryTables`). */
    tables: string;
  },
  { bucket: string },
  never,
  Cloudflare.Providers
>;
export const MindMadeTelemetryTables = Resource<MindMadeTelemetryTables>(
  "Iterate.MindMadeTelemetryTables",
);

/** A table's stream, sink and pipeline, by name: the stack's and the mind's own spell them so. */
export const telemetryTableNames = (tables: string, table: "events" | "logs" | "spans") => ({
  stream: `${tables}_${table}_stream`,
  sink: `${tables}_${table}_sink`,
  pipeline: `${tables}_${table}`,
});

export const MindMadeTelemetryTablesProvider = () =>
  Provider.succeed(MindMadeTelemetryTables, {
    reconcile: ({ news }) => Effect.succeed({ bucket: news.bucket }),
    // Through Cloudflare's SDK, which retries 429 and 5xx, and as Alchemy's own Pipelines
    // providers delete (2.0.0-beta.87): a pipeline before its sink, and a sink's 422 "in use"
    // waited out while its pipeline's delete propagates (at most 8 tries, 500 ms doubling).
    delete: Effect.fn(function* ({ olds: { accountId, bucket, tables } }) {
      const named = (["events", "logs", "spans"] as const).map((table) =>
        telemetryTableNames(tables, table),
      );
      // `name` is a case-insensitive substring filter: the exact names are compared after
      for (const { id, name } of yield* Stream.runCollect(
        pipelines.listV1Pipeline.items({ accountId, name: tables, perPage: 100 }),
      ))
        if (named.some(({ pipeline }) => pipeline === name))
          yield* pipelines
            .deleteV1Pipeline({ accountId, pipelineId: id })
            .pipe(Effect.catchTag("PipelineNotExists", () => Effect.void));
      for (const { id, name } of yield* Stream.runCollect(
        pipelines.listSinks.items({ accountId, name: tables, perPage: 100 }),
      ))
        if (named.some(({ sink }) => sink === name))
          yield* pipelines.deleteSink({ accountId, sinkId: id }).pipe(
            Effect.retry({
              while: (error) => error._tag === "SinkInUse",
              schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(8)]),
            }),
            Effect.catchTags({ SinkNotFound: () => Effect.void, InvalidSinkId: () => Effect.void }),
          );
      // The catalog with its namespaces and tables (measured on 20 Nov 2026); its files stay, and
      // the bucket's `forceDestroy` removes them. No catalog: 404, the account's "no data catalog
      // route" (7003), or no such bucket (10006, 40406).
      yield* catalog.Delete({ accountId, bucketName: bucket, force: true }).pipe(
        Effect.catchIf(
          (error) =>
            error._tag === "CloudflareError" &&
            (error.status === 404 ||
              error.errors.some(({ code }) => [7003, 10006, 40406].includes(code ?? 0))),
          () => Effect.void,
        ),
      );
    }),
  });
