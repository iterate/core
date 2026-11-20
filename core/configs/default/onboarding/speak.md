# Talking to the mind

The owner should come away with: they can talk to their mind in a browser today, with nothing to
turn on, and they know what is not ready.

## Ready today

- In the browser, in a call on any agent. In the agent's chat in the Dash
  (`https://dash.<zone>/agents?contextPath=<path>`), "Start a call" opens it; others can join, with a
  camera and a screen, and a guest by a share link (`apps.md`, "A call on an agent").
- In the call, a member adds the voice agent: a live model that everyone hears and talks to. It
  never joins by itself. It leaves when its host leaves, when a member sends it away, or after 30
  minutes.
- It is paid by `/secrets/openai`: iterate Cloud's credit, or the owner's own OpenAI key, which
  they save on the Dash's Secrets page. The Cloudflare credit does not pay for it. Without either,
  the call says so when a member adds it.

## Not ready

- By phone: not ready. A phone number is an order at a telephone provider and a setup. Name it as
  something you can set up later, when they ask.
- From a device of its own (a speaker, a watch): not ready. Say so.

## How

Ask once, when it fits. Say how in one sentence, with the link to this chat. On a "later", note
it in `mind.md` through `/agents/onboarding/mind-md`.

Check that the voice agent can be paid for:

```ts
return { key: (await itx.secrets.describe("/secrets/openai")).set };
```

## Say

- "Do you want to talk to your mind?"
- "Press 'Start a call' at the top of this chat, then 'Voice agent'. It talks back, and it
  costs a little each minute, from your iterate credit or your own OpenAI key."
