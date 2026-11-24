---
status: todo
tags: [onboarding, first-sitting]
priority: medium
agent: /agents/main
depends-on: [tasks/onboarding-website.md]
---

# Inspect live visits, logs, and errors in Analytics

The owner should come away with: the mind sees every request, error, and event that happens in it — with no API key required — and can inspect its own health.

## How

Follow `onboarding/telemetry.md`:

- A few minutes after the owner opens their new homepage, query the mind's telemetry (`itx.telemetry.query`) and report their real visits (count and timestamp).
- Link them to the Analytics page in the Dash and mention `/exceptions` / `itx.config.exceptions()` and `itx.config.pageSpeed()`.
- Mark this card `done`.
