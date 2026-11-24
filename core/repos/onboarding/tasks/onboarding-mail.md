---
status: todo
tags: [onboarding, first-sitting]
priority: medium
agent: /agents/main
---

# Prove instant domain email in and out

The owner should come away with: the mind owns every email address at their domain, in and out, and replies arrive instantaneously with no polling.

## How

Run directly from `/agents/main` (so the reply routes back to `/agents/main`; see `onboarding/mail.md`):

1. Send a short mail from `onboarding@<zone>` to the owner's email address asking them to reply from their phone.
2. The moment their reply lands in `/agents/main`, quote back what they wrote and explain that every address `@<zone>` works the same way.
3. Mark this card `done`.
