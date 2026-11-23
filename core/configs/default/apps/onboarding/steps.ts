// steps.ts — THE LIST OF ONBOARDING STEPS, and the four ways in to them: `runStep` (a button's
// press, and the same as the agent's tool `itx.config.onboardingStep(step, action)`),
// `onboardingCards` (what the page draws), `onboardingEvent` (the hook in every-event.ts, for the
// events of the mind that change a step) and `onboardingMindEvent` (deliveries.ts `otherMindEvent`,
// for iterate.iterate.com's enrolment events). A step is one module of steps/ with
// `{ id, actions, offered, words, check, act, hears, onEvent }`; a new step is one more entry in
// `STEPS`. Every step writes the four events of contract.ts on `/apps/onboarding`.
import { errorCode } from "iterate/lib";
import type { IterateConfigProcessEventArgs } from "iterate/sdk";
import { iterateContextOf, signedByIterate } from "../../cloud-deliveries.ts";
import {
  ONBOARDING_CONTEXT,
  type OnboardingEvent,
  type OnboardingState,
  reduceAll,
  type StepState,
} from "./contract.ts";
import { type CloudCredit, cloudCredit } from "./cloud-credit.ts";
import { connectCloudflare } from "./steps/connect-cloudflare.ts";
import { CREDIT_OPEN, connectIterateCloud } from "./steps/connect-iterate-cloud.ts";

/** The mind as the steps use it: the root's itx. */
export type OnboardingItx = Pick<
  IterateConfigProcessEventArgs["itx"],
  | "cd"
  | "whoami"
  | "fetch"
  | "url"
  | "secrets"
  | "approvals"
  | "contexts"
  | "minds"
  | "email"
  | "kv"
>;

/** What a step is handed for one call. */
export type StepContext = {
  itx: OnboardingItx;
  credit: CloudCredit;
  /** The mind's control-plane hostname, where its own pages are. */
  mind: string;
  /** The zone of the mind's apps: this app is at `onboarding.<zone>`. */
  zone: string;
  now: number;
  /** Whether iterate Cloud's credit is offered (steps/connect-iterate-cloud.ts `CREDIT_OPEN`). */
  creditOpen: boolean;
};

/** One button of a card: an action of the step, or a link. `opens`: the press answers a page to
 *  open, so the page opens its tab in the press itself, or the browser blocks it. steps.ts sets it
 *  from the step's `actions`; a step's `words` never does. */
export type CardButton = {
  label: string;
  action?: string;
  href?: string;
  primary?: boolean;
  opens?: true;
};

/** WHAT THE PAGE DRAWS FOR A STEP, and what the agent's tool answers in words. */
export type Card = {
  step: string;
  status: string;
  title: string;
  /** "optional" beside the title. */
  optional?: boolean;
  /** Sentences, one paragraph each. */
  text: string[];
  /** Points with a short heading each. */
  points?: { title: string; text: string }[];
  /** A command for the owner's own computer, in a block of its own. */
  command?: string;
  buttons: CardButton[];
  footnote?: string;
};

/** The writes a step makes on the onboarding log, for its own name. */
export type StepLog = {
  /** Asks for an action: its offset names the ask. `expires` bounds the ask: with a `link` it is
   *  the signing page's end, without one the time by which the step's own work must settle it. */
  request(
    action: string,
    signing?: { link?: string; expires: number; attempt?: string },
  ): Promise<number>;
  /** Asks for an action once for each `once`: the ask's offset, or nothing when this `once` asked
   *  before (a second delivery of the same event). */
  requestOnce(
    action: string,
    once: string,
    signing: { expires: number },
  ): Promise<number | undefined>;
  settle(requestOffset: number, failure?: { reason: string; words?: string }): Promise<void>;
};

