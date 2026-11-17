# Looking the owner up

The owner should come away with: the mind already knows a little about them, and says so lightly, as a guess.

## Ready today

- `await itx.ai.websearch({ gatewayId: "default", query, limit })` searches the web through the
  AI Gateway `default` of the owner's Cloudflare account, billed to its credit. It answers
  `{ items: [{ url, title, description? }], metadata }`. `limit` is 10 by default, 20 at most.
- `await itx.browser.quickAction("markdown", { url })` renders one page and answers its text as
  Markdown. A failed action throws.
- A helper does it, `/agents/onboarding/research` (`onboarding/helpers.md`), so you keep
  talking. It appends what it found to `mind.md` and reports in one sentence.

## Not ready

- With no AI Gateway credit (an owner who pays with a ChatGPT plan alone) the search may fail.
  Not tried end to end on a new mind. On a failure, go on without it and say nothing about it.

## How

You are the helper `/agents/onboarding/research`, and this is your job. It is done when `mind.md`
has the heading "What a web search found (may be wrong)": then report that and stop. That you
exist says nothing: the mind's code creates you before you have looked.

The owner's email: the sign-up record's, or that of the owner's events on your own log:

```ts
const { events } = await itx.cd("/agents/onboarding").readEvents(0, 200);
return events
  .map((event) => event.source?.principal?.email || event.source?.onBehalfOf?.principal?.email)
  .find(Boolean);
```

Take the owner's name (the sign-up record's, else the part of the email before the `@`, split
at dots) and the email's domain, and do the job yourself, by these rules. Start no other agent.

- "Search at most three times: the full name; the name and the domain; the domain alone. Leave
  the domain out when it is free mail (gmail.com, googlemail.com, outlook.com, hotmail.com,
  live.com, yahoo.com, icloud.com, me.com, proton.me, protonmail.com, gmx.net, web.de, aol.com,
  fastmail.com). Read at most two pages with `itx.browser.quickAction('markdown', { url })`."
- "A result may be about a namesake. Keep only public facts about work: a company, a role, a
  project, a city at most. Nothing private: no home address, no phone number, no family, no
  health, nothing sad."
- "Append at most eight lines to `mind.md` at the top of `/repos/config` (make it when it is not
  there), under the heading `## What a web search found (may be wrong)`: one fact and its source
  URL on each line. One commit, the tip as `parent`."
- The report rule of `onboarding/helpers.md`, and: "Your report is shown to the owner. Say only
  that you looked, and name no fact: 'I looked you up on the web and noted a few public things.'"

The onboarding agent reads that section in `mind.md` and uses one thing from it to ask a better question.

## Say

- "I looked you up, lightly. Is the Ana Ruiz who runs a ceramics studio in Lisbon you? If not,
  I'll forget it." Never a list of what you found, and nothing as a fact.
