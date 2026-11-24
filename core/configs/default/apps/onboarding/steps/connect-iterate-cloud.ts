// connect-iterate-cloud.ts — THE STEP "Connect to iterate Cloud": one offer, one button. The owner
// signs the meld rule with their passkey (iterate may add events under one path of the mind);
// when the signed rule lands, the mind asks iterate Cloud for its grant and sets `/secrets/openai`
// and `/secrets/exa` by iterate's proxy where no key is set. An owner's own key is never written.
// Ending the rule ends the credit: the secrets by iterate's proxy are deleted.
//
// No request goes to iterate before a member's signed rule. The rule is this page's gate: the
// proxy recognises a mind by its signed request alone (cloud-credit.ts says what each call needs).
//
// When the credit is certainly spent, the step deletes its secrets by iterate's proxy; the rule
// stays. The card's states, first that holds wins: disconnecting or connecting (an ask waits),
// spent (a rule and a certainly spent balance), connected (a rule, a balance and a secret by
// iterate's proxy), own keys (a stack that signs, and both secrets are the owner's: no offer),
// declined, unavailable (the stack cannot sign as the mind yet), failed (the last ask, with its
// reason; not "spent"), not asked (the offer, with what is left of a grant this mind has).
//
// AT THE CONNECT the step also turns on iterate Cloud's AI lending (cloud-ai.ts): `itx.ai` runs
// through iterate Cloud once the Cloud has recognised the mind. A Disconnect, the rule's end and
// iterate's end of the credit turn it off. Neither ever fails the step.
import { errorCode } from "iterate/lib";
import { z } from "zod";
import { dashLinks } from "../../dash/links.ts";
import { ITERATE_HOSTNAME, ITERATE_MIND } from "../../../cloud-deliveries.ts";
import type { CloudAiAnswer } from "../cloud-ai.ts";
import { Balance, CREDIT_SECRETS } from "../cloud-credit.ts";
import type { StepState } from "../contract.ts";
import type { Card, MindEvent, Step, StepContext, StepLog } from "../steps.ts";

/** What iterate gives a new mind, in dollars: the card's words before the Cloud said a balance. */
const CREDIT_USD = 10;

/** WHETHER THIS STEP IS OFFERED AT ALL. True while iterate Cloud's secret proxy
 *  (cloud-credit.ts `ITERATE_PROXY`) is live and spends a key of its own. Set it to false to close the step: then
 *  no mind shows the card, the tool answers that the mind has no such step (the onboarding agent
 *  then asks the "let iterate in" question, onboarding.md of /repos/onboarding, section 5), and nothing asks iterate for
 *  anything. Tests set `StepContext.creditOpen` either way. */
export const CREDIT_OPEN = true;

/** Where the rule lands, and the one path under which it lets iterate add events. */
const MELD_CONTEXT = `/minds/${ITERATE_MIND}`;
const MELD_APPEND = `/minds/${ITERATE_MIND}/`;

/** How long a connect with no passkey page may wait for its own work: past it, the next check or
 *  press settles it as "stopped" (steps.ts `settleExpired`). */
const CONNECT_MS = 60_000;

/** The command that updates a mind's platform code, run on the owner's computer. */
const UPDATE_COMMAND = "npx iterate@latest deploy";

const Kind = z.enum(["unset", "own", "iterate-proxy", "other-proxy"]);

/** The facts of this step, as `check` reads them. */
const Facts = z.object({
  /** The stack signs requests as the mind (cloud-credit.ts `canSign`). */
  canSign: z.boolean(),
  /** The latest rule a member signed on `MELD_CONTEXT` lets iterate add events. */
  meld: z.boolean(),
  openai: Kind,
  exa: Kind,
  /** The Cloud's numbers, read only once a member signed the rule. */
  balance: Balance.optional(),
  /** iterate's total for the day is spent: every mind waits for the next UTC day. */
  paused: z.boolean().optional(),
  /** The rule was read, and a member ended it, while a path stayed by iterate's proxy. */
  ended: z.boolean().optional(),
  /** A person at iterate ended this mind's credit, for good (403 `iterate_credit_ended`). */
  iterateEnded: z.boolean().optional(),
  /** iterate Cloud lends this mind its AI: `itx.ai` is `itx.iterateCloud.ai` (cloud-ai.ts). */
  ai: z.boolean().optional(),
});
type Facts = z.infer<typeof Facts>;

const factsOf = (state: StepState): Facts | undefined => Facts.safeParse(state.facts).data;

/** A path the credit can pay for: one with no key, or one already by iterate's proxy. */
const takesCredit = (kind: z.infer<typeof Kind>) => kind === "unset" || kind === "iterate-proxy";

/** A rule's payload: an empty `append` ends the meld. */
const MeldRule = z.object({ append: z.array(z.string()) });

/** Where a member's rule for iterate is: on iterate's id, or, for a rule by hostname, on its
 *  hostname. The auth Worker keeps one row for both (core/auth-worker/src/minds.ts), so the
 *  latest rule over the two is the one in force. */
const MELD_CONTEXTS = [MELD_CONTEXT, `/minds/${ITERATE_HOSTNAME}`];

/** THE LATEST RULE A MEMBER SIGNED for iterate, and who signed it, over `MELD_CONTEXTS`. A context
 *  is read only when it exists: a read would make it. `ended` only when a context was READ and the
 *  latest rule is an end: a context missing from the catalog's page (more than 1,000 more active
 *  below it, or a row not yet written) is off but not ended, so nothing is deleted on it. */
