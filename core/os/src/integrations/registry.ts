// src/integrations/registry.ts — THE INTEGRATION REGISTRY's host: the first-party facet
// `integration` on a project's `/integrations` (first-party-facets.ts; its name is its contract's
// slug, the key its live state is published under), folding the two facts iterate/integrations
// defines. A pure fold, so registry.test.ts constructs the processor with `new` and reduces rows.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import {
  INTEGRATION_STATE_MAX_BYTES,
  IntegrationRegistryContract,
  type IntegrationRegistryState,
} from "iterate/integrations";
import { jsonEqual } from "iterate/lib";
import type { ItxEntrypointScope } from "../iterate-context.ts";

export class IntegrationRegistryProcessor extends StreamProcessor<
  IntegrationRegistryState,
  ConsumedEvent<typeof IntegrationRegistryContract>
> {
  readonly contract = IntegrationRegistryContract;

  override reduce({
    event,
    state,
  }: ReduceArgs<IntegrationRegistryState, ConsumedEvent<typeof IntegrationRegistryContract>>):
    | IntegrationRegistryState
    | undefined {
    switch (event.type) {
      case "events.iterate.com/integration/configured": {
        const { integration, card } = event.payload;
        // own keys only: a name like `constructor` reads nothing off the prototype
        const current = Object.hasOwn(state.integrations, integration)
          ? state.integrations[integration]
          : undefined;
        const { [integration]: _dropped, ...rest } = state.integrations;
        if (!card) {
          // a card's null takes its connections with it
          if (!current) return undefined;
          const connections = Object.fromEntries(
            Object.entries(state.connections).filter(([key]) => !key.startsWith(`${integration}/`)),
          );
          return { integrations: rest, connections };
        }
        if (jsonEqual(current || null, card)) return undefined;
        return withinBudget({ ...state, integrations: { ...rest, [integration]: card } });
      }
      case "events.iterate.com/integration/connection-configured": {
        const { integration, connection, row } = event.payload;
        const key = `${integration}/${connection}`;
        const current = Object.hasOwn(state.connections, key) ? state.connections[key] : undefined;
        const { [key]: _dropped, ...rest } = state.connections;
        if (!row) return current ? { ...state, connections: rest } : undefined;
        // a row stands under its card alone
        if (!Object.hasOwn(state.integrations, integration) || jsonEqual(current || null, row))
          return undefined;
        return withinBudget({ ...state, connections: { ...rest, [key]: row } });
      }
      default:
        return undefined;
    }
  }
}

/** `next` while it serializes within INTEGRATION_STATE_MAX_BYTES of UTF-8, else undefined: the card
 *  or row that would take the state past the budget is left out. */
function withinBudget(next: IntegrationRegistryState): IntegrationRegistryState | undefined {
  const bytes = new TextEncoder().encode(JSON.stringify(next)).length;
  return bytes <= INTEGRATION_STATE_MAX_BYTES ? next : undefined;
}

/** The processor's host: the first-party facet `integration` (first-party-facets.ts). */
export class IntegrationFacet extends StreamProcessorDurableObject<
  IntegrationRegistryState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new IntegrationRegistryProcessor();
}
