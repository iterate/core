# The website

The owner should come away with: the mind made them something real at their own address, before they asked, and changes it on their word.

## Ready today

- `await itx.url()` is `https://<zone>/`. A new mind serves "Homepage of mind <slug>" there,
  from the `default` case of `fetch` in `worker.ts`. The site: one public page, a file `site.ts`
  at the top of `/repos/config` that the `default` case calls. It goes live by itself: no question
  first.
- `await itx.browser.quickAction("screenshot", { url })` answers the page's image as bytes.
- A `worker.ts` the mind changed is the owner's: a later platform deploy no longer updates it
  (`template-updates.md`). The exact file from before the site makes it the platform's again.

## Not ready

- A markdown image in the chat is NOT PROVEN to show. If it does not, give the link alone (it
  downloads the image when clicked, and works for 7 days).

## How

Start the helper `/agents/onboarding/website` in your first turn when the `default` case still serves
"Homepage of mind" (`onboarding/helpers.md`). Do not wait for a name or a purpose: use the
sign-up record and the research. The brief holds:

- the address, the mind's name if known, and what it is for, in the owner's words;
- "Make ONE page, the homepage. Add `site.ts` at the top of `/repos/config`; it exports a function
  that answers a `Request` with the page: HTML with its CSS inline, no package, no script or image
  from another site. In `worker.ts` change ONLY what the `default` case answers for the page: call your
  function there. Its `/me` answer and the profile's answers (`serveProfile`) stay, and so does
  every other case. Read the guide `apps.md` first.
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
- the report rule of `onboarding/helpers.md`.

When it reports, take the screenshot and show it, as a markdown image whose address is the `url` that call answered, with the address:

```ts
const shot = await itx.browser.quickAction("screenshot", { url: await itx.url() });
const path = "/agents/onboarding/screenshots/website.png";
await itx.files.get(path).put({ contentType: "image/png", data: shot });
return (await itx.files.get(path).url()).url; // url() answers { url, expiresAt }
```

Each change on the owner's word goes to the same helper. Taking it down: one commit, which you
may make yourself, now. In `await repo.log({ limit: 100 })` find the commit before the first
`Website:` commit; read `worker.ts` at it (`repo.readFile("worker.ts", { commitOid })`); commit
that text as `worker.ts`, with `{ path: "site.ts", delete: true }`. When `worker.ts` changed since
for another reason, put back only its `default` case. Wait for the outcome, then fetch the address.

## Say

- "By the way, this is your website: https://<zone>/. Do you like it?"
- "It's down. Your address shows the plain page again."