export async function meldOf(
  context: Pick<StepContext, "itx">,
): Promise<{ on: boolean; ended: boolean; signer?: string }> {
  let meld: { on: boolean; ended: boolean; signer?: string } = { on: false, ended: false };
  let latest = "";
  for (const path of MELD_CONTEXTS) {
    const listed = await context.itx.contexts.list({ under: path, limit: 1000 });
    if (!listed.some((one) => one.path === path)) continue;
    for (let after = 0; ;) {
      const page = await context.itx.cd(path).readEvents(after, 500);
      for (const event of page.events) {
        if (event.type !== "events.iterate.com/mind-meld/configured") continue;
        if (event.source?.signer?.member !== true) continue;
        const rule = MeldRule.safeParse(event.payload);
        // the later of two, by when it landed: a rule by id always came after one by hostname
        if (!rule.success || event.createdAt < latest) continue;
        latest = event.createdAt;
        const on = rule.data.append.length > 0;
        meld = { on, ended: !on, signer: event.source.signer.principal.email };
      }
      if (page.atHead || page.scannedThroughOffset <= after) break;
      after = page.scannedThroughOffset;
    }
  }
  return meld;
}

/** The words of each reason an ask failed. */
const FAILURES: Record<string, string> = {
  "not-signed": "The passkey page expired before it was signed. Nothing was connected.",
  "cloud-unreachable": "iterate Cloud did not answer. Try again in a minute.",
  "not-recognised": `iterate Cloud did not recognise this mind's signature. Update your mind on your computer, then try again.`,
  "no-working-key": `iterate Cloud could not check this mind's key. Update your mind on your computer, then try again.`,
  "stack-without-proxy": `This mind's platform code cannot use the credit yet. Update your mind on your computer, then try again.`,
  "none-today": "iterate made all its new grants for today. Try again tomorrow (UTC).",
  paused: "iterate's credit is paused until tomorrow (UTC).",
  "not-approved":
    "iterate has your request. A person at iterate approves each mind. You get the credit when they have.",
  ended: "A person at iterate ended this mind's credit. Your mind goes on with its own keys.",
  "hostname-enrolled":
    "Another mind at this hostname has iterate's credit. A person at iterate ends it first; then try again.",
  stopped: "The connect stopped before it finished.",
  spent: "This mind's iterate credit is used.",
  "approval-rule":
    "A key of the credit has an approval rule on the mind's Secrets page, and iterate's proxy cannot pass one. Remove the rule, then try again.",
  "being-set": "A key of the credit was being changed while the credit connected. Try again.",
};

/** What stands after a signed rule when the credit did not come, and how to end it. */
const RULE_STANDS =
  "Your signed rule still lets iterate send help and updates to this mind. End it with your passkey to stop that.";

/** THE LINK TO THIS MIND'S PAGE ON iterate Cloud, on each card with a rule: a route of this app
 *  (open-cloud.ts) that goes on through this mind's own sign-in, which vouches for the member. */
const openCloud = (context: StepContext) => ({
  label: "Open iterate Cloud",
  href: `https://onboarding.${context.zone}/open-cloud`,
});

/** The reasons whose fix is the update command. */
const UPDATE_REASONS = new Set(["not-recognised", "no-working-key", "stack-without-proxy"]);

/** iterate's proxy grants the credit only to a mind that an owner of iterate let in with a passkey
 *  (else `not-approved`): the offer says so before the owner signs. */
const APPROVED_FIRST = "A person at iterate approves each mind before its credit comes.";

/** WHO PAYS before the connect: the agents' last key is the mind's AI Gateway (agents.ts). */
const AGENTS_PAID_TODAY =
  "Your agents already work without it, paid by your own Cloudflare account (its AI Gateway credit). After you connect, each agent request goes to iterate's credit first.";

/** WHO PAYS when the credit is spent: the step has deleted its secrets by iterate's proxy
 *  (`check`), so nothing goes to iterate first, and each path falls to what the owner set. */
const SPENT_SWITCHED_OFF = "Your mind's requests no longer go to iterate.";
function afterSpent(openai: string | undefined, exa: string | undefined): string[] {
  // a delete that failed leaves a path by proxy: say which, until a later check deletes it
  const left = byIterate(openai, exa);
  return [
    left.length === 0
      ? SPENT_SWITCHED_OFF
      : `Your mind's requests to ${left.join(" and ")} still go to iterate and are refused there, until the next check switches them off.`,
    OPENAI_AFTER[openai || "unset"],
    EXA_AFTER[exa || "unset"],
  ].filter((line): line is string => Boolean(line));
}

/** The names of the paths still by iterate's proxy. */
function byIterate(openai: string | undefined, exa: string | undefined): string[] {
  return [openai === "iterate-proxy" && "OpenAI", exa === "iterate-proxy" && "Exa"].filter(
    (name): name is string => Boolean(name),
  );
}

/** AFTER A DISCONNECT, a path the vault would not delete (a key form or a sign-in on it is open:
 *  `secrets.deleteIfProxy`): its requests still go to iterate, and the card says so. */
const stillOn = (left: string[]) =>
  `Your mind's requests to ${left.join(" and ")} still go to iterate, because a form or a sign-in for that key is open. Press Disconnect again when it is closed.`;

