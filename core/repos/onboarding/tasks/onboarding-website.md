---
status: in-progress
tags: [onboarding, first-sitting]
priority: high
agent: /agents/onboarding/website
---

# Build a first public homepage at your domain

The owner should come away with: the mind made them something real at their own address before they asked, and changes it on their word.

## Started automatically

The mind's own code starts `/agents/onboarding/website` in the background the moment onboarding begins (at iterate Cloud handover or when the owner first opens `/agents/onboarding`).

## How

Follow `onboarding/website.md`:

- Build one clean public homepage in `homepage.ts` (inline CSS, no external assets or private details from sign-up), and change no other file: `worker.ts` and `website.ts` (`/me` and the profile's answers) stay. On a mind whose `worker.ts` already calls a `site.ts`, change `site.ts` instead.
- Commit with a message starting with `Website:`, wait for `events.iterate.com/mind/worker-updated`, and verify `https://<zone>/` returns `200` with no sign-in.
- Take a screenshot with `itx.browser.quickAction("screenshot", { url })`, save it to `/agents/onboarding/screenshots/website.png`, and send `/agents/onboarding` the link and screenshot URL.
- Update this task's `status:` to `done`. Every later edit to the website goes back to `/agents/onboarding/website`.
