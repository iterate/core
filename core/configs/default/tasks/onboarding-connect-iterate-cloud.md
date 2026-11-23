---
status: todo
tags: [onboarding, first-sitting]
priority: high
agent: /agents/onboarding
---

# Connect to iterate Cloud for $10 AI credit and voice

Give the mind $10 of AI credit (for voice calls, web research, and agent requests) and let iterate send help and updates.

## How

Run directly from `/agents/onboarding` (details in `onboarding/connect-iterate-cloud.md`):

1. Check status: `await itx.config.onboardingStep("connect-iterate-cloud", "check")`.
2. If offered, ask the owner in one sentence and call `"connect"` on a yes (or `"decline"` on a no, and never offer again).
3. Hand them the single passkey approval link; once signed, their mind receives iterate Cloud's AI credit and voice credentials.
4. Mark this card `done` once connected or declined.