/** Each path after the switch-off, by what `/secrets/<path>` holds. The agents' keys go: a ChatGPT
 *  plan, then `/secrets/openai`, then the AI Gateway (agents.ts); voice and Exa have no next key.
 *  A path still by iterate's proxy has no line: the sentence above names it. */
const OPENAI_AFTER: Record<string, string> = {
  own: "Your agents and voice calls run on your own OpenAI key.",
  "other-proxy": "Your agents and voice calls run through the proxy your mind set for OpenAI.",
  unset:
    "Your agents go on with your ChatGPT plan if you connected one, else with your Cloudflare account. Voice calls need a key of your own.",
};
const EXA_AFTER: Record<string, string> = {
  own: "Web research runs on your own Exa key.",
  "other-proxy": "Web research runs through the proxy your mind set for Exa.",
  unset: "Web research needs a key of your own.",
};

const dollars = (usd: number) =>
  `${usd < 0 ? "-" : ""}$${Math.abs(usd).toFixed(2).replace(/\.00$/, "")}`;

/** HOW SURE A BALANCE IS THAT THE CREDIT IS SPENT. An interrupted request is charged a high
 *  estimate that its real cost replaces up to 15 minutes later, so a balance under zero is not
 *  always spent. "spent" only when iterate says what it may still give back (`pendingUsd`) and
 *  even that leaves nothing; "counting" while it may still give back; "unknown" from a proxy that
 *  does not say (older than `pendingUsd`): on its word nothing is switched off and no mail goes. */
type Spent = "no" | "spent" | "counting" | "unknown";
function spentOf(balance: Balance | undefined): Spent {
  if (!balance || balance.remainingUsd > 0) return "no";
  if (balance.pendingUsd === undefined) return "unknown";
  return balance.remainingUsd + balance.pendingUsd <= 0 ? "spent" : "counting";
}

/** The connected card's one sentence for a balance under zero that is not certainly spent. */
const UNDER_ZERO: Partial<Record<Spent, string>> = {
  counting:
    "iterate is still counting an interrupted request. Until it has, it refuses your mind's requests; this ends within 15 minutes.",
  unknown: "Your balance is at or under zero, so iterate refuses your mind's requests for now.",
};

