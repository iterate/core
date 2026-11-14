# core/alchemy

The Alchemy program that deploys one mind as a stack of four Workers: the boundary, the
mind, the secrets Worker and the auth Worker, and a fifth with the telemetry part
(`tasks/mind-stack.md` in iterate's own repository holds the record). Only the boundary is public: it takes
everything that comes in and, as the door, everything the mind sends out. One config, one stage,
every resource named `iterate-<name>-<part>` (`src/config.ts` `resourceNamesOf`).

## Deploy

1. Copy `mind.config.example.ts` to `mind.config.local.ts` (git ignores it, and
   `mind.config*.local.json`). Fill in the mind's `name`, the Cloudflare `accountId` and a
   zone of that account as `domain`, and under `auth` who is a member (`login.allow`) and whether a
   mailed code proves an address (`login.methods.email`; passkeys need no setting). Or name another config file in
   `ITERATE_MIND_CONFIG`, a module or a `.json` file. `src/config.ts` says what each field does.
2. Set `CLOUDFLARE_API_TOKEN` (the table below says what it must allow). `CLOUDFLARE_ACCOUNT_ID`
   is optional with a config file; when set, it must be the config's account.
3. From `core/alchemy`, with the mind's name as the stage:

   ```sh
   pnpm run plan --stage <name>      # what a deploy would change
   pnpm run deploy --stage <name>
   pnpm smoke <zone>                 # one line per check, through the boundary
   pnpm run destroy --stage <name>
   ```

A deploy stops before it changes anything when the account has `iterate-<name>-project` or
`iterate-<name>-ingress`: a deployment from before the rename to "mind", whose data is in those
Workers (`scripts/refuse-older-stack.ts`). Erase it with the older version's `destroy`, or keep it
on the older version.

The package scripts load `core/alchemy/.secrets` when it exists (git ignores it).
`ITERATE_PROTOTYPE_TOKEN=<a long random string>` there is a stand-in member: the deploy binds it to
the auth Worker, which answers one prototype member for exactly that token.

**Sign in with Cloudflare** (`core/auth-worker/src/cloudflare-sign-in.ts`) is a method of the
config. The config makes the way exist for the stack; an app of the mind chooses it in its own
code, so a new app needs no deploy:

```ts
auth: {
  login: {
    methods: { cloudflare: { clientId: "<the Cloudflare OAuth client's id>" } },
    allow: [/* … */],
  },
}
```

```js
// in the mind's config repo, an app on its own hostname
const refused = this.auth.requirePerson(request, { methods: ["cloudflare"] });
if (refused) return refused;
const person = this.auth.person(request, { methods: ["cloudflare"] });
```

- The client's secret is the config's field `clientSecret`, which only the deploy's environment
  gives: `ITERATE_MIND__AUTH__LOGIN__METHODS__CLOUDFLARE__CLIENT_SECRET`. A config file that holds
  it is refused, the stack stores it nowhere, and the auth Worker gets it as its own binding, never
  in its settings. A deploy without it is refused: the stack stores the rest of the config, so no
  deploy forgets the method, and none takes the secret away. Keep the secret where the deploy's
  other credentials are (Doppler).
- Register `https://iterate.<domain>/sign-in/cloudflare/callback` as a redirect URI of the client,
  and the scope `user-details.read`. The sign-in asks that one scope and no `offline_access`.
- The app's guard is the rule. Every grant keeps the way its session began by, the boundary stamps
  it beside the person, and the guard refuses any other way on every request, the page's session
  cookie and an MCP client's bearer alike. A person refused that way is signed in again on that
  host, by a way the app names: the boundary passes the guard's ways to the issuer as RFC 9470's
  `acr_values`, and the issuer shows a page with one button for each. That is routing, which a
  browser can change; what it changes ends at the guard.
- A sign-in with Cloudflare counts only where an app names it: a guard with no `methods` takes
  every way but Cloudflare's. It is never a member, whatever its address is, never a session of
  the mind's own pages, and never a token for the mind's API, MCP server or `/provide`.
- A stack whose secret is gone all the same lets nobody in to an app that takes Cloudflare alone,
  and ends the Cloudflare sign-ins it gave before.

The smoke check needs that token for every check of the mind itself, through its API at
`iterate.<zone>/api`; without it, those checks pass as skipped and say why. With it, the smoke
commits to the mind's config repo and takes its changes out again, and first takes out what an
earlier run left. The approvals checks also need `ITERATE_SMOKE_PETSHOP_ORIGIN`,
`ITERATE_SMOKE_APPROVER_KEY` and `ITERATE_SMOKE_SERVICE_KEY` (keys that the config's `auth.keys`
names), the Cloud's checks `ITERATE_SMOKE_CLOUD_ORIGIN` (the config's `cloud.origin`), and the
check of the sign-in limits `ITERATE_SMOKE_LIMITS=1`. On a mind whose `worker.ts` is its own, the
checks of the default config's site are skipped.

## Destroy

`pnpm run destroy --stage <name>` removes what a deploy made, with the mind's contexts, files,
repos, members and secrets. It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

