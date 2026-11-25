// integrations.ts — THE INTEGRATION REGISTRY: what a mind's packages (iterate/sdk `Integration`)
// tell the Dash about themselves. A package appends two kinds of fact on the mind's
// `/integrations` context, and the first-party `integration` facet there folds them into the state
// the Dash's Integrations page renders (core/mind-worker/src/integrations/registry.ts). Both are SET semantics:
// the whole card or row again whenever anything changes, or null to take it away.
//   integration/configured             the card: a title, a description, a status, buttons
//   integration/connection-configured  one connection's row under a card: its account, status, buttons
// A card may name another card as its `section`: that card is then a heading, and the cards that
// name it stand under it.
// A button's target is where the Dash sends the person (or, for a `call` button, one function of
// the mind's config that the Dash calls at the press: `IntegrationCall`), and an icon is a file:
// each an absolute URL. A page of the mind's own is `await itx.url({ hostname, path })`. The Dash renders what the
// mind's own code wrote, so every string is capped and the fold keeps the state within
// INTEGRATION_STATE_MAX_BYTES, half the checkpoint limit on a facet's state.
import { z } from "zod";
import { RESERVED_SEGMENT_NAMES } from "./expression.ts";
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

/** The question a button asks before it acts: it changes something that cannot be undone. */
const IntegrationConfirm = z.string().min(1).max(400);

/** A LINK BUTTON: its label and where it leads. A strict object, so a key the Dash would not
 *  render is refused like any other. `confirm`: the button changes something that cannot be
 *  undone (Remove). The Dash asks this question first and, on yes, sends a POST to `url` on the
 *  page's own origin and stays on the page; a button with it whose URL is on another origin is not
 *  drawn. */
const IntegrationLinkAction = z.strictObject({
  label: z.string().min(1).max(40),
  ...IntegrationTarget.shape,
  confirm: IntegrationConfirm.optional(),
});

/** THE FUNCTION A PAGE ASKS FIRST, once: `itx.config.integrationCalls()` answers the names of
 *  the config's functions that a card's button may call (`IntegrationCallsOffered`). A page calls a
 *  button's function only when its name is among them, so a row can choose only a function that
 *  the config itself offers to buttons, never one that nobody thought of: the config's other
 *  methods (one that posts to Slack, one that sends any request), and every member that the
 *  platform's handle on the config has. A config with no such function offers none. */
export const INTEGRATION_CALLS = "integrationCalls";

/** What `integrationCalls()` answers: names of the config's own functions. */
export const IntegrationCallsOffered = z.array(z.string().max(64)).max(64);

/** The names a `call` may never name, whatever a config offers: what the platform's handle on the
 *  config answers itself (`InvokeHandle`'s `invoke` and `applyRoot`, which hand any steps on,
 *  `fetch` among them), the config entrypoint's base class's own members, the names that a capnweb
 *  stub or a JavaScript object answers itself (`RESERVED_SEGMENT_NAMES`), and the offer itself.
 *  integrations.test.ts walks the declared members of `InvokeHandle` and of the entrypoint's base
 *  class, so that a member added there later is refused here until someone decides. */
const NOT_CALLABLE: ReadonlySet<string> = new Set([
  ...RESERVED_SEGMENT_NAMES,
  INTEGRATION_CALLS,
  // InvokeHandle
  "invoke",
  "applyRoot",
  "takesTheRest",
  // the config entrypoint and the kernel's hooks on it
  "fetch",
  "processEvent",
  "processMindEvent",
  "deliverEvent",
  "email",
  "callWithCause",
  "getItx",
  "auth",
  "env",
  "ctx",
  "callerPath",
]);

/** The most nesting the arguments may have: they are data, and a deep nest within 2 KB would make
 *  a schema's walk deep. */
const ARGS_MAX_DEPTH = 8;

/** Whether `args`, read as JSON text, is at most 2 KB long and nests at most `ARGS_MAX_DEPTH`
 *  deep: checked before a schema walks it. */
function shortAndShallow(args: unknown[]): boolean {
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return false;
  }
  if (text.length > 2048) return false;
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (inString) {
      if (char === "\\") at += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[" || char === "{") deepest = Math.max(deepest, (depth += 1));
    else if (char === "]" || char === "}") depth -= 1;
  }
  return deepest <= ARGS_MAX_DEPTH + 1;
}

/** WHAT A CALL BUTTON RUNS: ONE function of the mind's config, by its plain name, with JSON
 *  arguments. The Dash calls `itx.config[name](...args)` as the member who pressed it, and nothing
 *  else, and only when the config offers that name to buttons (`INTEGRATION_CALLS`): the name is
 *  an identifier (a letter, then letters and digits), never a path, an expression or another root
 *  of `itx`, and never one of `NOT_CALLABLE`. A row is an event that code appends, and the press
 *  runs with the member's whole reach: the row chooses which of the offered functions runs, never
 *  what code runs. The page shows the member what the press calls, `name(args)`. */
export const IntegrationCall = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]{0,63}$/)
    .refine((name) => !NOT_CALLABLE.has(name), "no function a button may call"),
  /** The function's arguments, in order: JSON, at most 8, 2 KB as text and 8 deep, checked as
   *  text before the JSON schema walks them. */
  args: z
    .array(z.unknown())
    .max(8)
    .refine(shortAndShallow, "at most 2 KB of arguments, 8 deep")
    .pipe(z.array(z.json()))
    .optional(),
});
export type IntegrationCall = z.infer<typeof IntegrationCall>;

