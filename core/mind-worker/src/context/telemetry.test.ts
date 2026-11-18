import { expect, test } from "vitest";
import { PLATFORM_WAKE_EVENTS } from "./telemetry.ts";

test("every context is owed the row that sends its events to the platform, under one key", () => {
  expect(PLATFORM_WAKE_EVENTS).toEqual([
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