function words(state: StepState, context: StepContext): Card {
  const facts = factsOf(state);
  const card = { step: connectIterateCloud.id, title: "Connect to iterate Cloud" };
  const stays = byIterate(facts?.openai, facts?.exa);
  if (state.action?.name === "disconnect")
    return {
      ...card,
      status: "disconnecting",
      title: "Disconnected from iterate Cloud",
      text: [
        stays.length
          ? `${stillOn(stays)} iterate may still send messages here until you end the rule with your passkey.`
          : "No request goes through iterate any more. iterate may still send messages here until you end the rule with your passkey.",
      ],
      buttons: state.action.link ? [{ label: "End", href: state.action.link, primary: true }] : [],
    };
  // the rule ended, and a path stayed by iterate's proxy: each check tries the delete again
  if (facts?.ended && stays.length)
    return {
      ...card,
      status: "disconnecting",
      title: "Disconnecting from iterate Cloud",
      text: [stillOn(stays)],
      buttons: [{ label: "Disconnect again", action: "disconnect", primary: true }],
    };
  if (state.action)
    return {
      ...card,
      status: "connecting",
      text: [state.action.link ? "Waiting for your passkey." : "Connecting…"],
      buttons: state.action.link
        ? [{ label: "Open the page again", href: state.action.link, primary: true }]
        : [],
    };
  // iterate ended the credit for good, at a press of Connect or at a check's balance read (which has
  // deleted the secrets by iterate's proxy): no Try again, and no offer
  if (state.failure?.reason === "ended" || facts?.iterateEnded)
    return {
      ...card,
      status: "ended",
      title: "No credit from iterate Cloud",
      optional: true,
      text: [
        FAILURES.ended!,
        ...(stays.length
          ? [
              `Your mind's requests to ${stays.join(" and ")} still go to iterate and are refused there, until the next check switches them off.`,
            ]
          : []),
        ...(facts?.meld ? [RULE_STANDS] : []),
      ],
      buttons: facts?.meld
        ? [openCloud(context), { label: "End the rule", action: "disconnect" }]
        : [],
    };
  // the credit is certainly spent, from the balance alone. `check` has deleted the secrets by
  // iterate's proxy, so there is no Connect: it would set them for nothing
  if (facts?.meld && facts.balance && spentOf(facts.balance) === "spent")
    return {
      ...card,
      status: "spent",
      title: "Your iterate credit is used",
      text: [
        `Your ${dollars(facts.balance.grantedUsd)} of credit is used.`,
        ...afterSpent(facts.openai, facts.exa),
      ],
      command: `npx iterate@latest chatgpt connect ${context.mind}`,
      buttons: [
        { label: "Add my OpenAI key", action: "add-openai-key", primary: true },
        {
          label: "Add Cloudflare credit",
          href: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
        },
        openCloud(context),
        { label: "End the rule", action: "disconnect" },
      ],
    };
  // the credit is in use: a rule, a balance, and a secret that goes by iterate's proxy
  const inUse = facts?.openai === "iterate-proxy" || facts?.exa === "iterate-proxy";
  if (facts?.meld && facts.balance && inUse) {
    const { grantedUsd, remainingUsd } = facts.balance;
    const own = [
      facts.openai === "own" &&
        "Your own OpenAI key stays in use. The credit pays for web research.",
      facts.exa === "own" && "Your own Exa key stays in use.",
      facts.paused && FAILURES.paused,
      UNDER_ZERO[spentOf(facts.balance)],
    ].filter((line): line is string => Boolean(line));
    // a half-done connect: one secret by proxy, and the last ask's failure says what is missing
    const half = state.failure && (state.failure.words || FAILURES[state.failure.reason]);
    return {
      ...card,
      status: "connected",
      title: "Connected to iterate Cloud",
      text: [
        `${dollars(remainingUsd)} of ${dollars(grantedUsd)} left.`,
        ...own,
        facts.ai
          ? "Your mind's AI models now run through iterate Cloud."
          : "Your mind's AI models still run on your own Cloudflare account.",
        ...(half ? [half] : []),
      ],
      buttons: [
        ...(half ? [{ label: "Try again", action: "connect", primary: true }] : []),
        {
          label: "Try a voice call",
          href: dashLinks(context.zone).agent("/agents/main"),
          ...(!half && { primary: true }),
        },
        { label: "Add my OpenAI key", action: "add-openai-key" },
        openCloud(context),
        { label: "Disconnect", action: "disconnect" },
      ],
    };
  }
  // both keys are the owner's: the credit would pay for nothing, so it is not offered, also after
  // a "not now". A stack that cannot sign keeps its own card below.
  if (facts?.canSign && facts.openai === "own" && facts.exa === "own")
    return {
      ...card,
      status: "own-keys",
      optional: true,
      text: [
        "Your mind uses your own keys for OpenAI and Exa, so it needs no credit from iterate.",
        ...(facts.meld ? [RULE_STANDS] : []),
      ],
      buttons: facts.meld ? [{ label: "End the rule", action: "disconnect" }] : [],
    };
  if (state.declined)
    return facts?.meld
      ? {
          ...card,
          status: "declined",
          title: "No credit from iterate Cloud",
          text: [RULE_STANDS],
          buttons: [
            { label: "Connect", action: "connect" },
            { label: "End the rule", action: "disconnect" },
          ],
        }
      : {
          ...card,
          status: "declined",
          title: "Not connected to iterate Cloud",
          text: [],
          buttons: [{ label: "Connect", action: "connect" }],
        };
  if (facts && !facts.canSign)
    return {
      ...card,
      status: "unavailable",
      optional: true,
      text: [
        `iterate gives a new mind ${dollars(CREDIT_USD)} of credit for AI. This mind's platform code cannot take it yet: it does not sign requests as the mind. Update it on your computer, then check again.`,
      ],
      command: UPDATE_COMMAND,
      buttons: [
        { label: "Check again", action: "check", primary: true },
        { label: "Not now", action: "decline" },
      ],
    };
  // iterate has the request, and a person there approves it: iterate's `cloud/enrolment-open`
  // connects (`enrolmentEvent`), and Try again does the same at once
  if (state.failure?.reason === "not-approved")
    return {
      ...card,
      status: "waiting",
      title: "Waiting for iterate",
      optional: true,
      text: [FAILURES["not-approved"]!, ...(facts?.meld ? [RULE_STANDS] : [])],
      buttons: [
        { label: "Try again", action: "connect", primary: true },
        { label: "Not now", action: "decline" },
        ...(facts?.meld
          ? [openCloud(context), { label: "End the rule", action: "disconnect" }]
          : []),
      ],
    };
  // a press on a spent grant: while spent the spent card says it; once the balance is back, the offer
  if (state.failure && state.failure.reason !== "spent")
    return {
      ...card,
      status: "failed",
      optional: true,
      text: [
        state.failure.words || FAILURES[state.failure.reason] || "The connect failed.",
        ...(facts?.meld ? [RULE_STANDS] : []),
      ],
      ...(UPDATE_REASONS.has(state.failure.reason) && { command: UPDATE_COMMAND }),
      buttons: [
        { label: "Try again", action: "connect", primary: true },
        { label: "Not now", action: "decline" },
        ...(facts?.meld ? [{ label: "End the rule", action: "disconnect" }] : []),
      ],
    };
  // a grant this mind already has, with money left (it came back, or the owner disconnected)
  const left = facts?.balance && facts.balance.remainingUsd > 0 ? facts.balance.remainingUsd : 0;
  const offered = left || CREDIT_USD;
  return {
    ...card,
    status: "not-asked",
    optional: true,
    text: [
      left
        ? `Your mind has ${dollars(left)} of iterate's credit for AI left: voice calls, web research, and your agents' model requests.`
        : `iterate, the company that made this software, gives your mind ${dollars(CREDIT_USD)} of credit for AI: voice calls, web research, and your agents' model requests.`,
      ...(left ? [] : [APPROVED_FIRST]),
      AGENTS_PAID_TODAY,
    ],
    points: [
      {
        title: "What iterate sees",
        text: "While your mind uses the credit, its requests to OpenAI and Exa go through iterate Cloud, on iterate's accounts there. iterate can see those requests and their answers as they pass. It stores the numbers (which model, how much, the cost), not the content. The requests are made on iterate's accounts at OpenAI and Exa. iterate's proxy refuses a request that asks OpenAI to store it. OpenAI and Exa still keep what their own policies keep, such as abuse logs, and OpenAI keeps the working files of a code tool it runs for up to 20 idle minutes.",
      },
      {
        title: "What iterate cannot see",
        text: "Anything your mind does not send to a model or a search. The rule lets iterate add events in one place of your mind, and read nothing in it.",
      },
      {
        title: "What iterate may send",
        text: `Help and updates, as events in one place of your mind (${MELD_APPEND}), and there too the messages of accounts you connect through iterate Cloud. ${facts?.meld ? "You allowed that with your passkey already" : "You allow that with your passkey on the next page"}, and you can end it at any time.`,
      },
      {
        title: `When the ${dollars(offered)} is spent`,
        text: "Your mind stops sending requests to iterate. Your agents go on with your ChatGPT plan if you connected one, else with your Cloudflare account; voice calls and web research stop until you add a key of your own. A key of your own always wins over the credit.",
      },
    ],
    buttons: [
      { label: "Connect", action: "connect", primary: true },
      { label: "Not now", action: "decline" },
    ],
    footnote: "You can disconnect at any time.",
  };
}

