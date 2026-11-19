// integrations.ts — THE INTEGRATION REGISTRY: what a mind's packages (iterate/sdk `Integration`)
// tell the Dash about themselves. A package appends two kinds of fact on the mind's
// `/integrations` context, and the first-party `integration` facet there folds them into the state
// the Dash's Integrations page renders (core/mind-worker/src/integrations/registry.ts). Both are SET semantics:
// the whole card or row again whenever anything changes, or null to take it away.
//   integration/configured             the card: a title, a description, a status, buttons
//   integration/connection-configured  one connection's row under a card: its account, status, buttons
// A card may name another card as its `section`: that card is then a heading, and the cards that
// name it stand under it.
// A button's target is where the Dash sends the person, and an icon is a file: each an absolute
// URL. A page of the mind's own is `await itx.url({ hostname, path })`. The Dash renders what the
// mind's own code wrote, so every string is capped and the fold keeps the state within
// INTEGRATION_STATE_MAX_BYTES, half the checkpoint limit on a facet's state.
import { z } from "zod";
// the contract's module alone: stream/processor.ts reaches node:async_hooks through the cause, which
// no browser has, and the Dash imports this module
import { defineProcessorContract, type ProcessorState } from "./stream/contract.ts";

/** The mind context every registration lands on, and the first-party `integration` facet
 *  folds: `itx.cd(INTEGRATIONS_PATH).append(…)`. */
export const INTEGRATIONS_PATH = "/integrations";

/** An integration's name — a DNS label that starts with a letter — is its card's key and the
 *  first half of each of its connections' keys (`<integration>/<connection>`). */
const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(63);

/** The most UTF-8 bytes the state serializes to: a card or row that would take it past the budget
 *  is left out, so mind code cannot grow the facet's state past the checkpoint limit
 *  (iterate/stream/processor REDUCE_CHECKPOINT_TOO_LARGE, which would lock the facet) — half of it. */
export const INTEGRATION_STATE_MAX_BYTES = 1024 * 1024;

/** WHERE A BUTTON LEADS: an absolute http(s) URL. */
export const IntegrationTarget = z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2048) });
export type IntegrationTarget = z.infer<typeof IntegrationTarget>;

/** How an integration or a connection is doing, in the package's own words. */
export const IntegrationStatus = z.strictObject({
  kind: z.enum(["ok", "attention", "error"]),
  text: z.string().max(200).optional(),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

/** A button: its label and where it leads. A strict object, so a key the Dash would not render is
 *  refused like any other. `confirm`: the button changes something that cannot be undone (Remove).
 *  The Dash asks this question first and, on yes, sends a POST to `url` on the page's own origin
 *  and stays on the page; a button with it whose URL is on another origin is not drawn. */
const IntegrationAction = z.strictObject({
  label: z.string().min(1).max(40),
  ...IntegrationTarget.shape,
  confirm: z.string().min(1).max(400).optional(),
});

/** A square image the Dash shows beside a title (the service's own mark): an https URL. */
const IntegrationIcon = z.url({ protocol: /^https$/ }).max(2048);
export type IntegrationIcon = z.infer<typeof IntegrationIcon>;

/** THE CARD a package registers: what the Dash shows for the integration, connected or not. */
export const IntegrationCard = z.strictObject({
  title: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  icon: IntegrationIcon.optional(),
  /** The card this one stands under, by its integration's name. That card is drawn as a heading
   *  (its mark, title and description) above the cards that name it. A card that names none, or
   *  one that is not registered, stands with the mind's other cards. */
  section: Slug.optional(),
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
    "The integrations a mind's packages registered, and their connections: what the Dash's Integrations page shows.",
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
