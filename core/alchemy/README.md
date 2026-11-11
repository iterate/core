# core/alchemy

The Alchemy program that deploys one project as a stack of four Workers: the boundary, the
project, the secrets Worker and the auth Worker, and a fifth with the telemetry part
(`tasks/project-stack.md` in iterate's own repository holds the record). Only the boundary is public: it takes
everything that comes in and, as the door, everything the project sends out. One config, one stage,
every resource named `iterate-<name>-<part>`. For one release the boundary keeps the name of the
Worker it replaces, `iterate-<name>-ingress` (`src/config.ts` `resourceNamesOf` says why).

## Deploy

1. Copy `project.config.example.ts` to `project.config.local.ts` (git ignores it, and
   `project.config*.local.json`). Fill in the project's `name`, the Cloudflare `accountId` and a
   zone of that account as `domain`, and under `auth` who is a member (`login.allow`) and how a
   person signs in (`login.methods`: `email`, `iterate` or both). Or name another config file in
   `ITERATE_PROJECT_CONFIG`, a module or a `.json` file. `src/config.ts` says what each field does.
2. Set `CLOUDFLARE_API_TOKEN` (the table below says what it must allow). `CLOUDFLARE_ACCOUNT_ID`
   is optional with a config file; when set, it must be the config's account.
3. From `core/alchemy`, with the project's name as the stage:

   ```sh
   pnpm run plan --stage <name>      # what a deploy would change
   pnpm run deploy --stage <name>
   pnpm smoke <zone>                 # one line per check, through the boundary
   pnpm run destroy --stage <name>
   ```

The package scripts load `core/alchemy/.secrets` when it exists (git ignores it). Until real
sign-in is proven, `ITERATE_PROTOTYPE_TOKEN=<a long random string>` there is a stand-in for it: the
deploy binds it to the auth Worker, which answers one prototype identity for exactly that token, and
the smoke check then also checks the project's API on `api.<zone>`.

## The stored config

Each deploy that succeeds keeps its config in the stack's state store, `iterate-<name>-state` in
the project's own account, as the stack's output (`project/<name>/output`), in place of the one
before. A checkout with no config file, such as a fork's, deploys the stack from it with only the
account's credentials:

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm run deploy --stage <name>
pnpm run config --stage <name> > project.config.local.json   # the stored config, JSON alone
ITERATE_PROJECT_CONFIG=project.config.local.json pnpm run deploy --stage <name>   # changed
```

The stored config holds no secret: the keys are in Alchemy's state. A config with a field that
`src/config.ts` `PUBLIC_FIELDS` does not list is refused before the deploy, so a new field is
stored only once it is shown to be public.

## One hostname of a zone

`hostnames: "platform"` is for a zone that serves other things. The stack then makes the DNS record
and the route for `iterate.<zone>` alone: no apex or wildcard, no mail routing and no Email
Sending. The project Worker still runs, and its own site has no hostname. `mail: true` and the
mailed sign-in code are refused with it. Smoke it with `pnpm smoke <zone> worker platform`, which
skips, by name, the checks of the apex, the subdomains and mail.

## Signing in

The auth Worker is the project's OAuth authorization server, at `https://iterate.<zone>`. Clients
find it from the protected-resource documents the boundary serves for the API
(`https://iterate.<zone>/.well-known/oauth-protected-resource/api`) and the MCP server, and read its
endpoints from `https://iterate.<zone>/.well-known/oauth-authorization-server`. Anyone may sign in;
a token for the API, the MCP server or `/provide` goes to a member alone (`login.allow`). Two ways
to prove an address, one or both:

- `email: {}`, a mailed code: six digits from `sign-in@<zone>` through the stack's own boundary,
  so the stack depends on nobody. The config must have its `email` part, or the deploy is refused.
  A code goes only to an address that an `email` or `emailDomain` rule of `allow` names. With
  `email: { anyone: true }` any other address that asks is mailed too, at most 20 such codes an
  hour for the whole stack: use it when people who are not members sign in to the project's pages.
- `iterate: { issuer }`, log in with iterate: the issuer must accept this Worker as a client by its
  metadata document, `https://iterate.<zone>/sign-in/iterate/client.json`.

A member signs in with a passkey, and with nothing else. Every stack's sign-in page has "Sign in
with a passkey": one the member added on `https://iterate.<zone>/keys`. It signs in the member
whose key it is, while that address is a member and the key is not removed, and the passkey must
verify its user (a PIN, a fingerprint or a face). Its session on `iterate.<zone>` ends when that
passkey is removed. The grants that session gave do not: an app or a CLI it signed in stays so
until its grant ends, or until an owner removes the member's keys.

A code or the upstream proves an address and no more. For a member who holds no passkey, it opens
a session that does one thing: it adds the first passkey on `/keys`, and every other page sends
the member there. That passkey makes the session a member's, and the page then asks for a second
passkey. For a member who holds a passkey, a code or the upstream is refused: mail is no way round
a passkey. Someone who is no member signs in by a code or the upstream as before, and gets
nothing but an identity on the project's own pages.

Who may act grows only by a signature (`core/auth/src/signed-change.ts`). To add a member, and to
add a further passkey for a person who holds one, each takes a statement that a member's key
signed: on `/members` and `/keys` the person's passkey signs it, and a script sends
`{ statement, signature }` to `POST /members`. A session's cookie or a member's token does neither,
so whoever steals one adds no one. To remove a member or a key takes no signature. A new passkey
is made on another device than the one that signs it: no device holds two passkeys of one person.
Two ways in sign nothing: a person's first passkey, after a mailed code or the upstream, and the
passkey the owner's ticket adds.

A rule of `allow` that names no exact address (`subaddresses`, `emailDomain`, `everyone`) admits
addresses nobody named. Each one is a member with no passkey until it adds one, so whoever reads
its mail gets a passkey that approves requests and adds members. A stack that approves things
names each member by the exact address.

A lost passkey has two ways back in, and neither is mail:

- A member who is no owner asks an owner. An owner is a member an `email` rule of `allow` names.
  On `/members` the owner removes that member's keys, which also ends every grant the member
  gave (the apps, the CLI, a project hostname's session). A code then signs the member in once,
  to add a new passkey.
- An owner runs a deploy with a first owner's ticket. `node scripts/first-owner-ticket.ts
  <address>` prints a ticket and a variable. Deploy with `ITERATE_FIRST_OWNER_TICKET=<variable>`,
  then open `https://iterate.<zone>/keys/first#<ticket>`. The ticket signs in that one owner, once
  and within 15 minutes, on a new stack and on one with users and keys alike. Its session lasts 15
  minutes and opens `/keys` alone: the passkey added there makes it that passkey's session, which
  then removes the lost ones. So whoever can deploy to the Cloudflare account is the root of the
  stack's sign-in. The auth Worker holds the ticket's hash alone, and the next deploy without the
  variable removes that.

A new stack's owner gets the first passkey the same way: by the ticket of the first deploy, or,
when its 15 minutes are over, by a code.

A client whose metadata document and redirect are on an origin in `auth.trustedClients` gets no
consent page.

State is in the account, in the state-store Worker `iterate-<name>-state`, which the project owns.
`ITERATE_STATE_STORE=local` keeps it in `.alchemy/` instead (git-ignored), with the generated keys in
clear: for a throwaway stack only.

The zone's mail becomes the project's: the stack turns Email Routing on and takes its catch-all
rule, and a `destroy` turns Email Routing off for the whole zone.

## The API token

A custom token at https://dash.cloudflare.com/profile/api-tokens, for the project's account and
its zone, with these permissions. Derived from what the stack declares; not yet proven as the
least a deploy needs.

| Permission                      | Level | For                                               |
| ------------------------------- | ----- | ------------------------------------------------- |
| Account · Workers Scripts       | Edit  | the Workers and their Durable Objects             |
| Account · Workers KV Storage    | Edit  | the project's and the auth Worker's KV namespaces |
| Account · Workers R2 Storage    | Edit  | the files bucket                                  |
| Account · D1                    | Edit  | the auth Worker's database of people              |
| Account · Containers            | Edit  | the sandboxes' container and its image            |
| Account · Artifacts             | Edit  | the repos' namespace                              |
| Account · Workers AI            | Read  | `itx.ai`, through the account's AI Gateway        |
| Account · AI Gateway            | Edit  | the gateway `default`                             |
| Account · Browser Rendering     | Edit  | `itx.browser`                                     |
| Account · Email Sending         | Edit  | mail out, the sign-in code among it               |
| Account · Secrets Store         | Edit  | the state store's key                             |
| Account · Workers Observability | Read  | reading the Workers' logs                         |
| Zone · Zone                     | Read  | finding the zone by its name                      |
| Zone · Workers Routes           | Edit  | the boundary's routes on the zone                 |
| Zone · DNS                      | Edit  | the apex and wildcard records, and mail's         |
| Zone · Email Routing Rules      | Edit  | mail in: the catch-all rule to the boundary       |

## What a deploy makes

- Two generated keys, kept in Alchemy's state: the secrets Worker's at-rest key and the auth
  Worker's signing key. Each is bound to its Worker as a secret. A stack that holds values sealed
  under a key from elsewhere says `atRestKey: "environment"`, and then
  every deploy needs `ITERATE_SECRETS_AT_REST_KEY`: one without it is refused.
- The auth Worker's D1 database of people, `iterate-<name>-auth-db`, migrated from
  `core/auth/migrations`, and its KV namespace for the OAuth library, `iterate-<name>-auth-kv`.
- The four Workers. Only the boundary has routes: `<zone>/*` and `*.<zone>/*`, or with
  `hostnames: "platform"` `iterate.<zone>/*` alone.
- Proxied `AAAA 100::` records for the apex and `*` (or `iterate` alone), so the routes receive
  traffic. A record that already exists is not taken over: remove it, or deploy with `--adopt`.
- With `mail: true` in the config: Email Routing on the zone, its catch-all rule delivering to the
  boundary, and Email Sending on the domain, which the boundary sends with.
- The sandboxes' image, `images/iterate-dev-image` of `core/project`, built with the local Docker and
  pushed. A deploy from a machine with no Docker sets `sandboxImage: "managed"` in the config's
  `project`: the stack declares no image, and a sandbox starts Cloudflare's managed image.

## Telemetry

`telemetry: true` in the config adds the warehouse of `docs/telemetry.md` to the
stack, in the project's own account (`core/telemetry`). Without it, a stack runs as before, and the
project has no `itx.telemetry`, so the Dash's Analytics page says it is not served.

What a deploy makes with it:

- The telemetry Worker, `iterate-<name>-telemetry`, on its workers.dev address, where Cloudflare's
  export posts with a generated secret. Its `Telemetry` entrypoint takes the project's query,
  events and metrics from the boundary's door. It alone holds the warehouse's tokens.

  That address is the one thing of a stack, besides the boundary, that the internet reaches.
  It cannot move behind the boundary: Cloudflare refuses to change a destination's URL once it is
  made, and tests the URL with a POST on every other update, while the boundary, the project and
  the auth Worker deploy after the destinations, which their `observability` names.

- The R2 bucket `iterate-<name>-telemetry` with its Iceberg catalog (compaction, snapshots kept a
  day), and for each of `events`, `logs` and `spans` a stream, a Parquet sink and a pipeline.
- Two account-owned API tokens: the catalog token (R2 Data Catalog Write; the bucket's item write
  and SQL read), and the analytics token (Account Analytics Read), which reads `metrics`.
- The Analytics Engine dataset `iterate_<name>_metrics`, which the project Worker writes.
- Two observability destinations, traces and logs, named by every other Worker of the stack.
- At every context's birth, the `platform` row that sends its events to `events`.

The project reads its own Workers' logs and spans (project, boundary) whole. Of the vault and auth
it reads no log line, and their spans with the text columns empty. No Cloudflare
alert is set for a destination it disables.

The token above also needs: Account · Pipelines Edit, Account · Workers R2 Data Catalog Edit,
Account · Workers Observability Edit (the destinations; in place of Read), and Account · Account
API Tokens Edit (the two tokens). Resources: one Worker, one bucket, three streams, sinks and
pipelines, one dataset and two destinations; the stack's other Workers write every log line and
span twice, to Cloudflare and to the warehouse. Pipelines, R2 and R2 SQL bill by what is written,
stored and scanned.

## A provided project

A stack's project can run on a machine of your own: the same project Worker, in local workerd
(`core/home-lab`). The stack then deploys no project Worker, no Artifacts namespace and no
bucket. The boundary serves `https://iterate.<zone>/provide`, where the home lab dials in with a
token the auth Worker issued for that URL, provides the project, and gets the boundary's door back.
The boundary forwards to it every request that is not the issuer's, the secrets pages' or the
telemetry intake's, and inbound mail.
With nothing connected, the project's hostnames answer 503.

To deploy one beside a Worker stack, on a second zone, with a second config file:

1. Copy `project.config.local.ts` to `project.config.home.local.ts` (git ignores it). Give it
   another `name` and `domain`, and set `project: { provided: true }`.
2. From `core/alchemy`, with that name as the stage:

   ```sh
   ITERATE_PROJECT_CONFIG=project.config.home.local.ts pnpm run deploy --stage <name>
   pnpm smoke <zone>               # a 426 at /provide says the stack is provided
   ```

3. On your machine, `node src/main.ts <zone>` in `core/home-lab` (its README), and sign in when
   it asks. Then run the smoke check again (`scripts/smoke/home-lab.ts`): the apex answers, and
   with `ITERATE_PROTOTYPE_TOKEN` set, the birth's facts, a config commit republishing, a secret
   used through the stack's door with its facts at home, and a sandbox's `echo`.

At home, the repos are git on that machine and the sandboxes run in its Docker. Workers AI,
Browser Run and Images have no local form, so those roots refuse there.
