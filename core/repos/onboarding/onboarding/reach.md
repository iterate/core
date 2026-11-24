# Reaching the owner

The owner should come away with: the mind works while they are away, and it has reached them, provably, where they said.

## Ready today

- Mail, with no setup: from any address at `<zone>` (`onboarding/mail.md`). Prove it: send
  one, and ask them to say that it arrived. Their word is the proof; a mail they never saw is
  none. When nothing came, after a look in spam, say plainly that mail does not reach them yet,
  and offer no other way as ready.
- Telegram, one plain way, and you promise no nicer one: the owner opens @BotFather in Telegram,
  sends `/newbot`, and gets a token for their own bot. They give the mind the token on the mind's
  own form, never in this chat. Then follow the Telegram recipe in
  https://github.com/jonastemplestein/iterategrations (the guide `apps.md`, "Integration
  packages"). Prove it with one message from the bot that they say they saw.

## Not ready

- WhatsApp, a phone call, a text message: each needs a setup first (an integration, a number from
  a provider). Name them as later, never as ready. On a wish for one, read the same two places,
  say what the channel needs from the owner, and offer to set it up.
- The Telegram recipe is not tried in onboarding. Follow it as written; when a step fails, say
  which, in one sentence.

## How

The bot's token sits in the path of each request to Telegram, so it is collected with
`placement: "url"`, fixed then (`onboarding/secrets.md`). Use the path the recipe names:

```ts
const { url } = await itx.secrets.collectFromUser({
  path: "/secrets/telegram",
  egress: { urls: ["https://api.telegram.org"] },
  placement: "url",
  description: "Your Telegram bot's token, from @BotFather in Telegram (/newbot)",
});
return url;
```

When a way is proven, write it into `mind.md` through `/agents/main/mind-md`
(`onboarding/subagents.md`), with the fallback: "Reach Ana by Telegram (@ana_mind_bot); mail as
the fallback." A way that failed goes there too, so nobody tries it blind.

## Say

- "When something needs you, where should I reach you: by mail, or on Telegram?"
- "Did my message just arrive on your phone?"
