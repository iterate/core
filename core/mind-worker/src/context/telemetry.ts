import type { ItxHostRoot } from "core-itx";
import { codedError } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import type { Door } from "iterate/workers";
import { assertDeliveryCaller } from "./webhooks.ts";

export const telemetryRoots = (egress: () => Pick<Door, "queryTelemetry" | "sendEvents">) =>
  ({
    telemetry: {
      description:
        "the mind's telemetry as SQL, its last day unless `{ hours }` says: `telemetry.query(\"SELECT level, count() AS n FROM logs.workersLogs GROUP BY level\")` over one of Cloudflare's own datasets (`logs.workersLogs`, `logs.traces`, `logs.issues`, `events.workersInvocations`, `metrics`) with no token, or over the tables `events`, `logs` and `spans` with the stack's token; `telemetry.cut(sql, { hours })` answers `{ sql, send }`, the cut SQL and where it goes, on a stack that holds no telemetry token, for a mind's own read of the tables it made with its own token (`itx.config.telemetryQuery`, core/configs/default/telemetry.ts)",
      build: () => {
        const query = (sql: string, options?: { hours?: number }) =>
          egress().queryTelemetry(String(sql), options?.hours);
        // `cut` is under a name that no rule points away, for the mind's own read of the tables it
        // made (core/configs/default/telemetry.ts). It never gives rows: a rule that holds
        // `query` for approval holds every read of the platform's. The mind's own read sends its
        // own secret, which a rule of the secret holds.
        const cut = async (sql: string, options?: { hours?: number }) => {
          const { send, sql: cutSql } = await query(sql, options);
          if (!send)
            throw codedError(
              "TELEMETRY_TOKEN_HELD",
              "itx.telemetry.cut: the stack holds its telemetry token: ask telemetry.query",
            );
          return { sql: cutSql, send };
        };
        return { query, cut };
      },
    },
    platformHook: {
      description:
        "the platform's own subscriber of every durable event here: an ordered row's target, called by the delivery loop alone",
      build: ({ caller }) => ({
        deliverEvents: async (events: StreamEvent[]) => {
          await assertDeliveryCaller(
            caller().delivery,
            "platformHook.deliverEvents",
            JSON.stringify(events),
          );
          await egress().sendEvents(events);
        },
        deliverEvent: async (event: StreamEvent) => {
          await assertDeliveryCaller(
            caller().delivery,
            "platformHook.deliverEvent",
            JSON.stringify(event),
          );
          await egress().sendEvents([event]);
        },
      }),
    },
  }) satisfies Record<string, ItxHostRoot>;

/** THE ROW THAT SENDS A CONTEXT'S EVENTS TO THE PLATFORM, owed by every context as a wake event
 *  (core-itx `ItxHost.wakeEvents`; its stream/wake-events.ts says when one lands). An ordered
 *  row: what fails the hook is its destination, which fails every event alike. */
export const PLATFORM_WAKE_EVENTS = [
  {
    type: "events.iterate.com/itx/subscription-configured",
    idempotencyKey: "itx/platform-subscription",
    payload: {
      name: "platform",
      target: "itx.builtins.platformHook.deliverEvents",
      afterOffset: 0,
    },
  },
] as const;
