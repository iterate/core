---
status: in-progress
tags: [onboarding, first-sitting]
priority: high
agent: /agents/onboarding/research
---

# Look up the owner and note public context in mind.md

The owner should come away with: the mind already knows a little about them, and offers it lightly as a guess.

## Started automatically

The mind's own code starts `/agents/onboarding/research` in the background the moment onboarding begins (at iterate Cloud handover or when the owner first opens `/agents/onboarding`).

## How

Follow `onboarding/research.md`:

- Find the owner's email from the sign-up record or `/agents/onboarding` events, and take their name and non-freemail domain.
- Run at most 3 web searches (`itx.ai.websearch`) and read at most 2 public pages (`itx.browser.quickAction("markdown", { url })`).
- Keep only harmless public work facts (company, role, project, city). Nothing private.
- Append at most 8 lines to `mind.md` under `## What a web search found (may be wrong)` with source URLs, in one commit.
- Update this task's `status:` to `done` and report one plain sentence to `/agents/onboarding`: `"I looked you up on the web and noted a few public things."`
