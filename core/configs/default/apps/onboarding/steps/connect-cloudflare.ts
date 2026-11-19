// connect-cloudflare.ts — THE STEP "Connect Cloudflare": the mind reads its own Cloudflare account
// (its logs, usage and settings) and changes nothing there. One button, which begins the same
// connect as the Integrations card's "Connect" (../../../cloudflare.ts `cloudflareConnect`): one
// consent on Cloudflare's own page, through the OAuth client that the stack's deploy made in the
// account.
//
// A STACK WITH NO CLIENT HAS NO BUTTON. The deploy makes the client only with an API token that
// may make OAuth clients, which a sign-in at Cloudflare cannot give: the card then names the
// command that makes it (`iterate deploy` asks for one such token). The step learns which with no
// secret read and no request to Cloudflare: `itx.secrets.hasStackClient("cloudflare")`.
//
// ONE CONSENT IN FLIGHT. The vault keeps one attempt for a path, and a later begin replaces it:
// the owner on Cloudflare's page would come back to "begin again". So `act` decides by the card's
// own status, and "connect" never ends a consent in flight.
//
// No request goes to Cloudflare before a member presses. The page reads the vault and the
// Integrations card (`cloudflareConnection`, which the template's own check of a new grant keeps).
//
// THE TABLE. The card's status, first that holds wins, and what each action does on it. "begins":
// a new consent, whose link the answer gives and the page opens in a new tab (both actions are
// `opens`), and the card shows "connecting" next. "check" begins nothing anywhere.
//
//   status       when                                      connect           again    decline
//   connecting   a connect waits for the vault             its own link      begins   no change
//   failed       that attempt was refused or replaced      begins            begins   below *
//                ("Try again", whether or not a grant is held)
//   connected    a grant held, the account's name or none  nothing           begins   no change
//                ("Connect again" is `again`)
//   failed       a grant held, and the check's problem     begins            begins   no change
//                (another account, or Cloudflare refused it; "Connect again" is `again`)
//   no-client    the deploy made no OAuth client           nothing           nothing  no change
//                (and nothing begins on any status while the stack has no client)
//   declined     "Not now"                                 begins            begins   declined
//   failed       the hour ran out                          begins            begins   declined
//   not-asked    none of these                             begins            begins   declined
//
// * the attempt is put aside: the card is the grant's (connected, or its problem), else declined.
// "Connect Cloudflare" and "Try again" are `connect`; "Connect again" is `again`; "Not now" is
// `decline`; "Open Cloudflare's page" is the waiting attempt's link itself.
import { z } from "zod";
import { cloudflareConnect, cloudflareConnection } from "../../../cloudflare.ts";
import type { StepState } from "../contract.ts";
import type { Card, MindEvent, Step, StepContext, StepLog } from "../steps.ts";

const GRANT = "/secrets/cloudflare";
/** The vault keeps a connect's attempt for an hour. */
const ATTEMPT_MS = 60 * 60_000;

/** What the card says the connection gives, in every state that offers it. */
const WHAT =
  "Your mind can read its own Cloudflare account: logs, usage, settings. It can change nothing there.";

/** The facts of this step, as `check` reads them. */
const Facts = z.object({
  /** The deploy made the stack's own OAuth client. */
  stackClient: z.boolean(),
  /** `/secrets/cloudflare` is set: a consent was kept. */
  held: z.boolean(),
  /** The Integrations card's last check of the grant: the account, and its problem. */
  account: z.string().optional(),
  problem: z.string().optional(),
  /** The waiting connect's outcome in the vault, and the vault's words for a failure. */
  attempt: z.enum(["pending", "complete", "failed", "unavailable"]).optional(),
  attemptWords: z.string().optional(),
});
type Facts = z.infer<typeof Facts>;

const factsOf = (state: StepState): Facts | undefined => Facts.safeParse(state.facts).data;

/** The waiting connect's attempt is over in the vault: refused, or replaced by a later begin. */
const ended = (facts: Facts | undefined) =>
  facts?.attempt === "failed" || facts?.attempt === "unavailable";

