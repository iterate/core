# Self-hosting iterate

One Cloudflare Worker is the whole platform: the sign-in and consent pages, the OAuth server,
`/api`, `/mcp`, and the Durable Objects your projects live in. It deploys into your own Cloudflare
account; no domain is needed.

Setting it up is a recipe for your coding agent, [`public/setup-prompt.md`](public/setup-prompt.md),
served at https://os.iterate.com/setup-prompt.md. Tell Claude Code, Codex or opencode:

> follow https://os.iterate.com/setup-prompt.md to set up self-hosted iterate

From an empty folder it deploys into the Cloudflare account you pick, creates your first project,
checks it, connects itself over MCP, and hands you the dash, voice and kit links. Its requirements
are at the top: Workers Paid (which brings Cloudflare Artifacts, in open beta) and R2. You can follow
it by hand too. This page is the reference for what it does.

## Deploy

[Alchemy](https://alchemy.run) deploys the platform. Clone and install, then work in `core/os`:

```sh
git clone https://github.com/iterate/core iterate && cd iterate
pnpm install
cd core/os
# write iterate.config.local.ts and .secrets ("The config"), and make the Artifacts namespace once
pnpm run deploy        # the build, then Alchemy's plan; it asks before it applies
```

`pnpm run deploy --yes` applies without asking. To update: `git pull`, `pnpm install`,
`pnpm run deploy`. The other commands act on the same deployment:

```sh
pnpm build && pnpm alchemy plan   # what a deploy would change; it changes nothing
pnpm build && pnpm alchemy dev    # deploy, then deploy again on each change
pnpm alchemy logs --tail          # the Worker's logs as they arrive; without --tail, the last hour's
pnpm alchemy destroy              # delete the deployment ("Destroy")
```

`alchemy dev` deploys the Worker your people use, again on each change to a module that
`alchemy.run.ts` imports (its header says what reloads it). Ctrl-C stops it; the Worker keeps its
last deploy. The package scripts `deploy`, `alchemy` and `images` load `core/os/.secrets` first; a
variable already in the environment keeps its value. Each command acts on one stage, Alchemy's name
for one deployment, which must be the Worker's name (`cloudflare.workerName`, else
`resourcePrefix`): `ALCHEMY_STAGE` in `.secrets` names it, or `--stage <worker>`.

A deployment last deployed from iterate/core before 2026-10-05 still has empty Durable Object
namespaces for eight old classes: `AccountDurableObject`, `EmailDurableObject`,
`InstanceDurableObject`, `OrganizationDurableObject`, `ProjectDurableObject`, `RepoDurableObject`,
`SecretDurableObject` and `WorkspaceDurableObject`. Cloudflare refuses a deploy that drops them
without a tombstone. Deploy once from the last commit that has their tombstones, which deletes
them, then deploy the latest:

```sh
git checkout "$(git log -1 --format=%H -S RETIRED_FACET_CLASSES -- core/os/cloudflare.config.ts)~1"
pnpm install && pnpm run deploy
git checkout main && pnpm install && pnpm run deploy
```

### The API token

One token, the config's `cloudflare.apiToken` (`ITERATE__CLOUDFLARE__API_TOKEN` in `.secrets`): the
deploy runs with it, and the Worker keeps it for what it does on the account at runtime (a project's
custom hostnames). A second token scoped to the runtime's permissions alone would be safer, and is
work for later. Make it at https://dash.cloudflare.com/profile/api-tokens (**Create Custom Token**),
with your account under **Account Resources** and these permissions:

| Permission                      | Level | For                                                           |
| ------------------------------- | ----- | ------------------------------------------------------------- |
| Account · Workers Scripts       | Edit  | the Worker, its Durable Objects, its workers.dev URL          |
| Account · Workers KV Storage    | Edit  | the two KV namespaces                                         |
| Account · Workers R2 Storage    | Edit  | the files bucket                                              |
| Account · D1                    | Edit  | the control plane's database                                  |
| Account · Containers            | Edit  | the sandboxes' containers, and `pnpm run images`              |
| Account · Artifacts             | Edit  | the repos' namespace                                          |
| Account · Workers Tail          | Read  | `alchemy logs --tail`                                         |
| Account · Workers Observability | Read  | `alchemy logs`                                                |
| Zone · Workers Routes           | Edit  | a custom domain: its zone                                     |
| Zone · SSL and Certificates     | Edit  | projects' custom hostnames (`customHostnames`): the SaaS zone |
| Account · Secrets Store         | Edit  | `ITERATE_STATE_STORE=cloudflare`                              |

