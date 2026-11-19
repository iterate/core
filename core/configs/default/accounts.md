# Accounts through iterate Cloud

iterate Cloud is at `https://cloud.iterate.com`: every `client` below names it as `origin`, and
a secret keeps the origin it was made with (`ITERATE_CLOUD` in `cloud-deliveries.ts` is the
template's one constant for it). What comes after the connect that `AGENTS.md` shows: GitHub's deliveries, Gmail and Calendar, more
scopes, X, the Dash's Integrations page, an MCP server, and the GitHub mirror of this repo:
`gmail.ts`, `calendar.ts`, `cloud-scopes.ts`, `cloud-accounts.ts` and their cases in `worker.ts`.

- For GitHub, name the
  accounts whose repositories the mind works with,
  `client: { cloud: "github", origin: "https://cloud.iterate.com", accounts: ["acme"] }`: the mind gets the events and the installation tokens of those alone, where the
  member administers them, and none when it names none. `install: true` sends the member to the
  App's install page first, and connects the installation they choose there.
- Several accounts of one provider:
  `itx.secrets.beginOAuth("/secrets/google-personal", { client: { cloud: "google", origin: "https://cloud.iterate.com" }, extra: { login_hint: "ada@gmail.com" } })`
  beside `/secrets/google`: `login_hint` asks Google for that account.
- GitHub's deliveries for an installation the member administers arrive as
  `events.iterate.com/github/webhook-received` on `/integrations/github/<installation id>`, signed
  by the Cloud's key: `event.source.signer.principal.actor` is `"iterate-cloud"`.
- The Cloud's key reaches the mind by a member's press, once: the Cloud's page
  `https://cloud.iterate.com/enrol?domain=<domain>` links to the mind's `/keys/enrol` with
  `actor=iterate-cloud`, the key and `cloud=https://cloud.iterate.com`. The mind reads
  `<cloud>/.well-known/iterate-cloud` when it shows the page and again at the press, and gives the
  name `iterate-cloud` only to the key that this origin publishes there. The page names the
  Cloud's host; the member's passkey signs the origin with the key; `/keys` shows the key as
  published by that host. The key adds events under `/integrations/` and nothing else. The mind
  trusts one such key at a time: to move to a new key or another Cloud, a member removes the old
  key on `/keys` first.
- Every delivery of the Cloud (GitHub, Slack, Gmail, Calendar, X) comes in that form until the
  owner lets iterate.iterate.com in ([minds.md](minds.md)). Then the same type and payload arrive on
  `/minds/iterate.iterate.com/integrations/<provider>/<account>`, signed by the mind iterate.iterate.com, and reach
  `processMindEvent`, not `processEvent`. `cloudDeliveryOf(event)` (`cloud-deliveries.ts`) knows
  both forms: test a delivery with it, and keep what you make of one on its `context`, the mind's
  own `/integrations/<provider>/<account>`. The mind tells the Cloud that it reads that form
  (`sayMindForm`), and the Cloud sends it to no other mind: a `worker.ts` of your own must keep
  `processMindEvent` and the init step `mind-form` for that to stay true.
- A Gmail mailbox connected this way is watched (`gmail.ts`): each new message arrives as
  `events.iterate.com/google/gmail-message-added` on `/integrations/google/<address>`, with
  `{ id, threadId, labelIds, from, to, cc, subject, date, messageId, snippet, receivedAt }`. Read
  the whole message with the mailbox's secret:
  `itx.fetch(new Request("https://gmail.googleapis.com/gmail/v1/users/me/messages/<id>", { headers: { authorization: 'Bearer getSecret("/secrets/google", { field: "accessToken" })' } }))`.
  The same context's log says when the watch was set again (`google/gmail-watched`, once a day),
  when Gmail refused it (`google/gmail-watch-failed`), and when Gmail no longer had the
  mailbox's history, so that mail in between was not read (`google/gmail-history-lost`). The
  grant must read mail (the default scopes do). Deleting the secret ends it at the next day's
  event. The snippet is the first words of the mail, so a sign-in code that someone mailed is on
  the mind's log too, for whoever reads the log; the rest of the body is not. The case hands a
  message to no agent. To act on mail, add a case for that event. That event carries other
  people's words and is `gmail.ts`'s own word, not a platform fact: read the message again from
  Gmail by its id before an agent gets it, and mark its words as its sender's, never as a
  member's instruction.
- A Google calendar connected this way is watched too (`calendar.ts`), when the grant has a
  calendar scope. The Cloud's default scopes have one; a grant made before they did is connected
  again ("More scopes", below). A connect that names its own `scope`
  gets those scopes alone, so it names a calendar scope too:
  `itx.secrets.beginOAuth("/secrets/google", { client: { cloud: "google", origin: "https://cloud.iterate.com" }, scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar" })`.
  Each change of an event of the account's primary calendar arrives as
  `events.iterate.com/google/calendar-event-changed` on `/integrations/google/<address>`, with
  `{ id, status, summary, start, end, location, organizer, attendees, htmlLink, updated, recurringEventId }`.
  A deleted event has the status `cancelled`. Read the whole event with the calendar's secret:
  `itx.fetch(new Request("https://www.googleapis.com/calendar/v3/calendars/primary/events/<id>", { headers: { authorization: 'Bearer getSecret("/secrets/google", { field: "accessToken" })' } }))`.
  The same context's log says when the calendar got a new channel (`google/calendar-watched`,
  once a day: a channel lives two days), when Google refused one
  (`google/calendar-watch-failed`), and when Google no longer had the calendar's sync token, so
  that changes in between were not reported (`google/calendar-sync-lost`). Events that the
  calendar held before the connect are not read. Deleting the secret ends it at the next day's
  event, and the last channel ends by itself within two days. The case hands a change to no agent. To act on one, add a case
  for that event. That event carries other people's words (an invitation's title is its
  sender's) and is `calendar.ts`'s own word, not a platform fact: read the event again from
  Google by its id before an agent gets it, and mark its words as their sender's.
