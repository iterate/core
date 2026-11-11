import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import {
  INTEGRATION_STATE_MAX_BYTES,
  INTEGRATIONS_PATH,
  type IntegrationCard,
  type IntegrationConnection,
  IntegrationRegistryContract,
  type IntegrationRegistryState,
} from "iterate/integrations";
import { jsonEqual } from "iterate/lib";
import type { ItxEntrypointScope, ItxHostRootContext } from "core-itx";
import { EmailContract } from "iterate/email";
import { hopCaller } from "../context/hop-caller.ts";
import { EMAIL_PATH } from "./email.ts";

class IntegrationRegistryProcessor extends StreamProcessor<
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

/** The card or row that would take the state past the budget is left out. */
function withinBudget(next: IntegrationRegistryState): IntegrationRegistryState | undefined {
  const bytes = new TextEncoder().encode(JSON.stringify(next)).length;
  return bytes <= INTEGRATION_STATE_MAX_BYTES ? next : undefined;
}

export class IntegrationFacet extends StreamProcessorDurableObject<
  IntegrationRegistryState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new IntegrationRegistryProcessor();
}

/** Each facet's row in the birth of the context that hosts it, so a package's first registration
 *  is folded without anyone enabling the facet first. */
export function integrationBirthEvents(path: string) {
  const row = (name: string, consumes: readonly string[]) => ({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name,
      target: ["itx", "builtins", "facets", ["get", name], "processEventBatch"],
      consumes: [...consumes, "events.iterate.com/itx/woken"],
    },
  });
  if (path === INTEGRATIONS_PATH) return [row("integration", IntegrationRegistryContract.consumes)];
  if (path === EMAIL_PATH) return [row("email", EmailContract.consumes)];
  return [];
}

/** A registration is the caller's own append, so it is attributed to whoever registered. */
export function integrationsRoot(context: ItxHostRootContext) {
  const registry = () => context.context(INTEGRATIONS_PATH);
  const append = (event: { type: string; payload: Record<string, unknown> }) =>
    registry().invoke(["itx", ["append", event]], [], context.caller());
  return {
    list: async () => {
      // without its `app`, so loaded code can list as a member's session can
      const { state } = (await registry().invoke(
        ["itx", "builtins", "facets", ["get", "integration"], ["snapshot"]],
        [],
        { ...hopCaller(context), platform: true },
      )) as { state: IntegrationRegistryState };
      return state;
    },
    register: (integration: string, card: IntegrationCard | null) =>
      append({ type: "events.iterate.com/integration/configured", payload: { integration, card } }),
    setConnection: (integration: string, connection: string, row: IntegrationConnection | null) =>
      append({
        type: "events.iterate.com/integration/connection-configured",
        payload: { integration, connection, row },
      }),
  };
}

export const INTEGRATIONS_ROOT_DESCRIPTION =
  "the project's integration packages, registered on /integrations: `integrations.list()` → { integrations, connections } · `integrations.register(name, card | null)` · `integrations.setConnection(name, connection, row | null)`; a package keeps its credentials in `itx.secrets`";
