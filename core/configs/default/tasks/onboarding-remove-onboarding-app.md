---
status: todo
tags: [onboarding, first-sitting]
priority: low
agent: /agents/onboarding
depends-on:
  - tasks/onboarding-look.md
  - tasks/onboarding-website.md
  - tasks/onboarding-mail.md
  - tasks/onboarding-secrets-and-approvals.md
  - tasks/onboarding-telemetry.md
---

# Remove the onboarding app

The owner should come away with: even the onboarding wizard itself is just files in their mind's code, and they can delete it once setup is done.

## How

Once the owner is ready to clean up onboarding (with their go-ahead):

1. Remove the `apps/onboarding/` folder from `/repos/config`.
2. Remove the `onboardingApp` import, `const onboarding`, `case "onboarding":` route, `onboardingEvent` / `onboardingMindEvent` hooks, and `onboardingStep` RPC method from `worker.ts` (and `connectWaitsForRule` from `cloud-handover.ts` if still referenced).
3. Remove the `Onboarding` entry from `apps/dash/public/app.js` and the "Continue setup" link from the default homepage if still present.
4. Commit, wait for `events.iterate.com/mind/worker-updated`, verify `https://dash.<zone>/` still loads cleanly, and mark this card `done`.