- **It leaves the state store**, on purpose: a fork's stack keeps its state there, and a stack
  deployed again reads its keys from it. That is three things in the account: the Worker
  `iterate-<name>-state`, and two secrets in the account's Secrets Store,
  `AlchemyStateStoreToken_iterate_<name>_state` and
  `AlchemyStateStoreEncryptionKey_iterate_<name>_state` (a `-` in the name is written `_`). When
  the stack is gone for good, `pnpm run destroy:state --stage <name>` removes all three, and
  refuses while a Worker of the stack is still deployed. Deleting the Worker by hand leaves the
  two secrets, and a Secrets Store holds a limited number.
- Before Alchemy's destroy, `scripts/artifacts-subscriptions.ts --remove` deletes the config
  repo's Artifacts subscription: Alchemy does not know it, and a queue with a subscription may
  refuse its delete.
- It leaves the zone, with no DNS record of the stack in it. Cloudflare's Email Sending writes
  the TXT record `_dmarc.<domain>` at a deploy and leaves it when it is turned off, so
  `scripts/remove-dmarc-record.ts` removes it after the destroy, when its content is still what
  Email Sending wrote (`v=DMARC1; p=reject;`). A DMARC record with other content is yours and
  stays. The token needs Zone · DNS Edit, as a deploy does. `destroy` reads the stack's domain
  before Alchemy's destroy, which clears a stored config. By hand, after a destroy:
  `node scripts/remove-dmarc-record.ts --stage <name> --domain <domain>`.