### State

Alchemy records what it made, with each resource's id, in a state store. By default that is
`core/os/.alchemy/`: plain JSON that holds every secret's value, as `.secrets` does. Git ignores
it; never commit it, and keep it beside `.secrets`, because a destroy deletes only what the state
names. Alchemy writes its files readable by every user of the machine, so make the folder private
before the first deploy: `mkdir -m 700 .alchemy` in `core/os` (`chmod -R go-rwx .alchemy` for
one that exists). With `ITERATE_STATE_STORE=cloudflare` the state lives in your account instead, in
Alchemy's state store (the Worker `alchemy-state-store`, its key in the account's Secrets Store),
so CI or a second machine can deploy too. The first deploy offers to make the store, and `--yes`
makes it without asking. Choose the store before the first deploy and keep it: the two share
nothing.

## The config

One object configures a deployment, the iterate config
([`src/iterate-config.ts`](src/iterate-config.ts) documents every field and its default). Its
`cloudflare` section says where the Worker deploys: the account, the prefix of the resources it
binds by name, the Worker's name and routes. Every other field says what the Worker does: its URLs,
sign-in, admins, integrations and keys. A field you leave out takes its default.

`pnpm run deploy` reads it from one of two files in `core/os/`:

- [`iterate.config.ts`](iterate.config.ts), committed, reads it from the environment. `ITERATE` is
  the whole object as JSON. Any one field can also be set alone, `__` before each part of its path
  (`ITERATE__URLS__OS`, `ITERATE__SECRETS_ENCRYPTION__KEY`), and wins over the object.
- `iterate.config.local.ts`, gitignored, is used instead when it exists. It is yours: it imports
  `iterate.config.ts` and overrides what you need, with types.

Any field goes in either place, and the file's value wins. Keep each secret a variable of its own,
in `core/os/.secrets` (gitignored, `NAME=value` lines) or your secrets manager, not in a file you
may share.

```ts
// core/os/iterate.config.local.ts
import type { IterateConfigInput } from "./src/iterate-config.ts";
import base from "./iterate.config.ts";

export default {
  ...base,
  cloudflare: { accountId: "<your Cloudflare account id>", resourcePrefix: "iterate" },
  login: { ...base.login, allow: [{ email: "you@example.com" }] },
} satisfies IterateConfigInput;
```

```sh
# core/os/.secrets (chmod 600)
ITERATE__CLOUDFLARE__API_TOKEN=<the token>
ALCHEMY_STAGE=iterate
# without it, Alchemy's CLI sends each command's traces, metrics and logs to otel.alchemy.run
DO_NOT_TRACK=1
ITERATE__SECRETS_ENCRYPTION__KEY=<openssl rand -hex 32>
ITERATE__ADMIN_BEARER=<openssl rand -hex 32>
ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD=<openssl rand -base64 18>
```

A section the file sets replaces the environment's whole: spread `base.<section>` into it to keep
the environment's fields, as `login` does above to keep the password. Without
`iterate.config.local.ts`, any secrets manager that injects environment variables works:
`doppler run -- pnpm run deploy`, `infisical run -- …`, `op run --env-file=.env.op -- …`.

Of the other `cloudflare` fields, `d1Location` is fixed when the D1 is made (a change replaces it
with an empty one), and `protectData: true` keeps the data through a destroy ("Destroy").

The key, `secretsEncryption.key`, encrypts every project secret. Losing it loses them, and changing it
signs everyone out. Keep `core/os/.secrets`, or your secrets manager's copy: it is the only one.

## What the deploy does

`pnpm run deploy` runs `scripts/build.ts` (the generated modules, then Vite's build of the Worker
into `.cloudflare/output/`), then `alchemy deploy` over `alchemy.run.ts`:

1. It parses the config as the Worker will: a malformed field fails the deploy, naming itself, and
   a key the schema does not name is warned about and left out.
2. `core/deployer/src/stack.ts` declares the deployment. It refuses a stage that is not the Worker's name,
   and credentials for an account other than `cloudflare.accountId`.
3. Alchemy compares the declaration with the state, prints each resource's action (create, update,
   replace, delete or noop), and asks. `pnpm alchemy plan` stops here.
4. It applies: the D1 `<prefix>-db`, migrated before the Worker that binds it uploads; the KV
   namespaces, by title; the R2 bucket `<prefix>-files`; the sandboxes' container application
   `<worker>-sandbox`; and the Worker with its Durable Objects, routes and bindings. It prints the
   Worker's URL.