export type Step = {
  id: string;
  /** The actions of its buttons, besides "decline" and "check", which every step has. `opens`:
   *  its answer may be a page to open (an action that answers a link and does not say so fails).
   *  A function decides it from the step's state, when that decides whether a page comes: the
   *  page then opens no tab for a press that answers none. */
  actions: Readonly<Record<string, { opens: boolean | ((state: StepState) => boolean) }>>;
  /** Whether this mind is offered the step. */
  offered(context: StepContext): boolean;
  words(state: StepState, context: StepContext): Card;
  /** The facts, read from the truth. `state.facts` holds the last ones. */
  check(context: StepContext, state: StepState): Promise<Record<string, unknown>>;
  /** A press of one of `actions`: the page the owner opens next, when the action made one. */
  act(
    context: StepContext,
    action: string,
    state: StepState,
    log: StepLog,
  ): Promise<{ link?: string } | void>;
  /** Whether an event of the mind concerns the step: a cheap test, before anything is read. */
  hears(event: MindEvent): boolean;
  onEvent(context: StepContext, event: MindEvent, state: StepState, log: StepLog): Promise<void>;
  /** An event iterate.iterate.com signed on `/cloud` of its context (`onboardingMindEvent`). */
  onMindEvent?(
    context: StepContext,
    event: MindEvent,
    state: StepState,
    log: StepLog,
  ): Promise<void>;
  /** After a check changed the facts: what the step does once at that change. */
  changed?(
    context: StepContext,
    before: StepState["facts"],
    after: Record<string, unknown>,
  ): Promise<void>;
};

/** An event as `processEvent` hands it, as far as the steps read it. */
export type MindEvent = {
  type: string;
  path: string;
  offset: number;
  payload?: unknown;
  source?: {
    signer?: { principal: { email?: string; kind?: string; actor?: string }; member?: boolean };
  };
};

/** THE STEPS, in the order the page shows them. */
const STEPS: readonly Step[] = [connectIterateCloud, connectCloudflare];

/** What the agent's tool answers: the card's status, its words as plain text, and the one link
 *  the owner opens next, when there is one. */
export type StepAnswer = { status: string; words: string; link?: string };

const blank = (): StepState => ({ declined: false, action: null, failure: null, facts: null });

/** The steps' context for a real mind. */
export async function stepContext(itx: OnboardingItx): Promise<StepContext> {
  const [{ mindSlug }, url] = await Promise.all([itx.whoami(), itx.url()]);
  if (!mindSlug) throw new Error("onboarding: the mind did not say its control-plane hostname");
  return {
    itx,
    credit: cloudCredit(itx),
    mind: mindSlug,
    zone: new URL(url).hostname,
    now: Date.now(),
    creditOpen: CREDIT_OPEN,
  };
}

/** The onboarding log, folded: a small log, read whole. */
async function readState(itx: Pick<OnboardingItx, "cd">): Promise<OnboardingState> {
  const events: OnboardingEvent[] = [];
  for (let after = 0; ;) {
    const page = await itx.cd(ONBOARDING_CONTEXT).readEvents(after, 500);
    events.push(...page.events);
    if (page.atHead || page.scannedThroughOffset <= after) break;
    after = page.scannedThroughOffset;
  }
  return reduceAll(events);
}

/** WHETHER A CONNECT OF THE STEP "Connect to iterate Cloud" WAITS FOR THE OWNER'S SIGNED RULE.
 *  While it waits, the step writes the one note that starts the onboarding agent's turn when the
 *  rule lands, and cloud-handover.ts `iterateLetInEvent` writes none. */
export async function connectWaitsForRule(itx: Pick<OnboardingItx, "cd">): Promise<boolean> {
  return (await readState(itx)).steps["connect-iterate-cloud"]?.action?.name === "connect";
}

/** Whether the owner said "not now" to the step "Connect to iterate Cloud", and has not pressed
 *  Connect since. */
export async function connectDeclined(itx: Pick<OnboardingItx, "cd">): Promise<boolean> {
  return (await readState(itx)).steps["connect-iterate-cloud"]?.declined === true;
}

/** One keyed append: a key already taken is the same write landed before. */
async function append(
  itx: OnboardingItx,
  type: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  const [event] = await itx
    .cd(ONBOARDING_CONTEXT)
    .append({ type, idempotencyKey, payload })
    .catch((error: unknown) => {
      if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
      return [];
    });
  return event?.offset;
}