- **A stack with telemetry: its own tables are dropped after it** (`scripts/drop-telemetry-tables.ts`,
  run by `destroy` when Alchemy's destroy has ended well). R2 keeps a data catalog's tables when
  the catalog is turned off and when its bucket is deleted, and gives them back to a new bucket
  of the same name. A sink refuses a table that exists, so the same stack deployed again would
  get no telemetry. The step drops `telemetry.events`, `telemetry.logs` and `telemetry.spans` in
  the catalog of the stack's own bucket, `iterate-<name>-telemetry`, then the namespace when it
  holds nothing else, and prints a line for each. To reach them it makes that bucket for a
  moment, turns its catalog on, and puts both back. Another stack's tables are in another
  bucket's catalog. It drops nothing while a Worker of the stack is deployed, so a destroy that
  you cancel at its question leaves the tables.
- A stack with telemetry also needs Account · Account API Tokens Edit on the token: the destroy
  deletes the stack's two API tokens.
- When the step could not run (no credentials, or Cloudflare refused it), run it by hand before
  the stack is deployed again: `node scripts/drop-telemetry-tables.ts --stage <name>`.

## The stored config

Each deploy that succeeds keeps its config in the stack's state store, `iterate-<name>-state` in
the mind's own account, as the stack's output (`mind/<name>/output`), in place of the one
before. A checkout with no config file, such as a fork's, deploys the stack from it with only the
account's credentials:

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm run deploy --stage <name>
pnpm run config --stage <name> > mind.config.local.json   # the stored config, JSON alone
ITERATE_MIND_CONFIG=mind.config.local.json pnpm run deploy --stage <name>   # changed
```

The stored config holds no secret: the keys are in Alchemy's state. A config with a field that
`src/config.ts` `PUBLIC_FIELDS` does not list is refused before the deploy, so a new field is
stored only once it is shown to be public.

The deploy's environment sets any field of the config on top of the file or the stored config, by
the field's own variable (`iterate/app-config`): `ITERATE_MIND__`, then the path, `__` before each
segment, each in SNAKE_CASE (`ITERATE_MIND__TELEMETRY=true`). A public field set so is stored; a
secret is set this way alone, at every deploy, and never stored. A variable whose path the config
does not name is warned about and ignored. `ITERATE_MIND` alone, and the old platform's
`ITERATE__*`, are no part of it.

## An upgrade on the side, and a fork

A stack is what its state store says it is: `iterate-<name>-state` in the mind's own account holds
the Alchemy state, the generated keys and the stored config. So any checkout that has the
account's credentials can deploy over a stack that another checkout, or the iterate Cloud, made.
Nothing is kept in the checkout.

**An upgrade by hand.** From a checkout of the commit you want, with no config file:

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm run plan --stage <name>     # read it first
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm run deploy --stage <name>
```

The plan of a stack that is up to date shows `noop` for every resource but `AuthDb`, which is
checked against the migrations at each deploy. The iterate Cloud's "Update" is the same deploy, run
in the Cloud's own container from the commit the Cloud is on: the two take turns over one state.
A stack with `atRestKey: "environment"` or a first owner's ticket needs the same environment
variables from whoever deploys.

**A fork with changed code.** A fork's checkout deploys the same way, and the stack then runs the
fork's Workers. The next deploy from another checkout, or the Cloud's Update, puts that checkout's
code back: a stack runs the code of whoever deployed last. A fork that wants to stay a fork deploys
from the fork alone, and merges upstream to upgrade.

**A fork with resources of its own.** Do not add them to the mind's stack (`alchemy.run.ts`): a
deploy from a checkout that does not declare them deletes them, with their data. Give them a stack
of their own name, kept in the same state store. A deploy of the mind's stack does not know that
stack and leaves it alone:

```ts
// fork/alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { resolve } from "node:path";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { loadMindConfig, resourceNamesOf, stageOf } from "../src/config.ts";

const config = await loadMindConfig(stageOf(process.argv)); // the mind's stored config
process.env.CLOUDFLARE_ACCOUNT_ID ||= config.accountId;

export default Alchemy.Stack(
  "fork", // not "mind": a stack of its own
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state({ workerName: resourceNamesOf(config.name).state }),
  },
  Effect.gen(function* () {
    const notes = yield* Cloudflare.KV.Namespace("ForkNotes", {
      title: `iterate-${config.name}-fork-notes`,
    });
    yield* Cloudflare.Worker("ForkHello", {
      name: `iterate-${config.name}-fork-hello`,
      main: resolve(import.meta.dirname, "hello.ts"),
      compatibility: { date: COMPATIBILITY_DATE },
      workersDev: { enabled: true, previewsEnabled: false },
      env: { NOTES: notes, DOMAIN: config.domain },
    });
  }),
);
```

```sh
node node_modules/alchemy/bin/cli.js deploy fork/alchemy.run.ts --stage <name> --yes
node node_modules/alchemy/bin/cli.js destroy fork/alchemy.run.ts --stage <name> --yes
```

`resourceNamesOf(config.name)` gives the names of the mind's own Workers, for a binding by name.
Each stack has its own `destroy`. The mind's leaves the state store, `iterate-<name>-state`, in the
account: remove it when both stacks are gone (`pnpm run destroy:state`, "Destroy" above).

## A zone that other Workers share

A stack takes the routes `<zone>/*` and `*.<zone>/*`. Another Worker on the
same zone keeps a hostname only through a route of its own for that hostname: a more specific
route wins over the wildcard. Add those routes before the stack takes the wildcard.

Two things to know when the zone had an apex and a wildcard record before the stack came:

- The deploy needs `--adopt`, and it then holds the two `AAAA` records (`<zone>` and `*.<zone>`,
  `100::`, proxied) as its own.
- **A `destroy` of that stack deletes both records.** Every hostname on the zone that another
  Worker serves by a route, and that has no DNS record of its own, stops resolving. Never destroy
  such a stack without making both records again at once.

## Signing in

The auth Worker is the mind's OAuth authorization server, at `https://iterate.<zone>`. Clients
find it from the protected-resource documents the boundary serves for the API
(`https://iterate.<zone>/.well-known/oauth-protected-resource/api`) and the MCP server, and read its
endpoints from `https://iterate.<zone>/.well-known/oauth-authorization-server`. Anyone may sign in;
a token for the API, the MCP server or `/provide` goes to a member alone (`login.allow`). Two ways
to prove an address beside a passkey, one or both:

- `email: {}`, a mailed code: six digits from `sign-in@<zone>` through the stack's own boundary,
  so the stack depends on nobody. The config must have `mail: true`, or the deploy is refused.
  A code goes only to a member: an address that an `email` or `emailDomain` rule of `allow` names,
  or one added on `/members`. With
  `email: { anyone: true }` any other address that asks is mailed too, at most 20 such codes an
  hour for the whole stack: use it when people who are not members sign in to the mind's pages.
  An owner blocks such a person on `/members`: no code goes to that address or its `+tags`, Google
  signs it in to nothing, and its sessions and tokens end.

- `google: {}`, "Sign in with Google", through the Google client of the iterate Cloud the config
  names (`cloud: { origin }`; without it the deploy is refused). Google is the identity provider:
  the auth Worker checks Google's signed id_token itself (Google's keys, the Cloud's client id as
  the audience, its own nonce), and takes an address only when Google is the authority for it: a
  gmail.com address, or an address of the account's own Google Workspace domain. The Cloud lends
  its client secret and its redirect URI, and learns nothing but that a sign-in happened. It proves
  an address exactly as a mailed code does: a member with no passkey adds the first one, and a
  member who has one signs in with the passkey.
  `google: { signsInAlone: true }` is the other policy: Google alone signs a member in. It makes
  the Cloud as trusted as Google for who a member is, because the Cloud holds the client secret
  and the one redirect URI: a dishonest Cloud could send a person to Google with the stack's nonce
  and hand the stack a genuine id_token for them. Without the switch, that gets a first passkey
  for a member who has none, and nothing else. Such a session still signs nothing: adding a member
  or a further passkey takes a passkey.

With no method (`methods` left out, or `{}`), a passkey is the only way to sign in. An owner, a
person `allow` names by address, gets a first passkey by a deploy's ticket
(`scripts/first-owner-ticket.ts`). A member who is no owner gets one by a sign-in link that an owner
makes on `/members`, with a press of the owner's passkey: it is for a member with no passkey, and
signs that member in once, within 24 hours, to add one. The owner passes the link on.