5. Each field the schema marks secret becomes a Worker secret named by its path
   (`ITERATE__INTEGRATIONS__GITHUB__OAUTH_CLIENT_SECRET`), with the config's value; the rest
   becomes the plain var `ITERATE`, which the dashboard shows. The Worker merges them back. No value
   is printed or put on a command line, and a secret the config stops setting leaves the Worker.

A second deploy with nothing changed plans every resource as `noop`.

## The Artifacts namespace

Every project's code lives in an Artifacts git repo, in the namespace `<prefix>-repos`. The Worker
binds it, but neither the deploy nor a repo create makes it: a project's creation fails until it
exists. Make it once, before the first project (here for `resourcePrefix: "iterate"`):

```sh
(set -a && . ./.secrets && curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/artifacts/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"namespace":"iterate-repos"}')
```

It answers `"success":true`, or 409 with code 10201 when the namespace exists.

## The sandbox image

A sandbox starts from `iterate-dev-image` (`images/iterate-dev-image/Dockerfile`): Node 24 on Debian with
git, gh, Chromium, ffmpeg, pnpm, the Claude, Codex and Grok CLIs, `cf`, doppler, the iterate CLI and a
clone of `iterate/core`. An image changes only when you ask. `pnpm run images` (Docker, `linux/amd64`)
builds each `images/<name>/` once, pushes it to your account's registry
(`registry.cloudflare.com/<account>/<name>`), has Cloudflare prepare it, and writes the digest it pins to
`images/<name>/digest`: commit that file. `pnpm run deploy` only reads the pins: no registry call, no
build, no time, and it gives the container the digest-pinned reference of each pinned image, so a
deployment runs the image it was deployed with. Editing the Dockerfile changes nothing until
`pnpm run images` runs again; `pnpm run images --check` builds nothing and fails when your registry does
not hold a pinned digest. With no image pinned, sandboxes start Cloudflare's managed
`cloudflare/debian-trixie` (Node 24; no git, curl or Chromium). The first start of a new image on a
Cloudflare host pulls it (up to about 30 seconds); later starts take about a second.

## Project apps

`https://<worker>.<your-subdomain>.workers.dev/projects/<project>/<routingSlug>/`, and
`/projects/<project>/` for the project's own config worker (`urls.ingressRouting`, by default
`{ "type": "paths" }`).

With no domain, every project's code runs on the platform's own origin. An app's code can do
anything the person visiting it can do on the deployment, in every project they reach, including
minting tokens that outlive the visit. Paths routing is for a deployment whose people all trust each
other. Apps are public unless their router marks a path private, exactly as with a domain: a private
path sends a visitor to the platform's sign-in and back. Signed file URLs
(`/projects/<project>/files/…`) work for anyone holding one, and are served sandboxed so a file
can never act as whoever opens it.

For apps on an origin of their own, or people who don't all trust each other, give the deployment
a [custom domain](#custom-domain-own-origins-for-apps-and-tunnels).

## Sign-in

`login.methods` lists the ways people sign in, in the sign-in page's order. `login.allow`
(required) and `login.deny` say who may, in rules that mirror Cloudflare Access's:
`{ "email": "a@b.com" }`, `{ "emailDomain": "b.com" }` (that domain exactly) or `{ "everyone": {} }`.

- `password: { password }` (secret: `ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD`), the self-host
  default: one password for everyone, the email only a name tag. It needs no domain and no
  dashboard step. It suits people who share one password: whoever has it signs in as any address
  `login.allow` admits.
- `emailCode: { from }`: a mailed code from an address on a domain onboarded for Email Sending.
  Each person proves their own address.
- `google: {}`, `github: {}`, `cloudflare: {}` (or `{ scopes }`): sign-in with that provider's
  integration client, which the person's connection then uses too. `integrations.cloudflare` takes
  `{ oauthClientId, oauthClientSecret }` from your own OAuth client; register
  `<your-origin>/.auth/identity/cloudflare/callback` and
  `<your-origin>/api/integrations/cloudflare/callback`, and configure the client for
  `response_types: ["code", "id_token"]` and the `user-details.read` scope.
- `cloudflareAccess: { teamDomain, aud }`: Cloudflare Access mails a one-time code, so no password
  and no mail domain. Each person who signs in takes one Zero Trust seat. You make its Access
  application by hand: Alchemy's has no setting that keeps the `CF_Authorization` cookie on the
  sign-in path, and without it the cookie reaches every path of the host, where paths routing
  serves projects' own code. The config requires both `teamDomain` and `aud`. In the Cloudflare
  dashboard:
  1. Turn Zero Trust on for the account (the free plan is enough). Its team domain is
     `https://<team>.cloudflareaccess.com`.
  2. Add the One-time PIN login method.
  3. Add a self-hosted application on `<host>/.auth/identity/cloudflare-access` alone, where
     `<host>` is the Worker's (`<worker>.<subdomain>.workers.dev`, or `urls.os`'s). Allow the
     One-time PIN method only, turn on **Apply instant authentication**, and set the session
     duration to 24 hours.
  4. Give it one Allow policy: `login.allow`'s rules as Include, `login.deny`'s as Exclude.
  5. Under Advanced settings, Cookie settings, turn on **Cookie Path Attribute**.
  6. Set `teamDomain` to the team domain and `aud` to the application's **Application Audience
     (AUD) Tag**, then deploy.

