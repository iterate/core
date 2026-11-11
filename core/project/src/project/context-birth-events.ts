import { ProjectContract } from "./contract.ts";

// Spelled at the fixed point (`itx.builtins`) so no rule of the context can mask or re-point it.
// A fan-out row: the project's code fails event by event, so one bad event never holds the rest.
export const PROJECT_CONTEXT_BIRTH_EVENTS = [
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
        name: "project",
        target: ["itx", "builtins", "facets", ["get", "project"], "processEventBatch"],
        consumes: [...ProjectContract.consumes, "events.iterate.com/itx/woken"],
      },
    },
    {
      type: "events.iterate.com/project/create-requested",
      payload: { configRepoTemplate },
    },
  ] as const;
