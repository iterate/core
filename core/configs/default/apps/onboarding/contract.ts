// contract.ts — THE ONBOARDING APP'S EVENTS AND ITS ONE STATE. Every step of the list (steps.ts)
// writes the same four types on one context, `/apps/onboarding`, and `reduce` folds them into one
// state: for each step, whether the owner said "not now", the action that waits, the last failure,
// and the facts its `check` last read from the truth. The page and the agent's tool draw only from
// this state. An agent that wants to know what the page shows reads this file.
//
//   onboarding/step-declined          { step }
//   onboarding/step-action-requested  { step, action, link?, expires? }
//   onboarding/step-action-settled    { step, requestOffset, outcome, reason?, words? }
//   onboarding/step-checked           { step, facts }
//
// The types are the app's own, with no `events.iterate.com/` prefix, as the docs app's are: the
// platform reads none of them (core/lib/README.md, "Event types").
//
// A request's offset names the ask; its settlement names that offset. `reduce` is pure, and an
// event it has already folded (an offset at or below the last one) changes nothing.
import { z } from "zod";

/** The one context of the app: every step's events. */
export const ONBOARDING_CONTEXT = "/apps/onboarding";

const StepName = z.string().regex(/^[a-z0-9-]{1,60}$/);

const Declined = z.object({ step: StepName });
const Requested = z.object({
  step: StepName,
  action: z.string().regex(/^[a-z-]{1,40}$/),
  /** The page where a member signs what the action needs, when it needs a signature. */
  link: z.string().url().optional(),
  /** When that page stops working (an ISO time). */
  expires: z.string().optional(),
});
const Settled = z.object({
  step: StepName,
  requestOffset: z.number().int(),
  outcome: z.enum(["succeeded", "failed"]),
  /** A failure's code: the step's own (steps/connect-iterate-cloud.ts `FAILURES`). */
  reason: z.string().optional(),
  /** A failure's words for the owner. */
  words: z.string().optional(),
});
const Checked = z.object({ step: StepName, facts: z.record(z.string(), z.unknown()) });

/** One event of the log, as `reduce` reads it. */
export type OnboardingEvent = { type: string; offset: number; payload?: unknown };

/** What one step's card is made from. */
export type StepState = {
  /** The owner said "not now", and asked nothing since. */
  declined: boolean;
  /** The action that waits for its settlement. */
  action: null | { name: string; requestOffset: number; link?: string; expires?: string };
  /** The last action failed, and nothing was asked since. */
  failure: null | { reason: string; words?: string };
  /** What the step's `check` last read, or null before its first. */
  facts: Record<string, unknown> | null;
};

export type OnboardingState = {
  steps: Record<string, StepState>;
  /** The offset of the last event folded. */
  offset: number;
};

export const initialState = (): OnboardingState => ({ steps: {}, offset: 0 });

/** THE REDUCE: one event into the state. A type it does not know, a payload of another shape and
 *  an event already folded leave the state as it was. */
export function reduce(state: OnboardingState, event: OnboardingEvent): OnboardingState {
  if (event.offset <= state.offset) return state;
  const at = { ...state, offset: event.offset };
  const step = (name: string, next: (current: StepState) => StepState) => ({
    ...at,
    steps: {
      ...at.steps,
      [name]: next(at.steps[name] || { declined: false, action: null, failure: null, facts: null }),
    },
  });
  switch (event.type) {
    case "onboarding/step-declined": {
      const parsed = Declined.safeParse(event.payload);
      if (!parsed.success) return at;
      return step(parsed.data.step, (current) => ({ ...current, declined: true }));
    }
    case "onboarding/step-action-requested": {
      const parsed = Requested.safeParse(event.payload);
      if (!parsed.success) return at;
      const { step: name, action, link, expires } = parsed.data;
      return step(name, (current) => ({
        ...current,
        declined: false,
        failure: null,
        action: { name: action, requestOffset: event.offset, link, expires },
      }));
    }
    case "onboarding/step-action-settled": {
      const parsed = Settled.safeParse(event.payload);
      if (!parsed.success) return at;
      const { step: name, requestOffset, outcome, reason, words } = parsed.data;
      // a settlement of an older ask, after a newer one was made, changes nothing
      if (at.steps[name]?.action?.requestOffset !== requestOffset) return at;
      return step(name, (current) => ({
        ...current,
        action: null,
        failure: outcome === "failed" ? { reason: reason || "failed", words } : null,
      }));
    }
    case "onboarding/step-checked": {
      const parsed = Checked.safeParse(event.payload);
      if (!parsed.success) return at;
      return step(parsed.data.step, (current) => ({ ...current, facts: parsed.data.facts }));
    }
    default:
      return at;
  }
}

/** The state after every event of a log, oldest first. */
export const reduceAll = (events: readonly OnboardingEvent[]) =>
  events.reduce(reduce, initialState());
