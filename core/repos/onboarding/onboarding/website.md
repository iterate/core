# The website

The owner should come away with: the mind made them something real at their own address, before they asked, and changes it on their word.

## Ready today

- `await itx.url()` is `https://<zone>/`. A new mind serves "Homepage of mind <slug>" there,
  from `homepage.ts` at the top of `/repos/config`, which `worker.ts`'s `fetch` calls. The site:
  one public page, that file and nothing else. It goes live by itself: no question first. On a
  mind whose `worker.ts` already calls a `site.ts`, the site is `site.ts`: change that file.
- `await itx.browser.quickAction("screenshot", { url })` answers the page's image as bytes.
- A file the mind changed is the owner's: a later platform deploy no longer updates it
  (`template-updates.md`). The site changes `homepage.ts` alone, so `worker.ts` keeps following
  the template. The exact `homepage.ts` from before the site makes it the platform's again.

## Not ready

- A markdown image in the chat is NOT PROVEN to show. If it does not, give the link alone (it
  downloads the image when clicked, and works for 7 days).

## How

`/agents/main/researcher` starts you (`/agents/main/website`) once it has looked up the owner, generated a starter logo (`profile/icon.svg`), and noted public context in `mind.md`. You are that subagent. Use the findings passed in your brief, `mind.md`, the mind's profile (`profile.ts`), and the owner's words on `/agents/main` so the very first version of the page feels real and personal (not a blank domain placeholder). When the address no longer serves "Homepage of mind" and you were not asked to edit it, report that and stop.

**Keep it fast — 2 to 3 scripts total, not 7 sequential turns:**

1. **Read once in parallel:** fetch `itx.url()`, `itx.config.profile()`, `homepage.ts`, `mind.md`, `apps.md`, and `tasks/onboarding-website.md` in a single `Promise.all`.
2. **Build, probe, publish, and verify in one script:** construct `homepage.ts`, probe it via a candidate worker if needed, commit with `parent: tip` (`Website: ...`), wait for `events.iterate.com/mind/worker-updated`, and verify `GET https://<zone>/` returns `200` with your page's content and no sign-in.
3. **Screenshot, mark done, and report in one script:** take `itx.browser.quickAction("screenshot", { url })`, save to `/agents/main/screenshots/website.png`, update `tasks/onboarding-website.md` to `status: done`, and message `/agents/main`.

The job:

- the address, the mind's name (`(await itx.config.profile()).name`, empty when the owner has
  not named it) and what it is for, in the owner's words;
- "Make ONE page, the homepage. Change ONLY `homepage.ts` at the top of `/repos/config`: keep its
  export `homepage(request, host)`, which answers GET and HEAD of `/` with the page and null for
  anything else. The page: HTML with its CSS inline, no package, no script or image from another
  site. Change no other file: `worker.ts`, its `/me` answer, the profile's answers (`website.ts`)
  and every case stay. Read the guide `apps.md` first.
  Start every commit message with `Website:`.";
- "The page is PUBLIC: no `this.auth.require`, no `requirePerson`. It shows the mind's name and
  what it is for. It may use what is ALREADY PUBLIC about the owner, and nothing else: of the web
  search, only what matches them. What the owner said in the sign-up is private: it tells you
  what the page is for, and none of their words, plans or work details go on the page. Never
  an email address, a phone number, a home address, or a guess. No tool, no form, no list that keeps data.";
- "Commit with `itx.repos.get('/repos/config').commitFiles`, the tip as `parent`. Wait for the
  outcome: `await itx.cd('/').waitForEvent({ type: ['events.iterate.com/mind/worker-updated',
'events.iterate.com/mind/worker-update-failed'], payload: { commitOid }, afterOffset: 0,
timeoutMs: 60000 })`. On a failure, fix it and commit again. Then fetch the address with
  `itx.fetch`, with no sign-in: 200, with your page's own words. A 401 or a sign-in page means it
  is not public: fix it.";
- the report rule of `onboarding/subagents.md`.

When the page is live, take the screenshot, and put it in your report as a markdown image whose
address is the `url` that call answered, beside the address (the onboarding agent passes it on):

```ts
const shot = await itx.browser.quickAction("screenshot", { url: await itx.url() });
const path = "/agents/main/screenshots/website.png";
await itx.files.get(path).put({ contentType: "image/png", data: shot });
return (await itx.files.get(path).url()).url; // url() answers { url, expiresAt }
```

Each change on the owner's word comes to you, the same subagent. Taking it down: one commit, now. In `await repo.log({ limit: 100 })` find the commit before the first
`Website:` commit; read `homepage.ts` at it (`repo.readFile("homepage.ts", { commitOid })`);
commit that text as `homepage.ts`. Wait for the outcome, then fetch the address.

## Say

- "By the way, this is your website: https://<zone>/. Do you like it?"
- "It's down. Your address shows the plain page again."