A member signs in with a passkey, and with nothing else. Every stack's sign-in page has "Sign in
with a passkey": one the member added on `https://iterate.<zone>/keys`. It signs in the member
whose key it is, while that address is a member and the key is not removed, and the passkey must
verify its user (a PIN, a fingerprint or a face). Its session on `iterate.<zone>` ends when that
passkey is removed. The grants that session gave do not: an app or a CLI it signed in stays so
until its grant ends (after 7 days with no use), until the member signs it out on `/sessions`,
which lists each one, or until an owner removes the member's keys.

`https://iterate.<zone>/sessions` is for anyone signed in, member or not: the person's browsers
that hold a session at the issuer, each with its button that ends it, and the apps and tools that
hold a sign-in as the person. Each browser's session is a row in the auth Worker's D1
(`browser_sessions`), and its cookie holds the row's id: an ended row is no session.

A mailed code proves an address and no more. For a member who holds no passkey, it opens
a session that does one thing: it adds the first passkey on `/keys`, and every other page sends
the member there. That passkey makes the session a member's, and the page then asks for a second
passkey. For a member who holds a passkey, a code is refused: mail is no way round
a passkey. Someone who is no member signs in by a code as before, and gets
nothing but an identity on the mind's own pages.

Who may act grows only by a signature (`core/auth-worker/src/signed-change.ts`). To add a member, and to
add a further passkey for a person who holds one, each takes a statement that a member's key
signed: on `/members` and `/keys` the person's passkey signs it, and a script sends
`{ statement, signature }` to `POST /members`. A session's cookie or a member's token does neither,
so whoever steals one adds no one. To remove a key, the person's passkey signs too, and so does an
owner's when the owner removes a member's keys or makes a member's sign-in link. To remove a
member takes a member's session or token, and no signature. A new passkey
is made on another device than the one that signs it: no device holds two passkeys of one person.
Two ways in sign nothing: a person's first passkey, and the passkey that a ticket or a member's
link adds.

A rule of `allow` that names no exact address (`subaddresses`, `emailDomain`, `everyone`) admits
addresses nobody named. Each one is a member with no passkey until it adds one, so whoever reads
its mail gets a passkey that approves requests and adds members. A stack that approves things
names each member by the exact address.

A bridge that lends a capability for longer than a person's sign-in lasts has a key of its own
(`iterate provide --key`, `core/lib/src/cli/README.md`). A member allows the key once, on
`/keys/enrol`, for one capability name, with a press of their passkey. The key then asks `POST /keys/token` for a token with a
statement it signs. The token lives one hour, is for the API alone, and reaches the one lend and
nothing else of the mind. There is no refresh token and the key has no end date: the member who
allowed it removes it on `/keys`, with a press of their passkey too. That page also shows the day
the key last asked for a token.

A lost passkey has two ways back in, and neither is mail:

- A member who is no owner asks an owner. An owner is a member an `email` rule of `allow` names.
  On `/members` the owner removes that member's keys, with a press of the owner's passkey, which
  also ends every grant the member gave (the apps, the CLI, a mind hostname's session). A code,
  or a sign-in link the owner makes, then signs the member in once, to add a new passkey.
- An owner runs a deploy with a first owner's ticket. `node scripts/first-owner-ticket.ts
  <address>` prints a ticket and a variable. Deploy with `ITERATE_FIRST_OWNER_TICKET=<variable>`,
  then open `https://iterate.<zone>/keys/first#<ticket>`. The ticket signs in that one owner, once
  and within 24 hours, on a new stack and on one with users and keys alike. Its session lasts 24
  hours and opens `/keys` alone: the passkey added there makes it that passkey's session, which
  then removes the lost ones. So whoever can deploy to the Cloudflare account is the root of the
  stack's sign-in. The auth Worker holds the ticket's hash alone, and the next deploy without the
  variable removes that.

A new stack's owner gets the first passkey the same way: by the ticket of the first deploy, or,
when its 24 hours are over, by a code.

A client whose metadata document and redirect are on an origin in `auth.trustedClients` gets no
consent page.

With `auth.devices: { passkey: true }`, a member continues a device's sign-in ("Sign in a device",
"Let … in") with a press of a passkey that checks its user, as a key is allowed. Without it, the
session alone continues.

State is in the account, in the state-store Worker `iterate-<name>-state`, which the mind owns.
`ITERATE_STATE_STORE=local` keeps it in `.alchemy/` instead (git-ignored), with the generated keys in
clear: for a throwaway stack only.

With `mail: true`, the zone's mail becomes the mind's: the stack turns Email Routing on and takes its catch-all
rule, and a `destroy` turns Email Routing off for the whole zone.

## The API token

A custom token at https://dash.cloudflare.com/profile/api-tokens, for the mind's account and
its zone, with these permissions. Derived from what the stack declares; not yet proven as the
least a deploy needs.

