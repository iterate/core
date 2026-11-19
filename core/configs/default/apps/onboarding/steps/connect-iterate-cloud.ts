// connect-iterate-cloud.ts — THE STEP "Connect to iterate Cloud": one offer, one button. The owner
// signs the meld rule with their passkey (iterate may add events under one path of the mind);
// when the signed rule lands, the mind asks iterate Cloud for its grant and sets `/secrets/openai`
// and `/secrets/exa` by iterate's proxy where no key is set. An owner's own key is never written.
// Ending the rule ends the credit: the secrets by iterate's proxy are deleted.
//
// No request goes to iterate before a member's signed rule. The rule is this page's gate: the
// proxy recognises a mind by its signed request alone (cloud-credit.ts says what each call needs).
//
// The card's states, first that holds wins: connecting or disconnecting (an ask waits), connected
// or spent (a rule, a balance and a secret by iterate's proxy), declined, unavailable (the stack cannot sign as the mind yet),
// failed (the last ask, with its reason), not asked.
import { errorCode } from "iterate/lib";
import { z } from "zod";
import { ITERATE_MIND } from "../../../cloud-deliveries.ts";
import { Balance, CREDIT_SECRETS } from "../cloud-credit.ts";
import type { StepState } from "../contract.ts";
import type { Card, MindEvent, Step, StepContext, StepLog } from "../steps.ts";

/** What iterate gives a new mind, in dollars: the card's words before the Cloud said a balance. */
const CREDIT_USD = 10;

/** WHETHER THIS STEP IS OFFERED AT ALL. False until iterate Cloud's secret proxy is live: an
 *  offer that ends in "iterate Cloud did not answer" after a passkey press is worse than none.
 *  While it is false, no mind shows the card, the tool answers that the mind has no such step
 *  (the onboarding agent then asks the "let iterate in" question, onboarding.md section 5), and
 *  nothing asks iterate for anything. The pull request that lands when the secret proxy is live
 *  sets it to true. Tests open the step by `StepContext.creditOpen`. */
export const CREDIT_OPEN = false;

/** Where the rule lands, and the one path under which it lets iterate add events. */
const MELD_CONTEXT = `/minds/${ITERATE_MIND}`;
const MELD_APPEND = `/minds/${ITERATE_MIND}/`;

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
});
type Facts = z.infer<typeof Facts>;

const factsOf = (state: StepState): Facts | undefined => Facts.safeParse(state.facts).data;

/** A rule's payload: an empty `append` ends the meld. */
const MeldRule = z.object({ append: z.array(z.string()) });

/** THE LATEST RULE A MEMBER SIGNED for iterate, and who signed it. The context is read only when
 *  it exists: a read would make it. */
async function meldOf(context: StepContext): Promise<{ on: boolean; signer?: string }> {
  const listed = await context.itx.contexts.list({ under: MELD_CONTEXT, limit: 1000 });
  if (!listed.some((one) => one.path === MELD_CONTEXT)) return { on: false };
  let meld: { on: boolean; signer?: string } = { on: false };
  for (let after = 0; ;) {
    const page = await context.itx.cd(MELD_CONTEXT).readEvents(after, 500);
    for (const event of page.events) {
      if (event.type !== "events.iterate.com/mind-meld/configured") continue;
      if (event.source?.signer?.member !== true) continue;
      const rule = MeldRule.safeParse(event.payload);
      if (!rule.success) continue;
      meld = { on: rule.data.append.length > 0, signer: event.source.signer.principal.email };
    }
    if (page.atHead || page.scannedThroughOffset <= after) break;
    after = page.scannedThroughOffset;
  }
  return meld;
}

/** The words of each reason an ask failed. */
const FAILURES: Record<string, string> = {
  "not-signed": "The passkey page expired before it was signed. Nothing was connected.",
  "cloud-unreachable": "iterate Cloud did not answer. Nothing was set up. Try again in a minute.",
  "not-recognised": `iterate Cloud did not recognise this mind's signature. Update your mind on your computer, then try again.`,
  "no-working-key": `iterate Cloud could not check this mind's key. Update your mind on your computer, then try again.`,
  "stack-without-proxy": `This mind's platform code cannot use the credit yet. Update your mind on your computer, then try again.`,
  "none-today":
    "iterate gives a limited number of new credits each day, and today's are gone. Try again tomorrow (UTC).",
  paused: "iterate's credit is paused until tomorrow (UTC).",
};

/** The reasons whose fix is the update command. */
const UPDATE_REASONS = new Set(["not-recognised", "no-working-key", "stack-without-proxy"]);

const dollars = (usd: number) => `$${usd.toFixed(2).replace(/\.00$/, "")}`;

