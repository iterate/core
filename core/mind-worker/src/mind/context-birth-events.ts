import { MindContract } from "./contract.ts";

// Spelled at the fixed point (`itx.builtins`) so no rule of the context can mask or re-point it.
// A fan-out row: the mind's code fails event by event, so one bad event never holds the rest.
export const MIND_CONTEXT_BIRTH_EVENTS = [
  {
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "config",
      target: "itx.builtins.cd('/').config.deliverEvent",
      afterOffset: 0,
      ordered: false,
    },
  },
] as const;

/** WHAT THE ROOT IS OWED AT EVERY WAKE (core-itx `ItxHost.wakeEvents`): the record of the deploy
 *  that this code is. A deploy restarts the root, and the key holds the Worker's version id, so
 *  one deploy lands one event. `config` goes through JSON, so each secret of it is the string
 *  "REDACTED" (iterate/app-config `Redacted`). */
export function rootWakeEvents(config: object, versionId: string) {
  const redactedConfig: unknown = JSON.parse(JSON.stringify(config));
  return [
    {
      type: "events.iterate.com/mind/stack-deployed" as const,
      idempotencyKey: `mind/stack-deployed:${versionId}`,
      payload: { config: redactedConfig, versionId },
    },
  ];
}

export const rootBirthEvents = () =>
  [
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "mind",
        target: ["itx", "builtins", "facets", ["get", "mind"], "processEventBatch"],
        consumes: [...MindContract.consumes, "events.iterate.com/itx/woken"],
      },
    },
    { type: "events.iterate.com/mind/create-requested", payload: {} },
  ] as const;