| Permission                      | Level | For                                            |
| ------------------------------- | ----- | ---------------------------------------------- |
| Account · Workers Scripts       | Edit  | the Workers and their Durable Objects          |
| Account · Workers KV Storage    | Edit  | the mind's and the auth Worker's KV namespaces |
| Account · Workers R2 Storage    | Edit  | the files bucket                               |
| Account · D1                    | Edit  | the auth Worker's database of people           |
| Account · Containers            | Edit  | the sandboxes' container and its image         |
| Account · Artifacts             | Edit  | the repos' namespace                           |
| Account · Workers AI            | Read  | `itx.ai`, through the account's AI Gateway     |
| Account · AI Gateway            | Edit  | the gateway `default`                          |
| Account · Browser Rendering     | Edit  | `itx.browser`                                  |
| Account · Email Sending         | Edit  | mail out, the sign-in code among it            |
| Account · Queues                | Edit  | the events queue and its subscriptions         |
| Account · Secrets Store         | Edit  | the state store's key                          |
| Account · Workers Observability | Read  | reading the Workers' logs                      |
| Zone · Zone                     | Read  | finding the zone by its name                   |
| Zone · Workers Routes           | Edit  | the boundary's routes on the zone              |
| Zone · DNS                      | Edit  | the apex and wildcard records, and mail's      |
| Zone · Email Routing Rules      | Edit  | mail in: the catch-all rule to the boundary    |

## What a deploy makes

- Generated keys, kept in Alchemy's state: the secrets Worker's at-rest key, the auth Worker's
  signing key and, for a mind Worker, the mind's signing key. Each is bound to its Worker as a secret. A stack that holds values sealed
  under a key from elsewhere says `atRestKey: "environment"`, and then
  every deploy needs `ITERATE_SECRETS_AT_REST_KEY`: one without it is refused.
- The auth Worker's D1 database of people, `iterate-<name>-auth-db`, migrated from
  `core/auth-worker/migrations`, and its KV namespace for the OAuth library, `iterate-<name>-auth-kv`.
- For a mind Worker: its KV namespace `iterate-<name>-mind-kv`, the files bucket
  `iterate-<name>-files` and the repos' Artifacts namespace `iterate-<name>-repos`, which
  `scripts/repos-namespace.ts` makes before the deploy when it is missing.
  - The stack's queue of Cloudflare events (below), and the config repo's subscription to it,
    which `scripts/artifacts-subscriptions.ts` makes after the deploy: Alchemy does not know
    Artifacts as a source. Each push to `repos--config` becomes a fact on the mind's
    `/repos/config` (`events.iterate.com/repo/pushed`,
    `core/boundary-worker/src/artifacts-events.ts`), and a `git push` to its `main` publishes
    the mind, about 6 seconds after the push. A push that the mind could not publish after three
    tries is the fact `events.iterate.com/repo/push-not-published` on `/repos/config`; the repo
    tries again at its next event, and `announceTip()` publishes the tip by hand.
  - A write token of the config repo's remote is a right to publish the mind. Its holder can
    publish with a `git push`, at once, with no itx call, for the token's life. Each write token
    that is made is the fact `events.iterate.com/repo/token-created` on `/repos/config`: its id,
    its scope and its expiry, never the token. The mind's own commits make such tokens too. A
    read token is no fact: the mind's own reads make several a minute.
  - The stack asks Cloudflare for pushes and tokens made alone. Clones, fetches and revoked
    tokens have a row in the boundary but are not asked for (`EVENTS` in
    `src/artifacts-subscriptions.ts` widens it). A repo that the mind makes after the
    deploy has no subscription: after a push to it, call `announceTip()` on it. The step reads
    the queue's own subscriptions as the stack's other subscriptions are read
    (`src/event-subscriptions.ts`). When Cloudflare answers that the repo has a subscription on
    another queue (one a destroy left behind), it reads the account's, newest first, at most 100
    pages, deletes that one and makes its own; past that bound it fails and says what to delete.
- The four Workers. Only the boundary has routes: `<zone>/*` and `*.<zone>/*`.
- Proxied `AAAA 100::` records for the apex and `*`, so the routes receive
  traffic. A record that already exists is not taken over: remove it, or deploy with `--adopt`.
- With `mail: true` in the config: Email Routing on the zone, its catch-all rule delivering to the
  boundary, and Email Sending on the domain, which the boundary sends with.
  - A Queue `iterate-<name>-events`, the stack's one queue of Cloudflare events, with
    the boundary as its one consumer: a table in the boundary
    (`core/boundary-worker/src/cloudflare-events.ts`) says what each message becomes on the mind.
    A stack with a mind Worker has it too, with mail or without.
    Mail's subscription puts the domain's Email Sending events on it (bounced, failed,
    rejected, complained). Each such event becomes an `events.iterate.com/email/delivery-failed` fact on the
    mind's `/integrations/email`, with the recipient, the sent mail's `messageId` and Cloudflare's
    cause: a mail that the provider took and that bounced later is no longer known to Cloudflare
    alone. An event the mind does not take is retried a minute apart, ten times, then dropped.
    The subscription's id is kept in the stack's state. A first deploy creates it without reading
    the account's list of subscriptions, which in an account of many can take longer than the deploy
    may; when Cloudflare answers that the source already has one, the deploy reads the queue's own
    subscriptions, at most five pages, and takes the one of its name, or fails and says to delete
    the one in the way (`src/event-subscriptions.ts`).
