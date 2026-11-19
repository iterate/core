# Connecting to iterate Cloud

The onboarding agent's part 5 (`onboarding.md`) holds the short form of this file; a helper asked
about the step reads this one.

The owner should come away knowing what iterate gives (credit for AI), what iterate then sees,
and that it was their choice.

## Ready today

The step is closed on every mind until iterate Cloud's side is live (`CREDIT_OPEN` in
`apps/onboarding/steps/connect-iterate-cloud.ts`): no card shows, and the tool answers that the
mind has no such step; then ask the "let iterate in" question and do not name the credit. Once
it is open: the card and the tool. The credit itself works only on a mind whose platform code signs requests
as the mind and keeps a secret by proxy: the tool's `status` says `unavailable` on any other, and
then the card shows the update command. There, do not offer the credit or name it: ask the "let
iterate in" question instead (`let-iterate-in.md`).

## What it is

The first card of the onboarding app (`https://onboarding.<zone>/`, apps/onboarding/). iterate,
the company that made this mind, gives it $10 of credit for OpenAI and Exa. The owner allows it
with ONE passkey press: the rule that lets iterate add messages under `/minds/iterate.iterate.com/`
(the same rule as `let-iterate-in.md`). When the signed rule lands, the mind asks iterate Cloud
for the grant and makes `/secrets/openai` and `/secrets/exa` secrets by iterate's proxy, where no
key of the owner's is set. The owner's own key is never replaced.

What iterate then sees: the mind's requests to OpenAI and Exa, and their answers, as they pass.
It stores the numbers (which model, how much, the cost), not the content. The requests are made on
iterate's accounts at OpenAI and Exa, and those providers keep them as they keep any request.
The rule lets iterate add events under one path of the mind, and read nothing in it.

## How

Every button of the card is also your tool, the same call:

```ts
await itx.config.onboardingStep("connect-iterate-cloud", action);
// → { status, words, link? }
```

| The owner says                                          | `action`         |
| ------------------------------------------------------- | ---------------- |
| "connect me to iterate Cloud", "can I get that credit?" | `connect`        |
| "not now", "no thanks"                                  | `decline`        |
| "what is my balance?", "is it connected?"               | `check`          |
| "disconnect", "stop using iterate's credit"             | `disconnect`     |
| "add my own OpenAI key"                                 | `add-openai-key` |

1. **Call `check` first, then ask once, early in the first sitting.** On `unavailable`, ask the
   "let iterate in" question as before and do not name the credit. On any other status, ask in
   place of it: "iterate gives your mind $10 of credit for AI, so agents and voice calls work at
   once. Want it?" A no is `decline`: note it in `mind.md`, and do not offer it again.
2. **On a yes, call `connect`** and say two sentences: the $10, and that requests to OpenAI and
   Exa then pass through iterate, which stores the numbers alone. Give the ONE `link` of the
   answer, and nothing else in that message: it is the owner's own page for their passkey. Do not
   ask them to tell you when they signed, and end your turn.
3. **The mind tells you when it is done**: a note starts your turn with the balance. Say it in
   one sentence and go on. A `status` of `failed` comes with its words: say them.
4. **When the credit is used**, the card, one message in this chat and one mail name the ways to
   pay (`pays.md`). It is the one time you name this credit again, as one of the ways, to an
   owner who said no before.

Never call `itx.secrets.set` for these two paths yourself, and never delete a secret by proxy
yourself: the tool keeps the card true.

`disconnect` needs no passkey: it deletes the two secrets by iterate's proxy at once, and any
agent of the mind can call it. Call it on the owner's own word alone. Its link ends the rule too,
with the owner's passkey. A later `connect` gets the balance that is left: the grant is once.

## Say

- "Done: iterate's credit pays from now on. $10 left."
- "Your own OpenAI key stays in use. The credit pays for web research."
