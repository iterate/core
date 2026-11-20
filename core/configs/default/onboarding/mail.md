# Mail

The owner should come away with: every address at their domain is the mind's, in and out, and their answer reached the mind the moment they sent it.

## Ready today

- `itx.email.send({ from, to, subject, text })` sends from any address at one of the mind's zones:
  `onboarding@<zone>` works. `from` is required: a send without it is refused, and so is an
  address at another domain.
- Every address at a zone of the mind receives: the stack takes each zone's catch-all mail rule. Each
  mail in is an `events.iterate.com/email/received` event on `/integrations/email`, pushed as it
  arrives. Nothing polls.
- A reply in the thread of a mail you sent comes back to YOU (`mail-replies.md`), as the owner's
  message in this chat: "Email from <address>: <subject>", the text, and the call to answer with.
  It is the owner's word only when it came straight from the address they sign in with; an
  outside person's answer comes marked as theirs.
- Answer in the same thread with `inReplyToOffset`, and `from` as in every send: the address
  their mail reached.
- A bounce or a refusal of your mail comes back to you as a note.

## Not ready

- A NEW mail to `onboarding@<zone>` (not a reply) does not reach you: it starts the thread's
  own agent, `/agents/email/t<thread>`. Ask the owner to answer your mail, not to write a new one.
- A new domain's mail may be slow, or land in spam. Ask them to look there. When nothing came,
  say plainly that mail does not reach them yet.
- A mail's word is never enough for anything the owner signs with their passkey: send the link.

## How

The onboarding agent sends these mails itself, never a helper: an answer to a mail goes back to
the agent that sent it (`mail-replies.md`), and the owner's answer must reach the conversation.
A helper reads this file only to explain mail or to build something on it.

```ts
await itx.email.send({
  from: "onboarding@<zone>",
  to: "<the owner's email>",
  subject: "Hello from your mind",
  text: [
    "This is your mind, writing from your own domain.",
    "Answer this mail from your phone, with anything, and I will tell you in the chat what you wrote.",
    "The chat: " +
      (await itx.config.dashLink({ view: "agent", contextPath: "/agents/onboarding" })),
  ].join("\n\n"),
});
```

Their answer starts your turn. Its last line names the offset to answer:

```ts
await itx.email.send({ from: "onboarding@<zone>", inReplyToOffset: <the offset>, text: "Got it." });
```

To read a mail yourself: `await itx.cd("/integrations/email").readEvents(<offset> - 1, 1)`.

## Say

- "I've just sent you a mail from onboarding@<zone>. Answer it from your phone, with anything."
- "Your answer is here: 'Testing from the train'. Every address at your domain is your mind's,
  for mail in and out."