- With `mail: { forwardTo: "team@example.org" }`: the same, and the boundary then forwards each
  mail to that address as it arrived, with Email Routing's own forward: its From is the sender's,
  so a reply goes to the sender. The mind has the mail first. Cloudflare forwards only a mail
  whose sender is proven (SPF or DKIM): one that is not stays in the mind alone. The address must
  be a verified destination address of the account's Email Routing: add it in the dashboard
  (Email Routing, Destination addresses) and confirm the link Cloudflare mails to it.
  - **The cost of a forward address that does not work.** While the address is not verified, is
    removed from the account, or refuses mail, every mail to the mind fails for its sender: the
    mind keeps the mail, the delivery fails, and the sender gets it back. Each failed forward is
    an `events.iterate.com/email/forward-failed` fact on the mind's `/integrations/email`, with
    Cloudflare's words.
  - The address is not one of the stack's own domain (the config refuses it), and a mail that
    Email Routing forwarded to it before (its `X-Forwarded-To` names the address) is not
    forwarded again, so an address that leads back to the stack makes no loop. Any sender can
    write that header, so a mail that is not forwarded for it is an `email/forward-failed` fact
    too.
  - Cloudflare writes one `X-Forwarded-To` line for each forward and keeps the earlier lines
    (seen on a mail that passed two forwards), so the stop also ends a loop that goes through
    another forward before it comes back. A loop of two stacks' forwards was not run as such:
    do not build one.
  - **Before a rollback.** A release from before `mail.forwardTo` refuses a config that names it.
    After a rollback to such a release, every deploy and update of the stack fails until its
    config says `mail: true` again: change the config first.
- The sandboxes' image, `images/iterate-dev-image` of `core/mind-worker`, built with the local Docker and
  pushed. A deploy with no Docker sets `sandboxImage` in the config's `mind`:
  - `"published"`: `scripts/sandbox-image.ts` copies the same image, built once and published at
    `ghcr.io/iterate/iterate-dev-image` (the digest is pinned in `src/sandbox-image.ts`), into the
    account's registry through the registry API, and the stack names it there. A later deploy
    copies only the layers that the account's registry does not have yet.

    A first deploy takes longer by the copy and the preparation. The image's layers at the pinned
    digest are about 1.6 GB: from a home connection at about 1 MB/s up, the copy takes about half
    an hour. On bimplin.com, Cloudflare prepared the image in 1 minute 35 seconds, and the rest of
    the deploy took about 1 minute.

    From a machine in a data centre, such as the Cloud's deploy run, the copy is limited by that
    machine's link.

  - `"managed"`: the stack declares no image, and a sandbox starts Cloudflare's bare
    `cloudflare/debian-trixie`, with no Node, git tools, Chromium or agent CLIs.

## Telemetry

`telemetry: true` in the config adds a warehouse of the stack's events, logs, spans and metrics
to the stack, in the mind's own account (`core/telemetry-worker`). Without it, the
mind has no `itx.telemetry`, so the Dash's Analytics page says it is not served.

The mind reads it with `itx.telemetry.query(sql, { hours })`: one `SELECT` over `events`, `logs`,
`spans` or `metrics`, over the last day unless `hours` says otherwise. From `core/alchemy`, with a
session of `iterate login <zone>`:

```sh
pnpm run itx <zone> 'itx.telemetry.query("SELECT type, count(*) FROM events GROUP BY type")'
```

What a deploy makes with it:

- The telemetry Worker, `iterate-<name>-telemetry`, on its workers.dev address, where Cloudflare's
  export posts with a generated secret. Its `Telemetry` entrypoint takes the mind's query,
  events and metrics from the boundary's door. It alone holds the warehouse's tokens.

  That address is the one thing of a stack, besides the boundary, that the internet reaches.
  It cannot move behind the boundary: Cloudflare refuses to change a destination's URL once it is
  made, and tests the URL with a POST on every other update, while the boundary, the mind and
  the auth Worker deploy after the destinations, which their `observability` names.

- The R2 bucket `iterate-<name>-telemetry` with its Iceberg catalog (compaction, snapshots kept a
  day), and for each of `events`, `logs` and `spans` a stream, a Parquet sink and a pipeline.
- Two account-owned API tokens: the catalog token (R2 Data Catalog Write; the bucket's item write
  and SQL read), and the analytics token (Account Analytics Read), which reads `metrics`.
- The Analytics Engine dataset `iterate_<name>_metrics`, which the mind Worker writes.
- Two observability destinations, traces and logs, named by every other Worker of the stack.
- At every context's birth, the `platform` row that sends its events to `events`.

The mind reads its own Workers' logs and spans (mind, boundary) whole. Of the vault and auth
it reads no log line, and their spans with the text columns empty. No Cloudflare
alert is set for a destination it disables.