function words(state: StepState, context: StepContext): Card {
  const facts = factsOf(state);
  const card = { step: connectCloudflare.id, title: "Connect Cloudflare" };
  const connect = { label: "Connect Cloudflare", action: "connect" };
  if (state.action && !ended(facts))
    return {
      ...card,
      status: "connecting",
      text: ["Waiting for your approval on Cloudflare's page."],
      buttons: state.action.link
        ? [{ label: "Open Cloudflare's page", href: state.action.link, primary: true }]
        : [],
    };
  // a "Not now" after it puts the attempt aside
  if (state.action && !state.declined)
    return {
      ...card,
      status: "failed",
      text: [
        facts?.attemptWords ||
          (facts?.attempt === "unavailable"
            ? "A newer link to Cloudflare replaced this one. Nothing was kept from it."
            : "Cloudflare did not connect. Nothing was kept."),
      ],
      buttons: [
        { ...connect, label: "Try again", primary: true },
        { label: "Not now", action: "decline" },
      ],
    };
  if (facts?.held)
    return facts.account && !facts.problem
      ? {
          ...card,
          status: "connected",
          title: "Cloudflare is connected",
          text: [`Your mind reads the account ${facts.account}. It can change nothing there.`],
          buttons: facts.stackClient ? [{ label: "Connect again", action: "again" }] : [],
        }
      : facts.problem
        ? {
            ...card,
            status: "failed",
            text: [facts.problem],
            buttons: facts.stackClient
              ? [{ label: "Connect again", action: "again", primary: true }]
              : [],
          }
        : {
            ...card,
            status: "connected",
            title: "Cloudflare is connected",
            text: ["Your mind can read its own Cloudflare account. It can change nothing there."],
            buttons: [],
          };
  if (facts && !facts.stackClient)
    return {
      ...card,
      status: "no-client",
      optional: true,
      text: [
        WHAT,
        "This mind has no OAuth client at Cloudflare yet. Run this command once more on your computer and paste one Cloudflare API token when it asks:",
      ],
      command: `npx iterate deploy --domain ${context.zone}`,
      buttons: [],
    };
  if (state.declined)
    return {
      ...card,
      status: "declined",
      title: "Cloudflare is not connected",
      text: [],
      buttons: [connect],
    };
  if (state.failure)
    return {
      ...card,
      status: "failed",
      optional: true,
      text: [
        state.failure.words ||
          "Cloudflare's page was not approved within the hour. Nothing was connected.",
      ],
      buttons: [
        { ...connect, label: "Try again", primary: true },
        { label: "Not now", action: "decline" },
      ],
    };
  return {
    ...card,
    status: "not-asked",
    optional: true,
    text: [WHAT],
    buttons: [
      { ...connect, primary: true },
      { label: "Not now", action: "decline" },
    ],
  };
}

/** The facts from the vault and the Integrations card: nothing here asks Cloudflare. */
async function check(context: StepContext, state: StepState): Promise<Facts> {
  const { itx } = context;
  const [stackClient, grant] = await Promise.all([
    itx.secrets.hasStackClient("cloudflare"),
    itx.secrets.describe(GRANT),
  ]);
  const facts: Facts = { stackClient, held: grant.set };
  const attempt = state.action?.attempt;
  if (attempt) {
    const result = await itx.secrets.oauthResult(GRANT, { nonce: attempt });
    facts.attempt = result.status === "declined" ? "failed" : result.status;
    if ("error" in result) facts.attemptWords = result.error.slice(0, 400);
  }
  if (!grant.set) return facts;
  const seen = await cloudflareConnection(itx);
  return {
    ...facts,
    ...(seen && { account: seen.account.slice(0, 200) }),
    ...(seen?.problem && !seen.ok && { problem: seen.problem.slice(0, 400) }),
  };
}

/** "connect" and "again", as THE TABLE at the top says, by the card's own status: the consent
 *  page of the stack's own client, the page the member opens next. */
async function act(
  context: StepContext,
  action: string,
  state: StepState,
  log: StepLog,
): Promise<{ link?: string } | void> {
  // a stack with no client begins nothing on any status: its card names the command that makes it
  if (!factsOf(state)?.stackClient) return;
  // `check` read the vault just before this press
  const { status } = words(state, context);
  if (action === "connect" && status === "connecting") return { link: state.action?.link };
  if (action === "connect" && status === "connected") return;
  const began = await cloudflareConnect(context.itx, {
    tell: "/agents/onboarding",
    // after the consent: back to the page whose button began it
    next: `https://onboarding.${context.zone}/`,
  });
  // the client went away since the check: the card says so at the next check
  if (began.way !== "stack-client") return;
  const { link, nonce } = began;
  await log.request(action, { link, expires: context.now + ATTEMPT_MS, attempt: nonce });
  return { link };
}

function hears(event: MindEvent) {
  return (
    ((event.type === "events.iterate.com/secret/set" ||
      event.type === "events.iterate.com/secret/deleted") &&
      event.path === GRANT) ||
    // the template's check of a new grant wrote the account to the Integrations card
    (event.type === "events.iterate.com/integration/connection-configured" &&
      event.path === "/integrations")
  );
}

/** A kept consent settles the waiting connect. */
async function onEvent(_context: StepContext, event: MindEvent, state: StepState, log: StepLog) {
  if (event.type === "events.iterate.com/secret/set" && state.action)
    await log.settle(state.action.requestOffset);
}

export const connectCloudflare: Step = {
  id: "connect-cloudflare",
  actions: { connect: { opens: true }, again: { opens: true } },
  offered: () => true,
  words,
  check,
  act,
  hears,
  onEvent,
};
