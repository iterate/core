import type { ItxHostRoot } from "core-itx";
import type { StreamEvent } from "iterate/stream/processor";
import type { Door } from "iterate/workers";
import { assertDeliveryCaller } from "./webhooks.ts";

export const telemetryRoots = (egress: () => Pick<Door, "queryTelemetry" | "sendEvents">) =>
  ({
    telemetry: {
      description:
        'the mind\'s telemetry as SQL, its last day unless `{ hours }` says (at most 720): `telemetry.query("SELECT type, count(*) FROM events GROUP BY type")` over `events`, `logs`, `spans`, or `metrics` alone',
      build: () => ({
        query: (sql: string, options?: { hours?: number }) =>
          egress().queryTelemetry(String(sql), options?.hours),
      }),
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

/** THE ROW THAT SENDS A CONTEXT'S EVENTS TO THE PLATFORM, named while telemetry is on, as a wake
 *  event (core-itx `ItxHost.wakeEvents`; its stream/wake-events.ts says when one lands). An
 *  ordered row: what fails the hook is its destination, which fails every event alike. */
export const platformWakeEvents = (telemetryOn: boolean) =>
  telemetryOn
    ? [
        {
          type: "events.iterate.com/itx/subscription-configured",
          idempotencyKey: "itx/platform-subscription",
          payload: {
            name: "platform",
            target: "itx.builtins.platformHook.deliverEvents",
            afterOffset: 0,
          },
        } as const,
      ]
    : [];
