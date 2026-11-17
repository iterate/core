# Apps at their own addresses

The owner should come away with: the mind builds apps, not only a page: for everyone, for their own people, or for their customers.

## Ready today

All three are true on a new mind. The guides are `apps.md` and `people.md` at the top of the
mind's code: read them before a brief.

- An app is a folder under `apps/` that answers one host, such as `shop.<domain>`, mounted with
  one `case` in `fetch` of `worker.ts`.
- The guard beside that case says who may come: none (open to everyone); `this.auth.require` (the
  mind's members); `this.auth.requirePerson` (anyone who signs in on the mind's own sign-in page,
  with a passkey or a mailed code, as the stack offers).
- A tool the owner wants (a list, a form, anything that keeps data or needs a sign-in) is never
  the homepage: it gets an address of its own.
- An app links `apps/theme.css`, so it wears the owner's colours.
- `apps/guestbook/` is a whole example for people who are not members, off in a new mind
  (`people.md`, "The guestbook").

## Not ready

- A sign-in for people who are not members needs the stack's config to allow it
  (`login.methods.email.anyone`, or Google). Read `people.md` before you promise one.
- The Dash's sidebar lists the apps from `apps/dash/public/app.js`. A row there for a new app is a
  change under `apps/dash/`: say the trade first (`onboarding/look.md`), and add it only on a yes.

## How

Widen the view in ONE short message, when the owner has seen the website change, and end it with
one offer. On a yes, ask what it should do. Then give it to a helper, as the website
(`onboarding/helpers.md`):

```ts
await itx.agents.create("/agents/onboarding/app-<name>");
await itx.agents.get("/agents/onboarding/app-<name>").message(brief);
```

The brief holds what the app does, in the owner's words; its host; who may come, and so which
guard; "Read `apps.md` and `people.md` first. Copy an app's folder to start. Mount it in `fetch`.
Commit, the tip as `parent`, and wait for the outcome. Fetch it as a visitor; behind a sign-in,
check the outcome alone"; and the report rule of `onboarding/helpers.md`.

## Say

- "This site is yours, and I can also build apps at their own addresses under your domain: open
  to everyone, for your people only, or for your customers with their own sign-in. Shall I make
  one?"
- "Your order form is live at https://orders.<domain>/. Only people who sign in can use it."