function logOf(context: StepContext, step: Step, state: OnboardingState): StepLog {
  return {
    async request(action, signing) {
      const offset = await append(
        context.itx,
        "onboarding/step-action-requested",
        `onboarding/step-action-requested:${step.id}:${action}:${state.offset}`,
        {
          step: step.id,
          action,
          ...(signing?.link && { link: signing.link }),
          ...(signing && { expires: new Date(signing.expires).toISOString() }),
          ...(signing?.attempt && { attempt: signing.attempt }),
        },
      );
      if (offset !== undefined) return offset;
      // another press from the same state asked first: its ask is this one
      const now = (await readState(context.itx)).steps[step.id]?.action;
      if (!now) throw new Error(`onboarding: the ask "${action}" of ${step.id} did not land`);
      return now.requestOffset;
    },
    async requestOnce(action, once, signing) {
      const offset = await append(
        context.itx,
        "onboarding/step-action-requested",
        `onboarding/step-action-requested:${step.id}:${action}:${once}`,
        { step: step.id, action, expires: new Date(signing.expires).toISOString() },
      );
      // the same key with the same payload answers the ask that landed before: not a new one
      return offset !== undefined && offset > state.offset ? offset : undefined;
    },
    async settle(requestOffset, failure) {
      await append(
        context.itx,
        "onboarding/step-action-settled",
        `onboarding/step-action-settled:${requestOffset}`,
        {
          step: step.id,
          requestOffset,
          outcome: failure ? "failed" : "succeeded",
          ...(failure && { reason: failure.reason }),
          ...(failure?.words && { words: failure.words }),
        },
      );
    },
  };
}

/** An ask past its `expires` settles: a sign-in page that expired unsigned as "not-signed", and an
 *  ask with no page, whose own work did not settle it in time (the invocation died), as "stopped".
 *  So no ask waits for ever. */
async function settleExpired(context: StepContext, step: Step, state: OnboardingState) {
  const action = state.steps[step.id]?.action;
  if (!action?.expires || Date.parse(action.expires) > context.now) return false;
  await logOf(context, step, state).settle(action.requestOffset, {
    reason: action.link ? "not-signed" : "stopped",
  });
  return true;
}

/** THE CHECK: the facts from the truth, written as `step-checked` only when they differ from the
 *  state's, keyed by what caused the check. Answers the state after it. */
async function refresh(
  context: StepContext,
  step: Step,
  state: OnboardingState,
  cause: string,
): Promise<OnboardingState> {
  const expired = await settleExpired(context, step, state);
  const current = (expired ? await readState(context.itx) : state).steps[step.id] || blank();
  const facts = await step.check(context, current);
  if (JSON.stringify(facts) === JSON.stringify(current.facts))
    return expired ? readState(context.itx) : state;
  await append(
    context.itx,
    "onboarding/step-checked",
    `onboarding/step-checked:${step.id}:${cause}`,
    { step: step.id, facts },
  );
  await step.changed?.(context, current.facts, facts);
  return readState(context.itx);
}

function stepOf(context: StepContext, id: string): Step {
  const step = STEPS.find((one) => one.id === id && one.offered(context));
  if (!step)
    throw new Error(
      `onboarding: no step "${id}" on this mind; its steps: ${
        STEPS.filter((one) => one.offered(context))
          .map((one) => one.id)
          .join(", ") || "none"
      }`,
    );
  return step;
}

/** The step's card, each button that may answer a page in this state marked `opens`. */
function cardOf(step: Step, state: StepState, context: StepContext): Card {
  const card = step.words(state, context);
  const opens = (action: string) => {
    const may = step.actions[action]?.opens;
    return typeof may === "function" ? may(state) : may;
  };
  return {
    ...card,
    buttons: card.buttons.map((button) =>
      button.action && opens(button.action) ? { ...button, opens: true } : button,
    ),
  };
}

/** The card's words as plain text, for the agent. */
function answerOf(card: Card, state: StepState, made?: string): StepAnswer {
  const words = [
    card.title + (card.optional ? " (optional)" : ""),
    ...card.text,
    ...(card.points || []).map((point) => `${point.title}: ${point.text}`),
    ...(card.command ? [`Command: ${card.command}`] : []),
    ...(card.buttons.length ? [`Buttons: ${card.buttons.map((b) => b.label).join(" · ")}`] : []),
  ].join("\n\n");
  // the waiting ask's page, while the card still offers it: an ask put aside answers no page
  const waiting = card.buttons.some((button) => button.href && button.href === state.action?.link);
  const link = made || (waiting ? state.action?.link : undefined);
  return { status: card.status, words, link };
}

/** A PRESS OF A STEP'S BUTTON, from the page or from the agent's tool: the same call. "check"
 *  reads the facts again; "decline" is "Not now"; every other action is the step's own. */
