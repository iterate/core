# Letting iterate in

The owner should come away knowing that iterate can send their mind help and updates, and can read nothing in it.

## Ready today

All of it, on a mind that names an iterate Cloud.

## How

Only when the handover holds a block that starts with "Meld with iterate:", or when
`await itx.secrets.cloud()` answers a Cloud (not `null`). With neither, do not mention this subject.

iterate, the company that made this mind, asks to be able to send it messages: help, updates and
answers after onboarding. It is the owner's choice, and the first thing they sign in their mind.

1. **Ask in one sentence, and give no link yet.** For example: "May iterate, the company that
   made this mind, send it messages with help and updates, without being able to read anything
   here, if you allow it with your passkey?" Ask it early in the first sitting, when the first moment has landed.
   On a no, drop it and go on: they can ask you for it later.
2. **On a yes, or when the owner asks what it is, say what it is in ONE sentence**, and give the
   link in the SAME message (point 3): when a person asks for a thing, give it; do not ask
   whether they would like it.
   "It lets iterate.com add events to one place in your mind, `/minds/iterate.com/`, and
   nothing else: it cannot read anything here." Say more only when the owner asks: the mind
   stores what iterate.com sends and acts on none of it; the owner ends it at any time at
   `https://iterate.<domain>/minds`.
3. **Give ONE link**: the `signAt` of this call (`minds.md`), made in the turn that gives it:
   ```ts
   const { signAt } = await itx.approvals.proposeStatement({
     path: "/minds/iterate.com",
     type: "events.iterate.com/mind-meld/configured",
     payload: { append: ["/minds/iterate.com/"] },
     next: "https://dash.<domain>/?agent=/agents/onboarding",
   });
   ```
   `next`, with this mind's own domain, brings the owner back here after they sign. The page is
   their own mind's: it shows what they allow, and they sign it with their passkey. Do not say
   what its button is called. Give no other link in that message, and no link to this chat. Do NOT ask the owner to tell you when they have signed, and end your turn: do
   not check in the turn that gives the link.
4. **The mind tells you when it is done.** The signed rule lands on `/minds/iterate.com`, and
   `worker.ts` then puts a note into this chat that starts your turn: "The owner has let
   iterate.com in." When it arrives, say in one sentence that iterate can now send messages here,
   and go on with the next subject in the same message. If the owner writes first and no note has
   come, check it yourself:
   `await itx.cd("/minds/iterate.com").waitForEvent({ type: "events.iterate.com/mind-meld/configured", afterOffset: 0, timeoutMs: 15000 })`.
   When it times out, it is not done: say so, do not claim that it worked, and ask whether the
   page showed an error.
5. **What iterate then says** arrives as events, each as itself, on the contexts under
   `/minds/iterate.com/`. They wake no agent. Read them when the owner asks what iterate said.
