// context-birth-events.ts — pure, so what runs before a build (cloudflare.config.ts, which sets it
// as `ITERATE__CONTEXT_BIRTH_EVENTS`) and the tests import it as they are.

/** THE EVENTS EVERY PROJECT CONTEXT IS BORN WITH, in every deployment (a change reaches the contexts
 *  born after it): two rows from the context's birth on, both spelled at the fixed point
 *  (`itx.builtins`) so no rule of the context's own can mask or re-point them.
 *
 *  `config` delivers every durable event to the project's published config entrypoint, `itx.config`
 *  on `/` (./publication.ts), and passes over what is committed while none is published. It is a
 *  FAN-OUT row: that is the project's own code, which fails event by event (a bug for one input),
 *  so each event is retried and dead-lettered alone and one bad event never holds the rest back.
 *
 *  `platform` delivers to the platform's own hook (../platform-hook.ts), in batches. It is an
 *  ORDERED row: the hook is our code and only reshapes events into rows, so what fails it is its
 *  destination (a Basin Pipelines stream down or gone), which fails every event alike; holding the
 *  rest back costs nothing then, and the row's durable cursor loses nothing to a context reset. Its
 *  ladder is the long one (subscription-delivery.ts `#ladder`): an outage of hours waits in the log.
 *  A send in flight holds back no other cursor row: the cursor-read budget keeps room for small
 *  batches beside a read (subscription-delivery.ts CURSOR_READ_BUDGET_CHARS). */
export const PROJECT_CONTEXT_BIRTH_EVENTS = [
  {
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "config",
      target: "itx.builtins.cd('/').config.deliverEvent",
      afterOffset: 0,
      ordered: false,
    },
  },
  {
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "platform",
      target: "itx.builtins.platformHook.deliverEvents",
      afterOffset: 0,
    },
  },
] as const;
