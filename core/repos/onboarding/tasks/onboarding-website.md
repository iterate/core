---
status: in-progress
tags: [onboarding, first-sitting]
priority: high
agent: /agents/main/website
depends-on: [tasks/onboarding-research.md]
---

# Build a first public homepage at your domain

The owner should come away with: the mind made them something real at their own address before they asked, and changes it on their word.

## Started automatically

`/agents/main/researcher` kicks off `/agents/main/website` automatically as soon as it finishes looking up the owner and generating the mind's starter logo, passing its findings so the first page is personal rather than blank.

## How

Follow `onboarding/website.md`:

- Build one clean public homepage in `homepage.ts` (inline CSS, no external assets or private details from sign-up), and change no other file: `worker.ts` and `website.ts` (`/me` and the profile's answers) stay. On a mind whose `worker.ts` already calls a `site.ts`, change `site.ts` instead.
- Commit with a message starting with `Website:`, wait for `events.iterate.com/mind/worker-updated`, and verify `https://<zone>/` returns `200` with no sign-in.
- Take a screenshot with `itx.browser.quickAction("screenshot", { url })`, save it to `/agents/main/screenshots/website.png`, and send `/agents/main` the link and screenshot URL.
- Update this task's `status:` to `done`. Every later edit to the website goes back to `/agents/main/website`.