async function check(context: StepContext, state: StepState): Promise<Facts> {
  const { credit } = context;
  const [canSign, meld, openai, exa, lent] = await Promise.all([
    credit.canSign(),
    meldOf(context),
    credit.secret("/secrets/openai"),
    credit.secret("/secrets/exa"),
    credit.aiLent().catch((error: unknown) => {
      console.warn({ event: "onboarding.ai-lent-read-failed", error: String(error) });
      return false;
    }),
  ]);
  const last = factsOf(state);
  // the rule's end ends the AI lending too: a turn-off that failed at the end is tried again here
  const ai = lent && meld.ended ? await aiStays(context) : lent;
  const facts: Facts = { canSign, meld: meld.on, openai, exa, ...(ai && { ai: true }) };
  /** The facts with the AI lending turned off: iterate ended the credit, or it is spent. */
  const lendingOff = async (): Promise<Facts> => ({
    canSign,
    meld: meld.on,
    openai,
    exa,
    ...(ai && (await aiStays(context)) && { ai: true }),
  });
  // THE RULE ENDED, AND A PATH STAYED: a path that a Disconnect or the rule's end could not delete
  // (the vault keeps it while a key form or a sign-in on it is open) is tried again at each check.
  // Only on an end that was read: a rule missing from the catalog's page deletes nothing, and a
  // proxy set by hand on a mind that never had a rule stays
  if (meld.ended && (openai === "iterate-proxy" || exa === "iterate-proxy"))
    return { ...facts, ended: true, ...(await switchOff(context, openai, exa)) };
  // the Cloud is asked only once a member let iterate in, only by a stack that signs, and only
  // for a mind that can take the credit: iterate learns nothing of a mind with its own keys
  if (!canSign || !meld.on || ![openai, exa].some(takesCredit)) return facts;
  // ENDED: a person at iterate ended this mind's credit for good (403 `iterate_credit_ended`). As
  // for spent, the secrets by iterate's proxy are deleted (deleteProxy: never an owner's own key),
  // so no request goes to iterate first and is refused there. The end is kept from the last facts
  // with no new ask: a later outage or pause never brings the offer back. Each check deletes again
  // a path that stayed. An older proxy answers an ended mind `not-connected`: that keeps the offer
  const stays = openai === "iterate-proxy" || exa === "iterate-proxy";
  if (last?.iterateEnded)
    return {
      ...(await lendingOff()),
      iterateEnded: true,
      ...(stays && (await switchOff(context, openai, exa))),
    };
  const answer = await credit.balance();
  if (!answer.ok && answer.reason === "ended")
    return {
      ...(await lendingOff()),
      iterateEnded: true,
      ...(await switchOff(context, openai, exa)),
    };
  if (!answer.ok) return { ...facts, ...lastBalance(answer.reason, last) };
  // under zero is not enough: only a balance that is certainly spent switches anything off
  if (spentOf(answer.balance) !== "spent") return { ...facts, balance: answer.balance };
  // SPENT: iterate's proxy is switched off for this mind, and the AI lending with it, so no request
  // goes to iterate first and
  // is refused there. deleteProxy deletes iterate's proxy and nothing else; the rule stays. Every
  // check of a spent balance does it, so a retry, two checks at once, or a mind spent before this
  // code all end with no secret by iterate's proxy. Not on "paused" or "none-today": they end
  // tomorrow and answer no balance, above.
  const spent = await lendingOff();
  if (openai !== "iterate-proxy" && exa !== "iterate-proxy")
    return { ...spent, balance: answer.balance };
  return { ...spent, ...(await switchOff(context, openai, exa)), balance: answer.balance };
}

/** Deletes both secrets by iterate's proxy, and answers what each path holds after it. A delete
 *  that throws, or that the vault refuses (a key form or a sign-in on the path is open), leaves that
 *  path by proxy in the facts, and the next check tries again. */
async function switchOff(
  context: StepContext,
  openai: Facts["openai"],
  exa: Facts["exa"],
): Promise<Pick<Facts, "openai" | "exa">> {
  const [openaiOff, exaOff] = await Promise.all(
    CREDIT_SECRETS.map(({ path }) =>
      context.credit.deleteProxy(path).catch((error: unknown) => {
        console.warn({ event: "onboarding.switch-off-failed", path, error: String(error) });
        return false;
      }),
    ),
  );
  return { openai: openaiOff ? "unset" : openai, exa: exaOff ? "unset" : exa };
}

/** Turns iterate Cloud's AI lending off, and answers whether it stays on: a turn-off that throws is
 *  a log line, and a later turn-off tries again. */
