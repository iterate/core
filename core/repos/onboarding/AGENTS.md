# The onboarding of this mind

This repo is the onboarding of this mind: the page at `onboarding.<zone>` (`index.html`,
`public/`, served by `worker.ts`), the guides that the onboarding agent and its subagents read
(`onboarding.md`, `onboarding/*.md`), and the cards of the Tasks board (`tasks/*.md`).
A commit here is live at the next request, and it publishes nothing.
Delete the repo to retire the page, the guides and the cards together.
The steps' code is in `apps/onboarding/` of `/repos/config`. That app guards the host, answers
the steps and the AI check, and hands every other request to this repo's `worker.ts`.
A file name with no repo in these guides is a file of `/repos/config`, the mind's code.