The token above also needs: Account · Pipelines Edit, Account · Workers R2 Data Catalog Edit,
Account · Workers Observability Edit (the destinations; in place of Read), and Account · Account
API Tokens Edit (the two tokens). Resources: one Worker, one bucket, three streams, sinks and
pipelines, one dataset and two destinations; the stack's other Workers write every log line and
span twice, to Cloudflare and to the warehouse. Pipelines, R2 and R2 SQL bill by what is written,
stored and scanned.

**Account API Tokens Edit is needed once.** The deploy that turns telemetry on makes the two
tokens, and their values stay in the stack's state. A later deploy with a token that may not make
API tokens passes: nothing about the two tokens changed, so the deploy asks Cloudflare nothing
about them. So a stack whose everyday deploy token must not make tokens (one that CI holds) gets
its telemetry from one deploy with a short-lived token that may:

```sh
pnpm run config --stage <name> > mind.config.local.json   # then add "telemetry": true to it
CLOUDFLARE_API_TOKEN=<one that also has Account API Tokens Edit> CLOUDFLARE_ACCOUNT_ID=… \
  ITERATE_MIND_CONFIG=mind.config.local.json pnpm run deploy --stage <name>
```

Revoke that token after it. The same permission is needed again by a `destroy` (it deletes the two
tokens) and by a deploy of a version that changes what a token may do. The iterate Cloud asks for
it in a second consent of its own: a deployment's "Turn on telemetry", and then its "Update".

**Telemetry turns off and on again.** `pnpm run deploy` ends in `scripts/deploy-stack.ts`, which
does three things around Alchemy's deploy, for the CLI and for iterate Cloud alike:

- Cloudflare can refuse the upload of a Worker that binds to the stack's log pipelines ("Pipeline
  binding error"). Any such upload can meet it: one that turns telemetry on, seconds after the
  pipelines were made, and an everyday deploy on pipelines that are hours old. The deploy is
  then tried again after a wait, seven times at most, with one line for each try. What it made
  stays, so a new try uploads only the Workers that did not go. A deploy that still fails then
  fails: it never goes on with telemetry off.
- R2 keeps a data catalog's tables when the catalog is turned off, and a new sink refuses a
  table that exists. So a deploy that turned telemetry off drops the stack's three tables after
  Alchemy has ended (`src/telemetry-tables.ts`, the same step as after a destroy), and prints a
  line for each.
- A deploy with telemetry on looks first for a table of the stack's that no sink writes: one
  left from an earlier turn-off or from a deploy that failed. It names each and drops it.
  A table whose sink is there stays.

**A table with no sink goes with its rows.** That state is also the one between a sink's delete
and its new making: a sink that Alchemy replaces, a turn-on that failed part-way. The table may
then hold the stack's telemetry history, and the step drops it. That is the price of a turn-on
that works at all: nothing can write such a table again. The line that names the table says that
its rows go.

**The step never empties the stack's bucket.** To reach the tables of a catalog whose bucket is
gone, the step makes the bucket for a moment, with a mark in it, and removes it again. When it
cannot remove it, the deploy does not start: Alchemy, with `--adopt`, would take that bucket as
the stack's own, the mark in it too. The next deploy removes the bucket first. And at a deploy
the mark alone does not make a bucket the step's: a bucket that a sink of the stack writes to,
or that holds table rows, is the stack's, and nothing in it goes.

`scripts/telemetry-toggle-proof.ts --stage <name>` proves it on a prototype stack: four deploys
(off, on, off, on), and after each what the account shows. **It needs a token that may make API
tokens** (Account API Tokens Edit): a turn-off deletes the stack's two account tokens and a
turn-on makes them again. The dev account's deploy token may not; the account has a second token
that may (`docs/api-keys.md`). The proof turns only a stack whose domain is in its list of
prototypes. The stack smoke gate (`docs/testing.md`) runs it in every run, on the stack it holds.

## The mind's Cloudflare token

`cloudflareToken: true` in the config adds one API token of the account,
`iterate-<name>-cloudflare`, for the mind itself, so that its agents debug, profile and
configure what the account runs, through Cloudflare's MCP server.

**The rule: the account is the mind's sandbox.** The token reads the account and its zones. It
writes the Workers platform (scripts, their settings, versions and deployments, Durable Objects,
containers, D1, KV, R2, queues, AI Gateway, Workers AI, Browser Rendering, observability and
pipelines) and the zones' DNS records, Workers routes and settings. It reaches nothing beyond the
account and changes nobody's access: no API token, member, billing, registrar or zone write. A
few reads of other products' secrets stay out. `src/cloudflare-token.ts` has the lists;
`src/cloudflare-token.test.ts` holds them against the catalog of permission groups that Alchemy
ships. **Every member and agent of the mind can use it**, as any secret of the mind.