async function aiStays(context: StepContext): Promise<boolean> {
  try {
    await context.credit.endAi();
    return false;
  } catch (error) {
    console.warn({ event: "onboarding.ai-lending-end-failed", error: String(error) });
    return true;
  }
}

/** The facts' balance when iterate gave no new one: the last numbers stay, except with no grant. */
function lastBalance(reason: string, last: Facts | undefined): Partial<Facts> {
  if (reason === "paused") return { ...(last?.balance && { balance: last.balance }), paused: true };
  if (reason === "not-connected") return {};
  return { ...(last?.balance && { balance: last.balance }) };
}

/** THE GRANT AND THE SECRETS, after a member's signed rule: each path set only where it is unset,
 *  so a second connect sets nothing and an owner's key stays. Answers why it failed, or nothing. */
async function finishConnect(
  context: StepContext,
  requestOffset: number,
  log: StepLog,
  options: { tell?: "signed" | "approved" } = {},
): Promise<void> {
  const outcome = await creditOutcome(context);
  const failure = "failed" in outcome && { reason: outcome.failed, words: outcome.words };
  // The note comes BEFORE the settle: while the connect waits, cloud-handover.ts writes no note
  // of its own, so a retry after a failure between the two still finds it waiting and writes
  // this one (keyed: once).
  if (options.tell === "signed") await tellSigned(context, requestOffset, outcome);
  // iterate's approval tells the agent only when the credit came: a failure stays on the card.
  // No event of the owner's waits for this note, and the hook keeps no throw for a retry, so a
  // note that fails is one log line and the settle still comes
  if (options.tell === "approved" && "remainingUsd" in outcome)
    await tellAgent(context, `onboarding/connected:${requestOffset}`, {
      role: "developer",
      content: `iterate approved this mind just now, and the mind has ${dollars(outcome.remainingUsd)} of iterate's credit for ${outcome.pays.join(" and ") || "nothing: the owner's own keys stay in use"} (by iterate's proxy, where no key of theirs was set). Tell the owner in one sentence, with the balance (onboarding/connect-iterate-cloud.md).`,
    }).catch((error: unknown) =>
      console.warn({ event: "onboarding.approved-note-failed", error: String(error) }),
    );
  await log.settle(requestOffset, failure || undefined);
}

type Outcome =
  | { failed: string; words?: string }
  | { remainingUsd: number; pays: string[] }
  | { ownKeys: true };

/** The grant, and both secrets by iterate's proxy where none is set. A throw is a failure too, so
 *  the ask settles. An invocation that dies before the settle leaves the ask to its `expires`. */
async function creditOutcome(context: StepContext): Promise<Outcome> {
  const pays: string[] = [];
  // what stands after a half-done connect: the secrets already by proxy, and Try again finishes
  const stopped = (reason: string): Outcome => ({
    failed: reason,
    words: [
      FAILURES[reason],
      pays.length > 0 &&
        `iterate's credit already pays for ${pays.join(" and ")}. Try again sets up the rest.`,
    ]
      .filter(Boolean)
      .join(" "),
  });
  try {
    // the keys first: no grant is asked for a mind whose own keys leave nothing to pay for
    const kinds = await Promise.all(CREDIT_SECRETS.map(({ path }) => context.credit.secret(path)));
    if (!kinds.some(takesCredit)) return { ownKeys: true };
    const answer = await context.credit.connect();
    // no grant, so nothing is set: a secret by proxy would only be refused. On "not-approved" the
    // owner's rule stays, so that iterate can tell the mind once it is approved, and a later
    // press connects with no new passkey
    if (!answer.ok) return { failed: answer.reason };
    // a spent grant sets nothing: the next check would only switch the proxy off again
    if (spentOf(answer.balance) === "spent") return { failed: "spent" };
    for (const [index, { path, urls, name }] of CREDIT_SECRETS.entries()) {
      const kind = kinds[index]!;
      const set = kind === "unset" ? await context.credit.setByProxy(path, urls) : kind;
      if (set === "no-proxy-layer") return stopped("stack-without-proxy");
      if (set === "approval-rule" || set === "being-set") return stopped(set);
      if (set === "set" || set === "iterate-proxy") pays.push(name);
    }
    // connected: iterate Cloud's AI lending too, best effort. A refusal leaves `itx.ai` as it was,
    // and the card says where the mind's AI runs
    if (pays.length > 0) {
      const lent = await context.credit
        .lendAi()
        .catch((error: unknown): CloudAiAnswer => ({ on: false, reason: String(error) }));
      if (!lent.on) console.warn({ event: "onboarding.ai-lending-off", reason: lent.reason });
    }
    return { remainingUsd: answer.balance.remainingUsd, pays };
  } catch (error) {
    console.warn({ event: "onboarding.connect-stopped", error: String(error) });
    return stopped("stopped");
  }
}

/** THE ONE NOTE AT THE OWNER'S SIGNED RULE, which starts the onboarding agent's turn: the signing
 *  page has brought the owner back to the chat. cloud-handover.ts `iterateLetInEvent` writes none
 *  while a connect waits (steps.ts `connectWaitsForRule`), so the agent has one turn for it. */
