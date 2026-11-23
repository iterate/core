# What pays for the agents

The owner should come away with: they know what pays for their mind's thinking, and they chose it.

## Ready today

You answer, so something pays now. An agent uses the first of these that is set (`defaultConfig`):

1. a ChatGPT plan, the secret `/secrets/chatgpt`;
2. an OpenAI API key, `/secrets/openai`;
3. the prepaid AI Gateway credit in the owner's Cloudflare account.

`(await itx.secrets.describe(path)).set` says whether a secret is set.

## Not ready

- The voice agent in a call is paid by `/secrets/openai` alone: iterate Cloud's credit or the
  owner's own key, never the Cloudflare credit (`onboarding/speak.md`).

## How

Bring it up only when a request fails for lack of credit (a subagent reports it, or your own
script's answer says 402 or "insufficient"), or when the owner asks. Then say so plainly, and
give the three ways at once:

1. **Their ChatGPT plan: recommend this.** The agents' requests then use their ChatGPT Plus or
   Pro plan: no API key, no extra bill. They run one command on their own computer. Give it with
   this mind's control-plane hostname in it, in a code block of its own:

   ```sh
   npx iterate@latest chatgpt connect <control-plane hostname>
   ```

   It opens ChatGPT in their browser, and the plan's tokens land in this mind: nothing is pasted
   anywhere. It is for a mind that one person uses: the plan pays for that person's own requests
   only. Ask them to say when the browser says it is connected. Then
   `await itx.secrets.describe("/secrets/chatgpt")` must say it is set: say so, and that the plan
   pays from the next request on.

2. **Or Cloudflare credit.** Offer this when they have no plan, do not want to use it, or more
   people use the mind: prepaid AI Gateway credit in their own Cloudflare account, which
   Cloudflare bills to their card. They add it at
   `https://dash.cloudflare.com/?to=/:account/ai/ai-gateway`. Nothing else to set up: the agents
   use it when no plan and no key is set.
3. **Or an OpenAI API key**, billed to their OpenAI API account. Never ask for it in this chat:
   give them the mind's form (`onboarding/secrets.md`):

   ```ts
   const { url } = await itx.secrets.collectFromUser({
     path: "/secrets/openai",
     egress: { urls: ["https://api.openai.com"] },
     description: "An OpenAI API key, from https://platform.openai.com/api-keys",
   });
   ```

Say which of the three is in use when you are done.

## Say

- "Your mind has run out of credit. The easiest fix is your ChatGPT plan: one command on your
  computer. Shall I give it to you?"
- "Done: your ChatGPT plan pays from the next request on."