export async function runStep(
  context: StepContext,
  id: string,
  action: string,
): Promise<StepAnswer> {
  const step = stepOf(context, id);
  const own = Object.keys(step.actions);
  if (!["check", "decline", ...own].includes(action))
    throw new Error(
      `onboarding: ${id} has no action "${action}"; its actions: check, decline, ${own.join(", ")}`,
    );
  const pressed = `${action}@${Date.now()}`;
  let state = await refresh(context, step, await readState(context.itx), pressed);
  const current = state.steps[id] || blank();
  let link: string | undefined;
  if (action === "decline")
    await append(
      context.itx,
      "onboarding/step-declined",
      `onboarding/step-declined:${id}:${state.offset}`,
      { step: id },
    );
  else if (action !== "check")
    link = (await step.act(context, action, current, logOf(context, step, state)))?.link;
  // the page opens a tab only for an action that says it opens one
  if (link && !step.actions[action]?.opens)
    throw new Error(
      `onboarding: ${id}'s action "${action}" answered a page; its actions say it opens none`,
    );
  // what the action changed (a grant, a secret): the card follows at once
  if (action !== "check")
    state = await refresh(context, step, await readState(context.itx), `after:${pressed}`);
  const after = state.steps[id] || blank();
  return answerOf(cardOf(step, after, context), after, link);
}

/** EVERY CARD OF THIS MIND, checked first: what the page draws when it opens. */
export async function onboardingCards(context: StepContext): Promise<Card[]> {
  let state = await readState(context.itx);
  const cards: Card[] = [];
  for (const step of STEPS.filter((one) => one.offered(context))) {
    state = await refresh(context, step, state, `open@${context.now}`);
    cards.push(cardOf(step, state.steps[step.id] || blank(), context));
  }
  return cards;
}

/** THE HOOK (every-event.ts, beside the others): an event of the mind that a step hears. Any other
 *  event returns before anything is read. */
export async function onboardingEvent(itx: OnboardingItx, event: MindEvent) {
  if (!STEPS.some((step) => step.hears(event))) return;
  await stepEvent(await stepContext(itx), event);
}

/** THE HOOK FOR ANOTHER MIND'S EVENT (deliveries.ts `otherMindEvent`): an event on
 *  `/cloud` of iterate's context (`enrolmentOf`) that the mind iterate.iterate.com signed. Any other returns before anything
 *  is read. It never throws: a failure is one log line, and the card keeps its state. */
export async function onboardingMindEvent(itx: OnboardingItx, event: MindEvent) {
  await stepMindEvent(() => stepContext(itx), event);
}

/** That hook's work, with the steps' context made only for an event it takes: a check, the step's
 *  own reaction, then a check. */
export async function stepMindEvent(contextOf: () => Promise<StepContext>, event: MindEvent) {
  if (!enrolmentOf(event)) return;
  try {
    const context = await contextOf();
    const cause = `${event.path}@${event.offset}`;
    for (const step of STEPS) {
      if (!step.onMindEvent || !step.offered(context)) continue;
      const state = await refresh(context, step, await readState(context.itx), cause);
      await step.onMindEvent(
        context,
        event,
        state.steps[step.id] || blank(),
        logOf(context, step, state),
      );
      await refresh(context, step, await readState(context.itx), `after:${cause}`);
    }
  } catch (error) {
    console.warn({
      event: "onboarding.mind-event-failed",
      type: event.type,
      offset: event.offset,
      error: String(error),
    });
  }
}

/** iterate.iterate.com's own event on `/cloud` of its context, as cloud-deliveries.ts `cloudDeliveryOf`
 *  tests a delivery in the mind form: the signer is the mind, by its id, and the path is its
 *  `/cloud` in either form (`iterateContextOf`). */
export function enrolmentOf(event: MindEvent): boolean {
  return iterateContextOf(event.path) === "/cloud" && signedByIterate(event);
}

/** The hook's work, for each step that hears the event: its own reaction, then a check. */
export async function stepEvent(context: StepContext, event: MindEvent) {
  for (const step of STEPS) {
    if (!step.hears(event) || !step.offered(context)) continue;
    const state = await readState(context.itx);
    await step.onEvent(
      context,
      event,
      state.steps[step.id] || blank(),
      logOf(context, step, state),
    );
    await refresh(context, step, await readState(context.itx), `${event.path}@${event.offset}`);
  }
}