async function tellSigned(context: StepContext, requestOffset: number, outcome: Outcome) {
  const signed =
    "The owner signed the rule with their passkey just now: iterate.iterate.com can now send messages to this mind, under /minds/<iterate's id>/.";
  const content =
    "ownKeys" in outcome
      ? `${signed} The mind takes no credit: the owner's own keys for OpenAI and Exa stay in use. Say so in one sentence, and go on with the next subject in the same message (onboarding/connect-iterate-cloud.md).`
      : "failed" in outcome
        ? `${signed} The credit did not come: ${outcome.words || FAILURES[outcome.failed] || "the connect failed."} The rule stands until the owner ends it with their passkey (the card's "End the rule"). Say both in one sentence each, and go on with the next subject in the same message (onboarding/connect-iterate-cloud.md).`
        : `${signed} The mind has ${dollars(outcome.remainingUsd)} of iterate's credit for ${outcome.pays.join(" and ") || "nothing: the owner's own keys stay in use"} (by iterate's proxy, where no key of theirs was set). Say so in one sentence, with the balance, and go on with the next subject in the same message (onboarding/connect-iterate-cloud.md).`;
  await tellAgent(context, `onboarding/connected:${requestOffset}`, { role: "developer", content });
}

/** ONE KEYED ITEM in the onboarding agent's chat. Answers whether THIS call wrote it: the claim
 *  in `metadata` is the call's own, and the platform compares metadata as it compares the payload,
 *  so a second writer of the same key, at the same moment or later, is refused. */
async function tellAgent(
  context: StepContext,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  type = "events.iterate.com/agent/context-added",
): Promise<boolean> {
  return context.itx
    .cd("/agents/main")
    .append({ type, idempotencyKey, payload, metadata: { claim: crypto.randomUUID() } })
    .then(
      () => true,
      (error: unknown) => {
        if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
        return false;
      },
    );
}

async function propose(context: StepContext, append: string[]) {
  return context.itx.approvals.proposeStatement({
    path: MELD_CONTEXT,
    type: "events.iterate.com/mind-meld/configured",
    payload: { append, name: ITERATE_HOSTNAME },
    next: `https://onboarding.${context.zone}/`,
  });
}

async function act(
  context: StepContext,
  action: string,
  state: StepState,
  log: StepLog,
): Promise<{ link?: string } | void> {
  const facts = factsOf(state);
  if (action === "add-openai-key") {
    // the mind's own form: its value replaces the secret by proxy, and the agent never sees it
    // no ask on the log: the secret's own fact moves the card (`hears`)
    const { url } = await context.itx.secrets.collectFromUser({
      path: "/secrets/openai",
      egress: { urls: ["https://api.openai.com"] },
      description: "An OpenAI API key, from https://platform.openai.com/api-keys",
    });
    return { link: url };
  }
  if (action === "disconnect") {
    // a path that stays is said on the card, and does not hold up the rule's end
    await switchOff(context, facts?.openai || "unset", facts?.exa || "unset");
    await aiStays(context);
    if (!facts?.meld) return log.settle(await log.request(action));
    const { signAt, expires } = await propose(context, []);
    await log.request(action, { link: signAt, expires });
    return { link: signAt };
  }
  // connect: offers nothing a stack that cannot sign could do, nor a credit that pays for nothing
  if (!facts?.canSign || (facts.openai === "own" && facts.exa === "own")) return;
  // a second press while one waits answers the waiting ask and its link
  if (state.action?.name === "connect") return;
  // the rule was signed before: no page, no new rule, and the press itself shows the outcome
  if (facts.meld) {
    await finishConnect(
      context,
      await log.request(action, { expires: context.now + CONNECT_MS }),
      log,
    );
    return;
  }
  const { signAt, expires } = await propose(context, [MELD_APPEND]);
  await log.request(action, { link: signAt, expires });
  return { link: signAt };
}

const CREDIT_PATHS = new Set<string>(CREDIT_SECRETS.map((secret) => secret.path));

/** A failed request of an agent whose error has one of iterate's credit codes (the request
 *  maker writes the provider's answer into `errorMessage`, agent/llm-request.ts). It only starts a
 *  check, which reads the balance: a refusal that is no spent credit (`iterate_credit_store_not_off`,
 *  `iterate_credit_nothing_stored`) leaves the card as it was, because "used" comes from the
 *  balance alone (`changed`). */
const CreditRefused = z.object({
  result: z.object({
    status: z.literal("failed"),
    errorMessage: z.string().regex(/iterate_credit_/),
  }),
});

function hears(event: MindEvent) {
  switch (event.type) {
    case "events.iterate.com/mind-meld/configured":
      // a member's passkey, and nothing else, starts the grant or ends the credit
      return event.path === MELD_CONTEXT && event.source?.signer?.member === true;
    case "events.iterate.com/secret/set":
    case "events.iterate.com/secret/deleted":
      return CREDIT_PATHS.has(event.path);
    case "events.iterate.com/mind/worker-updated":
      return event.path === "/";
    case "events.iterate.com/llm-request/settled":
      return CreditRefused.safeParse(event.payload).success;
    default:
      return false;
  }
}

async function onEvent(context: StepContext, event: MindEvent, state: StepState, log: StepLog) {
  if (event.type !== "events.iterate.com/mind-meld/configured") return;
  const rule = MeldRule.safeParse(event.payload);
  if (!rule.success) return;
  if (rule.data.append.length > 0) {
    if (state.action?.name !== "connect") return;
    const { requestOffset } = state.action;
    await finishConnect(context, requestOffset, log, { tell: "signed" });
    return;
  }
  // the rule and the credit are one offer: the end of the rule ends the credit, and the AI lending
  await switchOff(context, "unset", "unset");
  await aiStays(context);
  if (state.action?.name === "disconnect") await log.settle(state.action.requestOffset);
}

