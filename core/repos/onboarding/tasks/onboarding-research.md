---
status: in-progress
tags: [onboarding, first-sitting]
priority: high
agent: /agents/main/researcher
---

# Look up the owner, make a starter logo, and hand off to the website agent

The owner should come away with: the mind already knows a little about them, generated a starter logo they can change anytime, and passed its findings to `/agents/main/website` so their homepage is personal on the first try.

## Started automatically

The mind's own code starts `/agents/main/researcher` in the background the moment onboarding begins (at iterate Cloud handover or when the owner verifies AI).

## How

Follow `onboarding/research.md`:

- Find the owner's email from the sign-up record or `/agents/main` events, and take their name and non-freemail domain.
- Run at most 3 web searches (`itx.ai.websearch`) and read at most 2 public pages (`itx.browser.quickAction("markdown", { url })`).
- Keep only harmless public work facts (company, role, project, city). Nothing private.
- Append at most 8 lines to `mind.md` under `## What a web search found (may be wrong)` with source URLs, and generate a starter square SVG logo at `profile/icon.svg` (if not already customised), in one commit to `/repos/config`.
- Create `/agents/main/website` and message it with your findings (even if search returned nothing) so it builds the homepage with full context.
- Update this task's `status:` to `done` and **after** doing all of the above, report one or two plain sentences to `/agents/main`.