## Integrations

An integration is a package the project hosts
([jonastemplestein/iterategrations](https://github.com/jonastemplestein/iterategrations): a
Telegram bot, your own GitHub App, Monzo, Pebble, and more, one folder each with a recipe for a
coding agent). Adding one is a dependency of the project's config repo and one element of the
`integrations` array in its `worker.ts`. The package serves its own setup page and webhook on the
project's host (`<slug>--<project>.<your-domain>`, or `<origin>/projects/<project>/<slug>/` without
a domain) and registers itself with the Dash's Integrations page, which shows its card, its
connections and a button to each page. No provider has to live in the deployment for that, so a
self-host connects to anything the hosted platform does.

The deployment's own apps at providers (`integrations.<provider>` in the config: Slack, Google,
Cloudflare, GitHub, X) are what iterate's hosted platform holds so a project connects with one
click; a self-host usually has none, and needs none. Signing in with Google, Cloudflare or GitHub
does need that provider's app in the config as `integrations.<provider>` (the keys are in
`src/iterate-config.ts`), registered with `<origin>/.auth/identity/callback` (Google),
`<origin>/.auth/identity/cloudflare/callback` (Cloudflare) or
`<origin>/.auth/identity/github/callback` (GitHub) for sign-in, and
`<origin>/api/integrations/<provider>/callback` for connecting. The Dash shows a provider's
one-click connect only when the deployment has its app.