**A group that Cloudflare refuses is dropped at that deploy.** A token that a person's OAuth
sign-in makes (iterate Cloud's run) may hold only the groups the sign-in's scopes cover, and
Cloudflare refuses the whole token for one more, naming one policy's refused groups per try.
The stack's provider (`mindCloudflareTokenProvider`) then makes the token without them, at most
four tries, and the deploy's output has one line,
`[MindCloudflareToken] Cloudflare refused <n> permission groups …: <names>`. The stack keeps
the list it asked for, so a later deploy does not ask again until a release changes the list.

Its value stays in the stack's state, as the telemetry tokens' do, and **Account API Tokens Edit
is needed** by the same deploys: the one that makes the token, a `destroy` or a deploy without
the field (each deletes it), and a deploy of a version that changes what the token may do.
`ITERATE_KEEP_CLOUDFLARE_TOKEN=1` says that the deploy's access may not change API tokens: a
token that exists then stays as it is, whatever the version (iterate Cloud sets it for an
Update without that scope). Any other deploy asks Cloudflare nothing about it.

**A second token can make the tokens.** Cloudflare refuses Account API Tokens Edit to a token
that another token made ("sub-token is not allowed to have permissions to manage other tokens").
When the environment has `CLOUDFLARE_API_TOKEN_MAKES_TOKENS`, the deploy makes, reads, changes
and deletes every account API token of the stack (this one and the two telemetry tokens) with it,
and everything else with `CLOUDFLARE_API_TOKEN` (`withCloudflareToken`). So the second token,
made by a person, may hold Account API Tokens Edit alone. Without the variable, the deploy uses
`CLOUDFLARE_API_TOKEN` for all.

**The mind keeps the token in its vault.** The stack binds the token to the mind Worker, and at
the root's first wake after a deploy the mind stores it at `/secrets/cloudflare`, pinned to
`https://api.cloudflare.com` and `https://mcp.cloudflare.com`
(`core/mind-worker/src/context/cloudflare-token.ts`). The mind's code uses it as any secret, with
a placeholder, and never sees its value. A secret that somebody else put at that path is left as
it is. A deploy without the field deletes the token at Cloudflare, and the mind then deletes what
it stored. A provided mind may not ask for the token: its stack has no mind Worker.

## Services: Workers of the account that the mind calls

`services` in the config binds Workers of the stack's own account to the mind Worker, and the
mind's code calls each one as `itx.services.<name>.<method>(...args)`:

```ts
services: [{ name: "cloud", worker: "iterate-cloud-prd", entrypoint: "Service", description: "installs minds" }],
```

Each becomes a service binding `SERVICE_<name>` to that Worker's `WorkerEntrypoint` class
(`entrypoint`, or the default export), and `SERVICES` lists them. The call is Workers RPC:
`<method>(caller, ...args)`, where `caller` is the platform's word of who calls (iterate/principal
`ServiceCaller`: the mind's domain, the calling context's path, the method, and the person behind
the call, when there is one). The service reads it with `serviceCallerOf(caller)`.

- **The trust rests on the account.** A service binding resolves in the deploying account alone,
  so only a Worker of that account reaches the service this way. Any Worker of the account that
  binds it can send any `caller`: the account is the boundary, not the mind.
- **The Worker must exist first.** Cloudflare refuses the deploy of a binding to a Worker its
  account has not got. A service that a deploy bound and that was deleted after fails the call.
- **Codes:** a name the config does not bind answers `NO_SERVICE`, a method the entrypoint has
  not got `NOT_A_METHOD`, a service's own coded error keeps its `code`, and a call with no
  answer in ten minutes `TIMEOUT`.
- The services are public fields of the stored config: no secret goes in one. A provided mind
  has no mind Worker, and may not name any.

## A provided mind

A stack's mind can run on a machine of your own: the same mind Worker, in local workerd
(`core/home-lab`). The stack then deploys no mind Worker, no Artifacts namespace and no
bucket. The boundary serves `https://iterate.<zone>/provide`, where the home lab dials in with a
token the auth Worker issued for that URL, provides the mind, and gets the boundary's door back.
The boundary forwards to it every request that is not the issuer's or the secrets pages', and
inbound mail.
With nothing connected, the mind's hostnames answer 503.

**After a deploy that changes the boundary, restart the mind at home.** A deploy does not move
an open socket: the home lab's connection stays with the boundary instance that accepted it, and
that instance runs the code from before the deploy, until the socket ends (the mind's restart, or
the end of its token's hour). The other Workers of the stack change at once.

To deploy one beside a Worker stack, on a second zone, with a second config file:

1. Copy `mind.config.local.ts` to `mind.config.home.local.ts` (git ignores it). Give it
   another `name` and `domain`, and set `mind: { provided: true }`.
2. From `core/alchemy`, with that name as the stage:

   ```sh
   ITERATE_MIND_CONFIG=mind.config.home.local.ts pnpm run deploy --stage <name>
   pnpm smoke <zone>               # a 426 at /provide says the stack is provided
   ```

3. On your machine, `node src/main.ts <zone>` in `core/home-lab` (its README), and sign in when
   it asks. Then run the smoke check again (`scripts/smoke/home-lab.ts`): the apex answers, and
   with `ITERATE_PROTOTYPE_TOKEN` set, the birth's facts, a config commit republishing, a secret
   used through the stack's door with its facts at home, and a sandbox's `echo`.

At home, the repos are git on that machine and the sandboxes run in its Docker. Workers AI,
Browser Run and Images have no local form, so those roots refuse there.