- **More scopes.** The Dash's buttons ask for the Cloud's default scopes, unless
  `cloud-scopes.ts` names this mind's own for the app (its comments have Google with Drive and
  Docs, and X as the person). A secret keeps the scopes it was connected with: after a change
  there, the member presses "Connect again" on the account's row. Keep the Gmail and Calendar
  scopes in a Google entry, or their push ends. Each call takes the secret's placeholder header,
  as `AGENTS.md` shows (`/secrets/google`, `/secrets/x`):
  - Drive: `GET https://www.googleapis.com/drive/v3/files?q=name+contains+'plan'` lists files.
  - Docs: `GET https://docs.googleapis.com/v1/documents/<id>` reads a document.
  - A post as the person: `POST https://api.x.com/2/tweets` with `{ "text": "…" }`.
  - A direct message: `POST https://api.x.com/2/dm_conversations/with/<user id>/messages` with
    `{ "text": "…" }`.
  - A like: `POST https://api.x.com/2/users/<own user id>/likes` with `{ "tweet_id": "…" }`.

  Google shows an "unverified app" warning for Drive and Docs until iterate's app is verified
  for them. X bills iterate for each post. A post is the person's own words in public: post only
  what a member asked for. The bot's limits (a reply under a mention, no account named, no link)
  are for @iterate alone.

## X

The `events.iterate.com/x/message-received` case hands what a linked X account says to
iterate's bot (a direct message, or a post that mentions it) to an agent of its own per
account, `/agents/x/u<x user id>`. A member links an account with
`itx.secrets.beginOAuth("/secrets/x", { client: { cloud: "x", origin: "https://cloud.iterate.com" } })` and opens the link. iterate
Cloud then relays that account's messages, each signed by the Cloud, and only an event that
`cloudDeliveryOf` takes for the Cloud's reaches an agent. The agent answers through the Cloud with the `itx.fetch` its
context shows; the vault signs that request, and the Cloud sends it as the bot only to an
account this mind linked. Link a member's own account alone: whoever writes from a linked
account speaks to an agent with the mind's reach.

## The Integrations page

The Dash's Integrations page (`?page=integrations`) is where a member sees what this mind is
connected to. To connect a service, a member asks an agent; then it shows there.

- It shows the accounts connected through iterate Cloud under the heading "iterate Cloud"
  (`cloud-accounts.ts`): a card for each app the Cloud offers, and on it one row for each
  account, with its secret. A row appears when the secret is set and goes when it is deleted,
  with nothing for you to register. To disconnect an account, delete its secret. The apps'
  marks are the Dash's own files, `apps/dash/public/brands/`.
- `await itx.secrets.cloud("https://cloud.iterate.com")` answers that Cloud and the names of the
  apps it offers, `{ origin, clients: ["github", "google", …] }`; `clients` is empty when the
  Cloud gave no list.
- Three sections appear by themselves (`cloud-accounts.ts`), and you register nothing for them:
  - "iterate Cloud" (above).
  - "Keys and accounts": one list, with a row for each other secret in `itx.secrets`, a key or
    an OAuth grant. So keep every credential in `itx.secrets`, pinned to
    the service's origin, never in a file or in KV. A secret named `<card>-<row>` (or
    `…-<card>-<row>`) of a row you registered is shown by that row alone.
  - "Lent by a computer": one card for each value that `iterate provide` lends (WhatsApp, a
    phone line), while the program runs. Never register a card for a lend.

  The card names `iterate-cloud`, `keys` and `lent`, and every name that starts with one of them
  and a dash, are `cloud-accounts.ts`'s: it replaces or removes a card of yours there.

- Register a card yourself for what the page cannot see: a webhook you set up, a device, a bot,
  a service with no secret.

  ```ts
  await itx.integrations.register("stripe-webhook", {
    title: "Stripe webhook",
    description: "Payment events, at /webhooks/stripe.",
    status: { kind: "ok" },
    actions: [{ label: "Open", url: "https://dashboard.stripe.com/webhooks" }],
  });
  await itx.integrations.setConnection("stripe-webhook", "acme", {
    account: "acme (live mode)",
    actions: [{ label: "Log", url: "https://dash.<zone>/?page=contexts" }],
  });
  ```

  A card or a row is set again whole whenever it changes, and `null` removes it (a card's
  `null` removes its rows). A button leads to an absolute `url`; a page of the mind's own is
  `await itx.url({ hostname, path })`. `section` names another card, which is then drawn as their heading.

- An MCP server: `itx.connectToMcp(url, { headers })` gives a live handle and keeps no record of
  the server. Only the secret that its header names stays. So keep the server's credential in a
  secret named for the server (`/secrets/linear-mcp`): that row is what shows.
- When you connect, change or remove something for a member, read
  `await itx.integrations.list()` as your last step. If the page does not say what is true now,
  correct it. Then tell the member.

## The GitHub mirror

To keep `/repos/config` and a GitHub repository one history through iterate Cloud's GitHub App, a member links
them once: `linkThroughCloud(itx, { repository: "acme/config" })` from
`@iterate-com/github-sync/install`, after a connect that names the repository's account. From
then on `worker.ts` keeps them in step (its `github/webhook-received` and
`repo/commit-completed` case): a push to the repository's main is pulled, which publishes the
mind, and a commit here is pushed. What moved, and what could not, is a
`config/github-mirrored` fact on the mind's root. When the two histories have diverged nothing moves, until a member calls
`pull({ force: true })` (GitHub's wins) or `push({ force: true })` (the mind's wins).