function words(state: StepState, context: StepContext): Card {
  const facts = factsOf(state);
  const card = { step: connectIterateCloud.id, title: "Connect to iterate Cloud" };
  if (state.action?.name === "disconnect")
    return {
      ...card,
      status: "disconnecting",
      title: "Disconnected from iterate Cloud",
      text: [
        "No request goes through iterate any more. iterate may still send messages here until you end the rule with your passkey.",
      ],
      buttons: state.action.link ? [{ label: "End", href: state.action.link, primary: true }] : [],
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
  // the credit is in use: a rule, a balance, and a secret that goes by iterate's proxy
  const inUse = facts?.openai === "iterate-proxy" || facts?.exa === "iterate-proxy";
  if (facts?.meld && facts.balance && inUse) {
    const { grantedUsd, remainingUsd } = facts.balance;
    const own = [
      facts.openai === "own" &&
        "Your own OpenAI key stays in use. The credit pays for web research.",
      facts.exa === "own" && "Your own Exa key stays in use.",
      facts.paused && FAILURES.paused,
    ].filter((line): line is string => Boolean(line));
    if (remainingUsd <= 0)
      return {
        ...card,
        status: "spent",
        title: "Your iterate credit is used",
        text: [`Your ${dollars(grantedUsd)} of credit is used. Choose what pays now:`, ...own],
        command: `npx iterate@latest chatgpt connect ${context.mind}`,
        buttons: [
          { label: "I ran the command: check again", action: "check" },
          { label: "Add my OpenAI key", action: "add-openai-key", primary: true },
          {
            label: "Add Cloudflare credit",
            href: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
          },
          { label: "Disconnect", action: "disconnect" },
        ],
      };
    return {
      ...card,
      status: "connected",
      title: "Connected to iterate Cloud",
      text: [`${dollars(remainingUsd)} of ${dollars(grantedUsd)} left.`, ...own],
      buttons: [
        { label: "Try a voice call", href: `https://voice.${context.zone}/`, primary: true },
        { label: "Disconnect", action: "disconnect" },
      ],
    };
  }
  if (state.declined)
    return facts?.meld
      ? {
          ...card,
          status: "declined",
          title: "No credit from iterate Cloud",
          text: [
            "Your signed rule still lets iterate send help and updates to this mind. End it with your passkey to stop that.",
          ],
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
  if (state.failure)
    return {
      ...card,
      status: "failed",
      optional: true,
      text: [state.failure.words || FAILURES[state.failure.reason] || "The connect failed."],
      ...(UPDATE_REASONS.has(state.failure.reason) && { command: UPDATE_COMMAND }),
      buttons: [
        { label: "Try again", action: "connect", primary: true },
        { label: "Not now", action: "decline" },
      ],
    };
  return {
    ...card,
    status: "not-asked",
    optional: true,
    text: [
      `iterate, the company that made this software, gives your mind ${dollars(CREDIT_USD)} of credit for AI. Agents, voice calls and web research work at once, with no key of yours.`,
    ],
    points: [
      {
        title: "What iterate sees",
        text: "While your mind uses the credit, its requests to OpenAI and Exa go through iterate Cloud, on iterate's accounts there. iterate can see those requests and their answers as they pass. It stores the numbers (which model, how much, the cost), not the content. The requests are made on iterate's accounts at OpenAI and Exa, and those providers keep them as they keep any request.",
      },
      {
        title: "What iterate cannot see",
        text: "Anything your mind does not send to a model or a search. The rule lets iterate add events in one place of your mind, and read nothing in it.",
      },
      {
        title: "What iterate may send",
        text: `Help and updates, as events in one place of your mind (${MELD_APPEND}), and there too the messages of accounts you connect through iterate Cloud. You allow that with your passkey on the next page, and you can end it at any time.`,
      },
      {
        title: `When the ${dollars(CREDIT_USD)} is spent`,
        text: "Your mind uses your own way to pay, if you set one. A key of your own always wins over the credit.",
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
  const [canSign, meld, openai, exa] = await Promise.all([
    credit.canSign(),
    meldOf(context),
    credit.secret("/secrets/openai"),
    credit.secret("/secrets/exa"),
  ]);
  const last = factsOf(state);
  const facts: Facts = { canSign, meld: meld.on, openai, exa };
  // the Cloud is asked only once a member let iterate in, and only by a stack that signs
  if (!canSign || !meld.on) return facts;
  const answer = await credit.balance();
  if (answer.ok) return { ...facts, balance: answer.balance };
  if (answer.reason === "paused")
    return { ...facts, ...(last?.balance && { balance: last.balance }), paused: true };
  // no grant: no balance. No answer: the last numbers stay
  if (answer.reason === "not-connected") return facts;
  return { ...facts, ...(last?.balance && { balance: last.balance }) };
}

/** THE GRANT AND THE SECRETS, after a member's signed rule: each path set only where it is unset,
 *  so a second connect sets nothing and an owner's key stays. Answers why it failed, or nothing. */
async function finishConnect(
  context: StepContext,
  requestOffset: number,
  log: StepLog,
  options: { tell?: boolean } = {},
): Promise<void> {
  const outcome = await creditOutcome(context);
  // The note comes BEFORE the settle: while the connect waits, cloud-handover.ts writes no note
  // of its own, so a retry after a failure between the two still finds it waiting and writes
  // this one (keyed: once).
  if (options.tell) await tellSigned(context, requestOffset, outcome);
  await log.settle(requestOffset, "failed" in outcome ? { reason: outcome.failed } : undefined);
}

/** The grant, and both secrets by iterate's proxy where none is set. */
async function creditOutcome(
  context: StepContext,
): Promise<{ failed: string } | { remainingUsd: number }> {
  const answer = await context.credit.connect();
  if (!answer.ok) return { failed: answer.reason };
  for (const { path, urls } of CREDIT_SECRETS) {
    if ((await context.credit.secret(path)) !== "unset") continue;
    if ((await context.credit.setByProxy(path, urls)) === "no-proxy-layer")
      return { failed: "stack-without-proxy" };
  }
  return { remainingUsd: answer.balance.remainingUsd };
}

/** THE ONE NOTE AT THE OWNER'S SIGNED RULE, which starts the onboarding agent's turn: the signing
 *  page has brought the owner back to the chat. cloud-handover.ts `iterateLetInEvent` writes none
 *  while a connect waits (steps.ts `connectWaitsForRule`), so the agent has one turn for it. */
async function tellSigned(
  context: StepContext,
  requestOffset: number,
  outcome: { failed: string } | { remainingUsd: number },
) {
  const signed =
    "The owner signed the rule with their passkey just now: iterate.iterate.com can now send messages to this mind, under /minds/iterate.iterate.com/.";
  const content =
    "failed" in outcome
      ? `${signed} The credit did not come: ${FAILURES[outcome.failed] || "the connect failed."} Say both in one sentence each, and go on with the next subject in the same message (onboarding/connect-iterate-cloud.md).`
      : `${signed} The mind has ${dollars(outcome.remainingUsd)} of iterate's credit for OpenAI and Exa (by iterate's proxy, where no key of theirs was set). Say so in one sentence, with the balance, and go on with the next subject in the same message (onboarding/connect-iterate-cloud.md).`;
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
    .cd("/agents/onboarding")
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
    payload: { append },
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
    for (const { path } of CREDIT_SECRETS) await context.credit.deleteProxy(path);
    if (!facts?.meld) return log.settle(await log.request(action));
    const { signAt, expires } = await propose(context, []);
    await log.request(action, { link: signAt, expires });
    return { link: signAt };
  }
  // connect: offers nothing a stack that cannot sign could do
  if (!facts?.canSign) return;
  // a second press while one waits answers the waiting ask and its link
  if (state.action?.name === "connect") return;
  // the rule was signed before: no page, no new rule, and the press itself shows the outcome
  if (facts.meld) {
    await finishConnect(context, await log.request(action), log);
    return;
  }
  const { signAt, expires } = await propose(context, [MELD_APPEND]);
  await log.request(action, { link: signAt, expires });
  return { link: signAt };
}

const CREDIT_PATHS = new Set<string>(CREDIT_SECRETS.map((secret) => secret.path));

/** A failed agent request whose key answered with one of iterate's credit codes. */
const CreditRefused = z.object({
  failedKeys: z.array(z.object({ error: z.string().regex(/iterate_credit_/) })).min(1),
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
    case "events.iterate.com/agent/llm-request-settled":
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
    await finishConnect(context, requestOffset, log, { tell: true });
    return;
  }
  // the rule and the credit are one offer: the end of the rule ends the credit
  for (const { path } of CREDIT_SECRETS) await context.credit.deleteProxy(path);
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
  const inUse = next?.openai === "iterate-proxy" || next?.exa === "iterate-proxy";
  if (!next?.meld || !next.balance || !inUse || next.balance.remainingUsd > 0) return;
  if (last?.balance && last.balance.remainingUsd <= 0) return;
  const text = [
    `Your ${dollars(next.balance.grantedUsd)} of iterate credit is used. Choose what pays now:`,
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
    "events.iterate.com/agent/web-message-sent",
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

export const connectIterateCloud: Step = {
  id: "connect-iterate-cloud",
  actions: {
    connect: { opens: true },
    disconnect: { opens: true },
    "add-openai-key": { opens: true },
  },
  // closed until iterate Cloud's side is live (CREDIT_OPEN); iterate Cloud's own mind gives the
  // credit, so it is offered none
  offered: (context) => context.creditOpen && context.mind !== ITERATE_MIND,
  words,
  check,
  act,
  hears,
  onEvent,
  changed,
};
