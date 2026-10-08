// integrations.ts — THE INTEGRATION REGISTRY: what a project's packages (iterate/sdk `Integration`)
// tell the Dash about themselves. A package appends two kinds of fact on the project's
// `/integrations` context, and the first-party `integration` facet there folds them into the state
// the Dash's Integrations page renders (core/os integrations/registry.ts). Both are SET semantics:
// the whole card or row again whenever anything changes, or null to take it away.
//   integration/configured             the card: a title, a description, a status, buttons
//   integration/connection-configured  one connection's row under a card: its account, status, buttons
// A button's target is where the Dash sends the person: an absolute http(s) URL, or a place in the
// project (`routingSlug` and `path`) whose URL the Dash composes (iterate/project-ingress
// `projectPublicUrlOf`), so a package needs no origin when it registers, and the link follows a
// rename or a primary hostname. The Dash renders what the project's own code wrote, so every string
// is capped and the fold keeps the state within INTEGRATION_STATE_MAX_BYTES, half the checkpoint
// limit on a facet's state.
import { z } from "zod";
import { ROUTING_SLUG } from "./project-ingress.ts";
// the contract's module alone: stream/processor.ts reaches node:async_hooks through the cause, which
// no browser has, and the Dash imports this module
import { defineProcessorContract, type ProcessorState } from "./stream/contract.ts";

/** The project context every registration lands on, and the first-party `integration` facet
 *  folds: `itx.cd(INTEGRATIONS_PATH).append(…)`. */
export const INTEGRATIONS_PATH = "/integrations";

/** An integration's name — a routing slug's shape, within a DNS label's length — is its card's key
 *  and the first half of each of its connections' keys (`<integration>/<connection>`). */
const Slug = z.string().regex(ROUTING_SLUG).max(63);

/** The most UTF-8 bytes the state serializes to: a card or row that would take it past the budget
 *  is left out, so project code cannot grow the facet's state past the checkpoint limit
 *  (iterate/stream/processor REDUCE_CHECKPOINT_TOO_LARGE, which would lock the facet) — half of it. */
export const INTEGRATION_STATE_MAX_BYTES = 1024 * 1024;

/** WHERE A BUTTON LEADS: an absolute http(s) URL, or a place in this project, which the Dash turns
 *  into the URL of `routingSlug` (the apex when absent) at `path` on the project's primary hostname,
 *  else under the deployment's ingress. */
const IntegrationUrl = z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2048) });
/** A place in the project: `routingSlug`'s host (the apex when absent) at `path`. */
const IntegrationPlace = z.strictObject({
  routingSlug: Slug.optional(),
  // one leading slash: `//host` would read as an authority when the URL is composed
  path: z
    .string()
    .regex(/^\/(?!\/)/, "a path starts with a single /")
    .max(512),
});
export const IntegrationTarget = z.union([IntegrationUrl, IntegrationPlace]);
export type IntegrationTarget = z.infer<typeof IntegrationTarget>;

/** How an integration or a connection is doing, in the package's own words. */
export const IntegrationStatus = z.strictObject({
  kind: z.enum(["ok", "attention", "error"]),
  text: z.string().max(200).optional(),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

/** A button: its label and where it leads — a strict object either way, so a key the Dash would not
 *  render is refused like any other. */
const Label = z.string().min(1).max(40);
const IntegrationAction = z.union([
  z.strictObject({ label: Label, ...IntegrationUrl.shape }),
  z.strictObject({ label: Label, ...IntegrationPlace.shape }),
]);

/** THE CARD a package registers: what the Dash shows for the integration, connected or not. */
export const IntegrationCard = z.strictObject({
  title: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  /** A square image the Dash shows beside the title: an https URL (the service's own mark). */
  icon: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  status: IntegrationStatus.optional(),
  /** The card's buttons (Connect, Set up, …), at most four. */
  actions: z.array(IntegrationAction).max(4).default([]),
});
export type IntegrationCard = z.infer<typeof IntegrationCard>;

/** ONE CONNECTION's row under its card: a bot, a workspace, an installation, an account. */
export const IntegrationConnection = z.strictObject({
  /** What the provider calls it: `@jeeves_bot`, `acme/pets`, an address. */
  account: z.string().min(1).max(200),
  status: IntegrationStatus.optional(),
  /** The row's buttons (Manage, Open, …), at most four. */
  actions: z.array(IntegrationAction).max(4).default([]),
  /** A few labelled facts the Dash lists under the account. */
  details: z
    .record(z.string().min(1).max(40), z.string().max(200))
    .refine((details) => Object.keys(details).length <= 10, "at most ten details")
    .optional(),
});
export type IntegrationConnection = z.infer<typeof IntegrationConnection>;

export const IntegrationRegistryContract = defineProcessorContract({
  slug: "integration",
  version: "1",
  description:
    "The integrations a project's packages registered, and their connections: what the Dash's Integrations page shows.",
  stateSchema: z.object({
    /** Every registered card, by the integration's name. */
    integrations: z.record(z.string(), IntegrationCard).default({}),
    /** Every connection's row, by `<integration>/<connection>`, under a card that exists. */
    connections: z.record(z.string(), IntegrationConnection).default({}),
  }),
  events: {
    "events.iterate.com/integration/configured": {
      description:
        "A package registered its card, or registered it again with a change; a null card unregisters it and its connections with it.",
      payloadSchema: z.strictObject({
        integration: Slug,
        card: IntegrationCard.nullable(),
      }),
    },
    "events.iterate.com/integration/connection-configured": {
      description:
        "A package set one connection's row under its card, or set it again with a change; a null row removes it.",
      payloadSchema: z.strictObject({
        integration: Slug,
        // a secret name's grammar, so `/secrets/<integration>-<connection>` is always a secret path
        connection: z.string().regex(/^(?!\.\.?$)[a-zA-Z0-9._-]{1,64}$/),
        row: IntegrationConnection.nullable(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/integration/configured",
    "events.iterate.com/integration/connection-configured",
  ],
  emits: [],
});

/** The registry as folded (the contract's `stateSchema`). */
export type IntegrationRegistryState = ProcessorState<typeof IntegrationRegistryContract>;
