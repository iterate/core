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

export const rootBirthEvents = (configRepoTemplate: string) =>
  [
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "mind",
        target: ["itx", "builtins", "facets", ["get", "mind"], "processEventBatch"],
        consumes: [...MindContract.consumes, "events.iterate.com/itx/woken"],
      },
    },
    {
      type: "events.iterate.com/mind/create-requested",
      payload: { configRepoTemplate },
    },
  ] as const;
