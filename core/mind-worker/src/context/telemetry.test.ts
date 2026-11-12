import { expect, test } from "vitest";
import { platformWakeEvents } from "./telemetry.ts";

test("with telemetry on, every context is owed the row that sends its events to the platform, under one key", () => {
  expect(platformWakeEvents(true)).toEqual([
    {
      type: "events.iterate.com/itx/subscription-configured",
      idempotencyKey: "itx/platform-subscription",
      payload: {
        name: "platform",
        target: "itx.builtins.platformHook.deliverEvents",
        afterOffset: 0,
      },
    },
  ]);
});

test("with telemetry off, no context is owed anything", () => {
  expect(platformWakeEvents(false)).toEqual([]);
});