Your own OAuth app at any service, with no package: `itx.secrets.beginOAuth` with the client in
the clear ([connect-a-service.md](public/connect-a-service.md), the recipe a coding agent follows).
Its redirect URI is `<origin>/.secrets/oauth/callback`, or a page of the project's own when the
call names `redirect` (a routing slug and a path of the project's).

## Custom domain: own origins for apps and tunnels

With a domain, each project app gets an origin of its own, `<routingSlug>--<project>.<your-domain>`,
and the project's config worker answers at `<project>.<your-domain>`. The platform's sign-in stays
on `os.<your-domain>`, out of the apps' reach. Apps can be public, a dev server can serve at `/`,
and `iterate tunnel` works private or `--public`, at the root of its own origin.

What it takes:

1. **The zone** for `<your-domain>` on the same Cloudflare account as the Worker, and the token's
   Zone · Workers Routes · Edit on it.
2. **Your routes in `cloudflare.workerRoutes`**:
   `[{"pattern":"*.<your-domain>/*","zone":"<your-domain>"}]`. The wildcard also covers
   `os.<your-domain>`. A route answers only where DNS does: make a proxied record
   `*.<your-domain>` (any target, such as AAAA `100::`) by hand. The deploy makes no DNS record.
3. **A certificate for `*.<your-domain>`.** Cloudflare's Universal SSL covers the apex and one
   wildcard level, which is why a project host is one label under `<your-domain>`:
   `<routingSlug>--<project>`, or the apex `<project>`.
4. **The URLs**: `urls.os` = `https://os.<your-domain>` and `urls.ingressRouting` =
   `{"type":"subdomains","hostname":"<your-domain>"}`.

Deploy again. `/mcp` then lives at
`https://os.<your-domain>/mcp`; reconnect your MCP client there. Keep `cloudflare.workersDev` on
while anything still uses the workers.dev origin.

A deploy makes the Worker's routes match `cloudflare.workerRoutes`: it adds the routes the list
names and deletes the Worker's routes it does not name. It refuses a route that another Worker
holds: remove the route from that Worker first.

### A project's own domain

`urls.projectHostnames: [{ "hostname": "example.org", "project": "<id or slug>" }]` gives one
project a domain of its own: `example.org` is the project's apex, and `notes.example.org` is its
`notes` app, as with a hostname the project adds itself. Name the project by its id (`prj_…`): an
entry that names its slug stops serving it when the project is renamed, so `projects.rename`
refuses to rename a project the config names by its slug. The pinned hostname is the project's
primary hostname before any it claims on the Dash: `itx.url`, the Dash's buttons, a package's OAuth
redirect and the redirect from the project's ingress hosts all go to it. Route `example.org/*` and
`*.example.org/*` on that zone to the Worker. The platform's own origin stays the platform's, even on the same zone (the
platform on `iterate.example.org`, its projects on `*.iterate.example.org`). A more specific route
on the zone wins over the wildcard, but a Custom Domain does not: give each Custom Domain on the
zone a route of its own to its Worker (`app.example.org/*`), or the wildcard takes it.

## Destroy

`pnpm alchemy destroy` deletes every resource the state names: the Worker with every Durable Object
(every project's data) and its routes, the D1, the KV namespaces, the R2 bucket (emptied first) and
the container application. It asks first, unless `--yes`. It needs no build, because it plans from
the state alone, but the config must still parse. The Artifacts namespace stays, because Alchemy
did not make it: delete its repos, then the namespace (in the dashboard: Storage & databases,
Artifacts).

With `cloudflare.protectData: true`, a destroy deletes nothing: Alchemy forgets the resources, which
keep serving and keep their data, and the next deploy takes them back (`src/iterate-config.ts`
says how). A destroy reads each resource's removal policy from the state, which only a deploy
writes: to delete a protected deployment, deploy it once with `protectData` off, then destroy it.

## Deploy from an iterate project

A project on one deployment (the host) can deploy another (the target). The project's deployment
facet (`src/deployment/`, `itx.deployments`) runs the stack that `pnpm run deploy` runs, with
Alchemy's state in the facet's own SQLite, so no machine keeps it. Nothing takes over resources that
exist without that state: give the target names nothing on the account holds, and make its
Artifacts namespace once
("The Artifacts namespace"). In the host's project, by convention:

- **The config**: the target's whole iterate config, as one JSON string with its secrets inline,
  `cloudflare.apiToken` among them ("The API token", on the target's account): the object
  `pnpm run deploy` would read from `iterate.config.ts` and `.secrets`. It is the run's input. The
  facet keeps the latest in its own storage, and its facts, log lines and errors mask every value,
  but Alchemy's state keeps the Worker's secrets in plaintext ("State"). Whoever can use the
  project can reach them: give it only to people who may deploy.
- **The release**: the build's directory (`.cloudflare/output/v0/workers/default/`: `bundle/`,
  `assets/`, and `migrations/` copied from `src/control-plane/db/`) as one zip, at
  `/releases/<sha256>.zip` in the project's files.

Create the deployment once, `itx.deployments.create("/deployments/<worker>")`, then ask for a run:
`itx.deployments.get(path).deploy({ release, config })` answers its `requestOffset`. Follow the
facts that name it on the path's log: `attempt-started`, `release-staged`, `run-planned` and
`resource-applied`, until `run-settled` says how the run ended. `DeploymentHandle` in
[`../lib/src/api.ts`](../lib/src/api.ts) documents each verb, each status and `delete`. iterate's
own tooling does all of this as `pnpm os deploy --env <name> --project <host>/<slug>`, and the
deployments playground, `packages/spa/public/deployments.html` in
[iterate/packages](https://github.com/iterate/packages), does it from a browser.

## Local development

`pnpm --dir core/os dev` (or `pnpm --dir core/os exec cf dev`) serves the platform on
`http://localhost:8788`, signed in with the password `dev`, projects under
`<project>.localhost:8788`. D1, KV and R2 stay on disk, and so does Images (an offline version
that knows `width`, `height`, `rotate` and `format` only; `text` and `draw` need a deployment); Workers AI, Browser Run and Artifacts have
no local version and reach the account set in `CLOUDFLARE_ACCOUNT_ID`, in the namespace
`os-dev-repos`. `itx.sandboxes` runs its containers in Docker (any Docker-compatible engine), so a sandbox verb needs one running; nothing else does. A deployment runs its sandboxes on Cloudflare Containers. Local dev never reads `iterate.config.local.ts` or `.secrets`: they are a
deployment's config.