/** AT THE MOMENT THE CREDIT IS USED: one drawn message in the onboarding chat and one mail to the
 *  member who signed the rule, with no model request (nothing may pay for one now). ONCE FOR EACH
 *  GRANT: the chat's item is keyed by the grant, and only the call whose item landed draws the
 *  message and sends the mail. Two checks at the same moment, and a balance that passes zero
 *  again (a reservation settles below its estimate), add nothing. */
async function changed(
  context: StepContext,
  before: StepState["facts"],
  after: Record<string, unknown>,
) {
  const next = Facts.safeParse(after).data;
  const last = Facts.safeParse(before).data;
  // a balance exists only after a grant, so a mind that never took the credit has none
  if (!next?.meld || !next.balance || spentOf(next.balance) !== "spent") return;
  if (spentOf(last?.balance) === "spent") return;
  const text = [
    `Your ${dollars(next.balance.grantedUsd)} of iterate credit is used.`,
    ...afterSpent(next.openai, next.exa),
    "Choose what pays now:",
    `- Your ChatGPT plan: run \`npx iterate@latest chatgpt connect ${context.mind}\` on your computer.`,
    `- Your own OpenAI key: the button on https://onboarding.${context.zone}/ opens the mind's form for it.`,
    "- Cloudflare credit: add it at https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
  ].join("\n");
  const key = `onboarding/credit-spent:${next.balance.grantedUsd}`;
  if (!(await tellAgent(context, key, { role: "assistant", content: text }))) return;
  await tellAgent(
    context,
    `${key}:shown`,
    { message: text },
    // the words a person reads in the chat (agent-ui.ts)
    "events.iterate.com/agent-ui/message-sent",
  );
  const signer = (await meldOf(context)).signer;
  if (!signer) return;
  // a mail that cannot be sent leaves the chat's message and the card: both say the same
  await context.itx.email
    .send({
      from: `onboarding@${context.zone}`,
      to: signer,
      subject: "Your iterate credit is used",
      text,
    })
    .catch((error: unknown) =>
      console.warn({ event: "onboarding.credit-spent-mail-failed", error: String(error) }),
    );
}

// iterate.iterate.com adds its enrolment events on `/cloud` of its context here, under the path
// the owner's rule lets it append to; steps.ts `onboardingMindEvent` hands the step only those it
// signed (`enrolmentOf`).
const EnrolmentOpen = z.object({ hostname: z.string() });
const Enrolled = z.object({ mind: z.string(), hostname: z.string() });

/** The cards on which the step waits for iterate: the last connect did not come, and it was not
 *  ended. Not connected, not declined, no ask that waits, and not spent. */
const WAITS_FOR_ITERATE = new Set(["waiting", "failed"]);

/** iterate LET THIS MIND IN (`cloud/enrolment-open`), or GRANTED IT (`cloud/enrolled`, for THIS
 *  mind's id): the step connects as Try again does, with no new passkey, once for each delivered
 *  event (`requestOnce`, keyed by the event). On a declined, ended or connected step: nothing. */
async function onMindEvent(context: StepContext, event: MindEvent, state: StepState, log: StepLog) {
  if (event.type === "events.iterate.com/cloud/enrolled") {
    const enrolled = Enrolled.safeParse(event.payload).data;
    const { mindId } = await context.itx.whoami();
    if (!enrolled || enrolled.mind !== mindId) {
      console.info({ event: "onboarding.enrolled-another-mind", mind: enrolled?.mind });
      return;
    }
  } else if (
    event.type !== "events.iterate.com/cloud/enrolment-open" ||
    !EnrolmentOpen.safeParse(event.payload).success
  )
    return;
  if (!factsOf(state)?.meld || !WAITS_FOR_ITERATE.has(words(state, context).status)) return;
  const requestOffset = await log.requestOnce("connect", `${event.path}@${event.offset}`, {
    expires: context.now + CONNECT_MS,
  });
  if (requestOffset === undefined) return;
  try {
    await finishConnect(context, requestOffset, log, { tell: "approved" });
  } catch (error) {
    // the hook keeps no throw, so no redelivery comes: the ask ends now as "stopped", and the card
    // shows Try again, and a later event of iterate's finds it failed and connects again. When the
    // settle itself is what failed, this one may fail too: then the ask waits for its `expires`,
    // as before, and the next check settles it
    await log
      .settle(requestOffset, { reason: "stopped" })
      .catch((settleError: unknown) =>
        console.warn({ event: "onboarding.stopped-settle-failed", error: String(settleError) }),
      );
    throw error;
  }
}

export const connectIterateCloud: Step = {
  id: "connect-iterate-cloud",
  // the passkey page comes only to sign the rule (Connect with none) or to end it (Disconnect with
  // one): with the rule on, Connect acts at once; with none, Disconnect has nothing to sign
  actions: {
    connect: { opens: (state) => !factsOf(state)?.meld },
    disconnect: { opens: (state) => Boolean(factsOf(state)?.meld) },
    "add-openai-key": { opens: true },
  },
  // open while CREDIT_OPEN is true; iterate Cloud's own mind gives the credit, so it is offered none
  offered: (context) => context.creditOpen && context.mind !== ITERATE_HOSTNAME,
  words,
  check,
  act,
  hears,
  onEvent,
  onMindEvent,
  changed,
};