/** `name(args)` as a member reads it: the whole text, each character outside printable ASCII
 *  (`\x20-\x7e`) written as `\u{…}`. So a bidirectional or zero-width character in an argument
 *  cannot reorder or hide what follows it, and a look-alike letter shows as its code. A backslash
 *  of the arguments' own is `\\` in their JSON, so an escape here is never one of theirs. */
export function callText(call: IntegrationCall): string {
  const args = (call.args || []).map((arg) => JSON.stringify(arg)).join(", ");
  return `${call.name}(${args})`.replace(
    /[^\x20-\x7e]/gu,
    (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`,
  );
}

/** A CALL BUTTON: its label and the config function it calls at the press (`IntegrationCall`).
 *  `confirm` works as a link button's: the question first, the call on yes. */
const IntegrationCallAction = z.strictObject({
  label: z.string().min(1).max(40),
  call: IntegrationCall,
  confirm: IntegrationConfirm.optional(),
});

/** WHAT A CALL ANSWERS, as the Dash reads it: an object, whose other keys it ignores.
 *  - `link`: where the press goes next (a consent page, a form). The Dash follows it ONLY when it
 *    is an absolute `https:` URL on the MIND'S CONTROL PLANE, its hostname exactly (the issuer of
 *    the Dash's `/.auth/session.json`, which the host hands the page), with no user name, no
 *    password and no port of its own. Every connect of today answers such a link: the vault's
 *    start page (`secrets.beginOAuth`'s `authorizationUrl`, for a client of the stack's, of iterate
 *    Cloud's or of any other kind) or its collect form (`secrets.collectFromUser`), which then send
 *    the member on to the provider. So a config function that answers a link from what another
 *    party wrote (a row, a webhook) cannot send a member elsewhere, and no zone is worked out from
 *    a hostname. The address comes from the answer alone: nothing of the row builds or chooses it.
 *    The Dash goes there in the same tab, and while it leaves the button says the host it opens.
 *    A link it does not follow shows as an error on the card, with the reason and the host.
 *  - `said`: what the call did, in the function's own words: shown under the buttons, cut to 400
 *    characters.
 *  An answer that is no object, or holds neither, is a call that is done: the rows update from the
 *  registry, as they do for every change. A call that throws shows its words on the card. */
export const IntegrationCallAnswer = z.looseObject({
  link: z.string().optional().catch(undefined),
  said: z
    .string()
    .transform((said) => said.slice(0, 400))
    .optional()
    .catch(undefined),
});
export type IntegrationCallAnswer = z.infer<typeof IntegrationCallAnswer>;

/** Where a call's answer leads (`IntegrationCallAnswer`), for a page of the mind whose control
 *  plane is `controlPlane` (`iterate.example.com`): `{ follow }`, the URL to go to; or `{ refused }`,
 *  why its link is not followed ("a link on evil.test, which is no host of this mind"); or null when
 *  it has no link. An empty `controlPlane` follows no link. */
export function callAnswerLink(
  answer: unknown,
  controlPlane: string,
): { follow: URL } | { refused: string } | null {
  const link = IntegrationCallAnswer.safeParse(answer).data?.link;
  if (!link) return null;
  if (!URL.canParse(link)) return { refused: "a link that is no absolute URL" };
  const url = new URL(link);
  if (url.protocol !== "https:") return { refused: "a link that is not https" };
  if (url.username || url.password || url.port)
    return { refused: `a link on ${url.host} with a user name, a password or a port` };
  // the URL parser has lowered the hostname's case; a trailing dot stays, and is no other host
  const own = controlPlane.toLowerCase();
  return own && url.hostname === own
    ? { follow: url }
    : { refused: `a link on ${url.hostname}, which is no host of this mind` };
}

/** A button: a link (`url`) or a call of the mind's config (`call`), never both. */
const IntegrationAction = z.union([IntegrationLinkAction, IntegrationCallAction]);
export type IntegrationAction = z.infer<typeof IntegrationAction>;

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
