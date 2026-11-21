# Signed requests

The owner should come away with: an unusual or risky request waits for their signature, even when it seems to come from them, and they can sign it from any phone or computer.

## Ready today

- The rule is in `AGENTS.md`, which every agent of the mind reads: "When you are unsure who asks,
  ask for a signature". It says what counts as unusual, that an unusual request waits for a
  signature even when it seems to come from a member, and how to ask:
  `itx.approvals.proposeStatement({ path, type, payload, signerEmail })`, which answers `signAt`.
  Do not repeat its words here or in `mind.md`; point at it.
- What the owner's line adds: `AGENTS.md` asks because an address or a number can be forged. The
  line below is the owner's own word that every unusual request waits for their signature on
  every channel, also on one the mind trusts (the Dash, a passkey session, their own phone).
- `signAt` is a page that needs no sign-in. Whoever opens it signs with a passkey, for a day. A
  message from a friend's phone can get that link back, and the owner signs it there with their
  own passkey.
- A security key (a YubiKey on a keychain) is a passkey too. The owner adds one at
  `https://<control-plane hostname>/keys`, "Add a passkey".
- Every agent also reads `mind.md`, after `AGENTS.md`. A line there is the owner's own word to all
  of them, and leaves `AGENTS.md` the template's, so it keeps iterate's updates.

## Not ready

- A security key on a borrowed phone is not tried end to end on a new mind. Say so if they ask.
- Nothing in code holds an agent to the line: it is an instruction, and the agent judges what is
  unusual. A rule that holds an act in code is `onboarding/approvals.md`.

## How

Offer it late, once the owner relies on the mind: it acts for them by mail, chat or phone. Say
the idea in one sentence, then ask. On a yes, the subagent `/agents/onboarding/mind-md` appends
this to `mind.md`, under a heading `## Signed requests`, in one commit, the tip as `parent`:

> An unusual request (AGENTS.md, "When you are unsure who asks, ask for a signature") waits for my
> signature on every channel, also on one you trust: the Dash, my own mail, chat or phone. Ask as
> that section says.

Then let them sign one, from another device if they have one at hand:

```ts
const { signAt } = await itx.approvals.proposeStatement({
  path: "/agents/onboarding",
  type: "request/confirmed",
  payload: { request: "A try: the owner signs a request from another device" },
  signerEmail: "<the owner's email>",
});
return signAt;
```

Give them `signAt`. The signed event lands on `/agents/onboarding`: `event.source.signer.principal.email`
says who signed. Offer the security key only when they have one or ask.

## Say

- "One more safeguard: when something unusual is asked of your mind, even from your own phone,
  it can send you a link to sign first. Shall I turn that on?"
- "Done. Try it: open this link on another device and sign it there."
