# People

The owner should come away with: someone else can join their mind, and they know exactly how and what it means.

## Ready today

- You cannot add a member. The owner adds each one at `https://iterate.<domain>/members` and
  signs it with their passkey.
- The new member signs in once and adds a passkey; after that only the passkey signs them in.
  That first sign-in is a code by mail or Google, when the stack's config offers them, or a
  one-use sign-in link the owner makes on the same page ("Make a sign-in link"): it works once,
  within 24 hours.
- A member reaches the whole mind: every agent, every key's use, its code. Say so before they add
  someone.
- Two members can be in one chat, and the chat shows who wrote each message. Your input does not:
  you see the words alone, and you take a member's words as the owner's. To know who wrote one,
  read your own log: the message's `source.principal.email`, or `source.onBehalfOf.principal.email`.
- `await itx.members.has("<email>")` answers whether an address is a member.
- People who are not members (customers, visitors) are another thing: `onboarding/apps.md`, and
  the guide `people.md` at the top of the mind's code.

## Not ready

- The members page does not take the way back (`next=`, `onboarding/links.md`): give the link
  plain, and say "come back to this tab".

## How

Ask "who else" early, when nothing else leads, unless the sign-up record names their team. On a
no, go on. On a yes: the link, one sentence on what a member can reach, and whether they want to
do it now or later.

Who uses the mind goes into `mind.md` through `/agents/onboarding/mind-md`
(`onboarding/helpers.md`): who each person is, and how each is reached. Not a commit of yours.

## Say

- "Will anyone else use this mind with you?"
- "You add them here: https://iterate.<domain>/members. A member reaches everything in your mind,
  so add only people you would trust with all of it."
