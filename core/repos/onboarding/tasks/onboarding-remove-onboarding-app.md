---
status: todo
tags: [onboarding, first-sitting]
priority: low
agent: /agents/main
depends-on:
  - tasks/onboarding-look.md
  - tasks/onboarding-website.md
  - tasks/onboarding-mail.md
  - tasks/onboarding-secrets-and-approvals.md
  - tasks/onboarding-telemetry.md
---

# Remove the onboarding app

The owner should come away with: even the onboarding wizard itself is just files of their mind, and they can delete it once setup is done.

## How

Once the owner is ready to clean up onboarding (with their go-ahead):

1. Delete the repo `/repos/onboarding` (`await itx.repos.delete("/repos/onboarding")`): the page, the guides and these cards go with it. Mark this card `done` first, since it goes too.
2. Remove the `apps/onboarding/` folder from `/repos/config`, and what imports it: in `worker.ts`, the `onboardingApp` import, `const onboarding` and the `case "onboarding":` route; in `every-event.ts`, the `onboardingEvent` hook and its import; in `deliveries.ts`, the `onboardingMindEvent` call and the `enrolmentOf` test, with their import; in `api.ts`, the `onboardingStep` method and the `runStep` / `stepContext` import (and `connectWaitsForRule` from `cloud-handover.ts` if still referenced).
3. Point the Tasks board at another repo, or remove it: `const tasks = tasksApp(…)` in `worker.ts` of `/repos/config` names `/repos/onboarding`.
4. Remove the `Onboarding` entry from `apps/dash/public/app.js` and the "Continue setup" link from the default homepage if still present.
5. Commit to `/repos/config`, wait for `events.iterate.com/mind/worker-updated`, and verify `https://dash.<zone>/` still loads cleanly.
