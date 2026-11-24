# Looking the owner up, making a starter logo, and handing off to the website agent

The owner should come away with: the mind already knows a little about them, gave itself a real starter logo they can change anytime, and passed what it learned to the website agent so their homepage is personal on the first try.

## Ready today

- `await itx.ai.websearch({ gatewayId: "default", query, limit })` searches the web through the
  AI Gateway `default` of the owner's Cloudflare account, billed to its credit. It answers
  `{ items: [{ url, title, description? }], metadata }`. `limit` is 10 by default, 20 at most.
- `await itx.browser.quickAction("markdown", { url })` renders one page and answers its text as
  Markdown. A failed action throws.
- `profile/icon.svg` at the top of `/repos/config` is the mind's square SVG logo (`viewBox="0 0 64 64"`), shown in the Dash header, tab icon, and homepage. The open Dash picks it up automatically ~6 seconds after publish.
- A subagent does this, `/agents/main/researcher` (`onboarding/subagents.md`), so `/agents/main` keeps talking.

## Not ready

- With no AI Gateway credit (an owner who pays with a ChatGPT plan alone) the search may fail.
  On a failure, still generate a starter logo and STILL kick off `/agents/main/website` so the owner gets a logo and homepage either way.

## How

You are the subagent `/agents/main/researcher`, and this is your job. Do all five steps yourself, in order, batching reads and commits cleanly so you finish quickly:

### 1. Find the owner's name & email and search lightly

Get the owner's email from the sign-up record or `/agents/main` events:

```ts
const { events } = await itx.cd("/agents/main").readEvents(0, 200);
return events
  .map((event) => event.source?.principal?.email || event.source?.onBehalfOf?.principal?.email)
  .find(Boolean);
```

Take the owner's name (the sign-up record's, else the part of the email before `@`, split at dots) and the email's domain:

- Search at most three times: the full name; the name and the domain; the domain alone. Leave the domain out when it is free mail (`gmail.com`, `googlemail.com`, `outlook.com`, `hotmail.com`, `live.com`, `yahoo.com`, `icloud.com`, `me.com`, `proton.me`, `protonmail.com`, `gmx.net`, `web.de`, `aol.com`, `fastmail.com`). Read at most two pages with `itx.browser.quickAction("markdown", { url })`.
- A result may be about a namesake. Keep only public facts about work: a company, a role, a project, a city at most. Nothing private: no home address, no phone number, no family, no health, nothing sad.

### 2. Write `mind.md` AND generate a starter logo (`profile/icon.svg`) in one commit

Read the tip of `/repos/config` and check `mind.md` and `profile/icon.svg`:

- If `mind.md` does not already have `## What a web search found (may be wrong)` and you found public facts, append at most eight lines under that heading (one fact and its source URL per line).
- Check `profile/icon.svg`: if it is missing or still the default template mark (not already customised by the owner), craft one crisp, minimal square SVG logo (`viewBox="0 0 64 64"`, no external links or scripts) tailored to the owner's initials, domain, or craft.
- Commit `mind.md` and `profile/icon.svg` together in one commit to `/repos/config` (`parent: tip`; if tip moved, re-read tip and retry) and wait for `events.iterate.com/mind/worker-updated`.

### 3. Pass your findings to `/agents/main/website`

Always start `/agents/main/website` after step 2 (even if web search failed or returned nothing) so the website agent builds on your findings instead of racing ahead blank:

```ts
await itx.agents.create("/agents/main/website");
await itx.agents.get("/agents/main/website").message(brief);
```

Your brief to `/agents/main/website` must include:

- `Read onboarding/website.md and tasks/onboarding-website.md of /repos/onboarding and build the initial public homepage at https://<zone>/.`
- A concise summary of the harmless public facts you found (with source URLs), or a note that nothing public was found — clearly separated from any private sign-up notes (which guide purpose only and never go on the public page).
- A note that the starter logo is already live at `/icon.svg` (`profile/icon.svg`), so the page can reference or complement it.

### 4. Mark your task card done

Update `tasks/onboarding-research.md` in `/repos/onboarding` so its frontmatter `status:` is `done`.

### 5. Report to `/agents/main` ONLY AFTER steps 1–4 are complete

Send one short, plain message to `/agents/main`:

```ts
await itx.agents
  .get("/agents/main")
  .message(
    "I looked you up lightly, made a starter logo for your mind (you can ask to change it anytime), and passed what I found to the website agent to build your homepage.",
  );
```

Name no private facts and no raw dossier in the report. The onboarding agent reads `mind.md` when it wants one light detail to ask about.

## Say

- "I looked you up, lightly, and made a starter logo for your mind — you can swap it anytime. Is the Ana Ruiz who runs a ceramics studio in Lisbon you? If not, I'll forget it." Never a list of what you found, and nothing as a fact.
