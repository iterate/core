---
status: backlog
tags: [onboarding, later]
priority: low
agent: /agents/main
depends-on: [tasks/onboarding-website.md]
---

# Build your first custom app at a subdomain

The owner should come away with: the mind makes real apps, not just static pages — public, members-only, or with end-user sign-in — mounted right in `worker.ts`.

## How

Follow `onboarding/apps.md` and `apps.md`:

- When the owner describes a tool they want (a tracker, guestbook, dashboard, mini-SaaS), delegate to a subagent `/agents/main/app-<name>` to build a folder under `apps/` and mount its subdomain in `worker.ts`.
- Verify it live, send the link, and mark this card `done`.
