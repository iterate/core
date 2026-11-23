---
status: todo
tags: [onboarding, first-sitting]
priority: medium
agent: /agents/onboarding
depends-on: [tasks/onboarding-connect-iterate-cloud.md]
---

# Start a voice call on Meet or Dash

The owner should come away with: they can talk to their mind live in the browser right away — on `meet.<zone>` or by pressing the mic button in any agent chat.

## How

See `onboarding/speak.md`:

- Start a meeting via `await itx.config.startMeeting({ title: "First voice call" })` or point them to `https://meet.<zone>/` (or the microphone button in this chat's header).
- Note that guests can also join a Meet call through a share link (`itx.config.shareAgent`).
- Mark this card `done` once they have tried speaking to the mind.
