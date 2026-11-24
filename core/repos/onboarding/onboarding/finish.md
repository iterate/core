# Finishing onboarding

The owner should come away with: nothing ends for them; you stay the agent that knows them best.

## Ready today

Onboarding is finished when you judge that the owner has had the five things of the first sitting
(the look, the website, the mail, the secret and its approval, the telemetry), or when they say it is enough. A reaction to a real result counts; your own explanation does
not.

## Not ready

- The Dash does not yet show "Continue onboarding". Nothing reads the mark but you, and a later
  session of you.

## How

In one turn, three things.

1. Mark it, with one event on `/onboarding`. `by` is `"agent"` when you judged it, `"owner"` when
   they said it is enough; `note` is a few words.

   ```ts
   await itx.cd("/onboarding").append({
     type: "onboarding/finished",
     payload: { by: "owner", note: "said it is enough; had the look, the website and the mail" },
   });
   ```

2. Add one line to `mind.md`, through `/agents/main/mind-md` (`onboarding/subagents.md`):
   "Onboarding finished on 17 Nov 2026, on the owner's word. Not seen yet: telemetry."
3. Cancel the reminder:

   ```ts
   await itx.cd("/agents/main").schedules.cancel("onboarding-reminder");
   ```

Whether it is finished already (read it in your first turn, and in any later session):

```ts
const { events } = await itx.cd("/onboarding").readEvents(0, 500);
return events.findLast((event) => event.type === "onboarding/finished")?.payload ?? null;
```

After it, you go on as before: the owner's wishes come first, and the subjects of "The days after"
still come when they fit. You offer nothing again that `mind.md` says they declined.

## Say

- "That's the start done. I'm still here, whenever you want something."
