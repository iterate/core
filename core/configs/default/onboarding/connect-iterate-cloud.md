# Connecting to iterate Cloud

The onboarding agent's part 5 (`onboarding.md`) holds the short form of this file; a helper asked
about the step reads this one.

The owner should come away knowing what iterate gives (credit for AI), what iterate then sees,
and that it was their choice.

## Ready today

The step is open on every mind but iterate Cloud's own (`CREDIT_OPEN` in
`apps/onboarding/steps/connect-iterate-cloud.ts`). If it is closed again, the tool answers that
the mind has no such step: then ask the "let iterate in" question and do not name the credit.
The credit itself works only on a mind whose platform code signs requests as the mind and keeps
a secret by proxy: the tool's `status` says `unavailable` on any other, and then the card shows
the update command. The `status` is `own-keys` when both `/secrets/openai` and `/secrets/exa` hold
the owner's own keys: the credit would pay for nothing. On either, do not offer the credit or
name it: ask the "let iterate in" question instead (`let-iterate-in.md`).

## What it is

The first card of the onboarding app (`https://onboarding.<zone>/`, apps/onboarding/). iterate,
the company that made this mind, gives it $10 of credit for OpenAI and Exa. The owner allows it
with ONE passkey press: the rule that lets iterate add messages under `/minds/iterate.iterate.com/`
(the same rule as `let-iterate-in.md`). When the signed rule lands, the mind asks iterate Cloud
for the grant and makes `/secrets/openai` and `/secrets/exa` secrets by iterate's proxy, where no
key of the owner's is set. The owner's own key is never replaced.

Who pays: before the connect, the mind's agents already work, paid by the owner's own Cloudflare
account (its AI Gateway credit, the last of the agents' keys in `agents.ts`). After it, each agent
request goes to iterate's credit first, and voice calls and web research work. When the credit is
spent, the step deletes its two secrets by iterate's proxy (the rule stays), so the mind's requests
no longer go to iterate: the agents go on with the owner's ChatGPT plan if they connected one, else
with their Cloudflare account, and voice calls and web research stop until the owner sets a key of
their own. The card, one message in this chat and one mail say so once. A balance under zero is
not yet spent while iterate still counts an interrupted request (up to 15 minutes): the card says
so, and nothing is deleted.

What iterate then sees: the mind's requests to OpenAI and Exa, and their answers, as they pass.
It stores the numbers (which model, how much, the cost), not the content. The requests are made on
iterate's accounts at OpenAI and Exa. iterate's proxy refuses a request that asks OpenAI to store
it (below). OpenAI and Exa still keep what their own policies keep, such as abuse logs, and OpenAI
keeps the working files of a code tool it runs for up to 20 idle minutes. The rule lets iterate add events under one path of the mind, and read nothing in it.

## Storage at OpenAI is off

iterate does not want its OpenAI account to store other minds' customer data. So a request to
OpenAI through the credit must keep storage off, and iterate's proxy refuses one that does not,
with a 400 whose message says what to change. Nothing is sent to OpenAI and nothing is charged.

- **The Responses API: send `"store": false`.** The mind's own agents and the Codex CLI already
  do. An owner's own script, or OpenAI's SDK with its defaults, gets the code
  `iterate_credit_store_not_off`. For a reasoning model, also send
  `"include": ["reasoning.encrypted_content"]` and send the reasoning items back.
- **Name nothing stored at OpenAI.** Nothing of the mind is stored there, so a request may not
  name `previous_response_id` over HTTP, `conversation`, an `item_reference`, a stored `prompt`,
  a file id, a vector store, a container's files or a container given by its id (send
  `"container": { "type": "auto" }`). It gets the code
  `iterate_credit_nothing_stored`, with the field and what to send instead (for example the
  conversation's items again in `input`). On the Responses WebSocket, a `previous_response_id`
  from an answer of the same socket works.
- **A voice session must not turn storage on** (`store: true` in `session.start`).
- **With the owner's own OpenAI key** (`add-openai-key`) none of this applies: the request goes
  straight to OpenAI.

Such a refusal is no spent credit: the card does not change. Fix the request and send it again.

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

1. **Call `check` first, then ask once, early in the first sitting.** On `unavailable` or `own-keys`, ask the
   "let iterate in" question as before and do not name the credit. On any other status, ask in
   place of it: "iterate gives your mind $10 of credit for AI: voice calls, web research, and
   your agents' requests, which your Cloudflare credit pays for today. Want it?" A no is `decline`: note it in `mind.md`, and do not offer it again.
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
