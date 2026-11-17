# Following up by mail

The owner should come away with: the mind writes to them with news, and an answer by mail goes on with the same conversation.

## Ready today

- A schedule on your own place wakes you later: `itx.cd("/agents/onboarding").schedules.set({ key,
when, events })`, where `when` is `{ afterMs }` or `{ at: "<ISO time with offset>" }`. A key set
  again replaces the one before: never more than one reminder. Mail: `onboarding/mail.md`.

## How

The rules:

- The first mail about three hours after the owner's last word. The second the next morning,
  their time (from what they said or the research; else about 18 hours after the first). After
  those two, write only when you have news.
- Each mail leads with something the mind did or found since, ends with ONE next step, and
  carries the chat's address (`onboarding/links.md`). Never "you have not finished".
- "stop" ends it for good: cancel it, have `/agents/onboarding/mind-md` write "No follow-up
  mails: the owner said stop" into `mind.md`, and never set it again.

In every turn that a message of the owner started while onboarding is not finished, set it again,
and say nothing about it:

```ts
await itx.cd("/agents/onboarding").schedules.set({
  key: "onboarding-reminder",
  when: { afterMs: 3 * 60 * 60_000 },
  events: [
    {
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "developer",
        content: "The onboarding reminder is due: mail 1 of 2 (onboarding/follow-up.md).",
      },
    },
  ],
});
```

When it wakes you, send ONE short mail, then set the same key once more for the next morning,
`when: { at: "2026-11-18T08:30:00+01:00" }` (their time), with "mail 2 of 2" in its words. After
the second, set none: write again only with news.

```ts
await itx.email.send({
  from: "onboarding@<domain>",
  to: "<the owner's email>",
  subject: "<the news, in a few words>",
  text,
});
```

Cancel it when the owner says stop, and when onboarding is finished (`onboarding/finish.md`):
`await itx.cd("/agents/onboarding").schedules.cancel("onboarding-reminder")`. Any other message
(a question, a wish) does not cancel it: answer, go on, set it again. Their answer by mail
continues this conversation, in the same thread (`onboarding/mail.md`). A mail's word is never
enough for anything they sign with their passkey: send the link.

## Say

A mail:

> Subject: Your website has your opening hours now
>
> I added them from your note this morning: https://<domain>/. Next: shall I take orders by mail
> too? Just reply.
>
> Our chat: https://dash.<domain>/?agent=/agents/onboarding
