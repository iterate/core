---
status: todo
tags: [onboarding, first-sitting]
priority: medium
agent: /agents/main
---

# Keep a secret the agent cannot read and gate an action with your passkey

The owner should come away with: the mind stores secrets no agent can read (sent only to the host shown on the form), and waits for a passkey signature on actions they say matter.

## How

Follow `onboarding/secrets.md` and `onboarding/approvals.md`:

1. When the first API key or token is needed, send the mind's own secret-collection link and remind them to verify the allowed host on the form.
2. Propose a harmless approval rule (e.g. `await itx.approvals.propose({ verb: "email.send", to: ["*@example.com"] })`), let them sign it with their passkey, and have a subagent attempt a held mail so they watch it pause at `/secrets/approvals`.
3. Mark this card `done`.
