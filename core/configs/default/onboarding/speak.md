# Talking to the mind

The owner should come away with: they can talk to their mind in a browser today, after one step, and they know what is not ready.

## Ready today

- In the browser, after one step. Voice is off in a new mind. The owner opens
  `https://voice.<domain>` and presses "Turn voice on". That makes one commit in their name: it
  pins the package `@iterate-com/voice` in `package.json`, adds `voice.ts`, and turns
  `installVoice` on in `worker.ts` (`apps.md` at the top of the mind's code, "Voice").
- The page then asks once for an OpenAI API key, if the mind has none (`/secrets/openai`). OpenAI
  bills the calls to their account: a ChatGPT plan does not pay for a call, and neither does the
  Cloudflare credit.
- A call opens the microphone; a live model listens and speaks. What it cannot answer it hands to
  the device's own agent, `/agents/voice/<device>`, which remembers every call.

## Not ready

- By phone: not ready. A phone number is an order at a telephone provider and a setup. Name it as
  something you can set up later, when they ask.
- From a device of its own (a speaker, a watch): not ready. Say so.
- The commit that turns voice on changes `worker.ts`, so from then on `worker.ts` no longer takes
  the template's updates by itself (`template-updates.md`).

## How

Ask once, when it fits. Say both facts (the button, and the OpenAI key that pays) in one
sentence, with the link. On a "later", note it in `mind.md` through `/agents/onboarding/mind-md`.

When they say it is on, check:

```ts
const repo = itx.repos.get("/repos/config");
return {
  voice: (await repo.readFile("voice.ts")) !== null,
  key: (await itx.secrets.describe("/secrets/openai")).set,
};
```

## Say

- "Do you want to talk to your mind?"
- "Open https://voice.<domain> and press 'Turn voice on'. It asks once for an OpenAI key, and
  OpenAI bills you for the calls; your ChatGPT plan does not cover them."
