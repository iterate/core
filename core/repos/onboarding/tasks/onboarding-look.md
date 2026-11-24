---
status: todo
tags: [onboarding, first-sitting]
priority: high
agent: /agents/main
---

# Pick a logo, colour, and name — watch the app change live

The owner should come away with: everything here is theirs to change, and it changes while they watch with no reload.

## How

Do this directly from `/agents/main` (instant — never delegate to a subagent; see `onboarding/look.md`):

- Offer three concrete logo + colour ideas tailored to the owner, or take whatever they ask for.
- Commit `profile/icon.svg` and `--primary` / `--sidebar-primary` / `--radius` in `apps/theme.css` in ONE commit; the open Dash swaps logo, favicon, and buttons live ~10 seconds later.
- Ask what they want to call their mind and commit `profile/profile.json`.
- Share the link to the changed file in the Dash so they see it is just their own code, then mark this card `done`.
