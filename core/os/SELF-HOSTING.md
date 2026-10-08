# Self-hosting Iterate

One Cloudflare Worker is the whole platform: the sign-in and consent pages, the OAuth server,
`/api`, `/mcp`, and the Durable Objects your projects live in. It deploys into your own Cloudflare
account; no domain is needed.

Setting it up is a recipe for your coding agent, [`public/setup-prompt.md`](public/setup-prompt.md),
served at https://os.iterate.com/setup-prompt.md. Tell Claude Code, Codex or opencode:

> follow https://os.iterate.com/setup-prompt.md to set up self-hosted iterate

From an empty folder it deploys into the Cloudflare account you pick, creates your first project,
checks it, connects itself over MCP, and hands you the dash, voice and kit links. Its requirements
are at the top: Workers Paid, R2, and access to Cloudflare Artifacts (a closed beta). You can follow
it by hand too. This page is the reference for what it does.

## Deploy

```sh
git clone https://github.com/iterate/core iterate && cd iterate
pnpm install
pnpm --dir core/os exec cf auth login   # or set CLOUDFLARE_API_TOKEN
# write your config: core/os/iterate.config.local.ts and core/os/.secrets ("The config")
pnpm run deploy
```

Use the project's own `cf` (`pnpm --dir core/os exec cf …`): a `cf` installed globally may be
older. To update: `git pull`, `pnpm install`, `pnpm run deploy`.

`pnpm run deploy --check` builds and checks everything and runs `cf deploy --dry-run`. Nothing on
the account changes.

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

## The config

One object configures a deployment, the iterate config
([`src/iterate-config.ts`](src/iterate-config.ts) documents every field and its default). Its
`cloudflare` section says where the Worker deploys: the account, the prefix of the resources it
binds by name, the Worker's name and routes. Every other field says what the Worker does: its URLs,
sign-in, admins, integrations and keys. A field you leave out takes its default.

`pnpm run deploy` reads it from one of two files in `core/os/`:

- [`iterate.config.ts`](iterate.config.ts), committed, reads it from the environment. `ITERATE` is
  the whole object as JSON. Any one field can also be set alone, `__` before each part of its path
  (`ITERATE__URLS__OS`, `ITERATE__SECRETS_ENCRYPTION__KEY`), and wins over the object. `pnpm run deploy`
  loads `core/os/.secrets` (gitignored, `NAME=value` lines) when it exists; a variable already in
  the environment keeps its value.
- `iterate.config.local.ts`, gitignored, is used instead when it exists. It is yours: it imports
  `iterate.config.ts` and overrides what you need, with types.

A self-host usually has both: the non-secret values in `iterate.config.local.ts`, the secrets in
`.secrets` by their variable names.

```ts
// core/os/iterate.config.local.ts
import type { IterateConfigInput } from "./src/iterate-config.ts";
import base from "./iterate.config.ts";

export default {
  ...base,
  cloudflare: { accountId: "<your Cloudflare account id>", resourcePrefix: "iterate" },
  login: { methods: { cloudflareAccess: {} }, allow: [{ email: "you@example.com" }] },
} satisfies IterateConfigInput;
```

```sh
# core/os/.secrets (chmod 600)
ITERATE__SECRETS_ENCRYPTION__KEY=<openssl rand -hex 32>
ITERATE__ADMIN_BEARER=<openssl rand -hex 32>
```

A section the file sets replaces the environment's whole: spread `base.<section>` into it to keep
the environment's fields. Without `iterate.config.local.ts`, any secrets manager that injects
environment variables works: `doppler run -- pnpm run deploy`, `infisical run -- …`,
`op run --env-file=core/os/.env.op -- …`.

Cloudflare's credentials are not part of the config: `cf auth login`, or `CLOUDFLARE_API_TOKEN`.
(`customHostnames.cloudflareApiToken` is the Worker's own token, for projects' custom hostnames.)

The key, `secretsEncryption.key`, encrypts every project secret. Losing it loses them, and changing it
signs everyone out. Keep `core/os/.secrets`, or your secrets manager's copy: it is the only one.

## What the deploy does

`pnpm run deploy` (`scripts/deploy.ts`):

1. Reads the config, parses it as the Worker will, and prints it with secrets redacted. A key the
   schema does not name is warned about and left out.
2. Builds the Worker.
3. Looks up the D1 `<prefix>-db`. A deploy binds the D1, the R2 bucket `<prefix>-files` and the
   KV namespaces by name and creates, empty, those that do not exist, so it says loudly when the D1
   is missing: with a wrong prefix, an existing deployment would start empty. The first repo the
   Worker creates makes the Artifacts namespace `<prefix>-repos`.
4. Migrates the D1 (a new one right after the deploy), then runs `cf deploy`. Each field the schema
   marks secret becomes a Worker secret of its own, named by its path
   (`ITERATE__INTEGRATIONS__GITHUB__OAUTH_CLIENT_SECRET`); the rest becomes the plain var `ITERATE`,
   which the dashboard shows. The Worker merges them back. The secrets go through a file only you
   can read; no value is printed or put on a command line. An `ITERATE__*` secret the config no
   longer sets is blanked by the same upload, then deleted.

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

- `cloudflareAccess: {}`, the default: Cloudflare mails a one-time code, so no password and no mail
  domain. The deploy makes an Access application on `/.auth/identity/cloudflare-access` alone, its
  policy `login.allow` and `login.deny`, and the account's Zero Trust organization if it has none.
  Each person who signs in takes one Zero Trust seat.
- `emailCode: { from }`: a mailed code from an address on a domain onboarded for Email Sending.
- `password: { password }` (secret: `ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD`): one password
  for everyone, the email only a name tag. For local dev and test deployments.
- `google: {}`, `github: {}`, `cloudflare: {}` (or `{ scopes }`): sign-in with that provider's
  integration client, which the person's connection then uses too. `integrations.cloudflare` takes
  `{ oauthClientId, oauthClientSecret }` from your own OAuth client; register
  `<your-origin>/.auth/identity/cloudflare/callback` and
  `<your-origin>/api/integrations/cloudflare/callback`, and configure the client for
  `response_types: ["code", "id_token"]` and the `user-details.read` scope.

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

1. **The zone** for `<your-domain>` on the same Cloudflare account as the Worker.
2. **Your routes in `cloudflare.workerRoutes`**:
   `[{"pattern":"*.<your-domain>/*","zone":"<your-domain>"}]`. The wildcard also covers
   `os.<your-domain>`. A route answers only where DNS does: make a proxied record
   `*.<your-domain>` (any target, such as AAAA `100::`).
3. **A certificate for `*.<your-domain>`.** Cloudflare's Universal SSL covers the apex and one
   wildcard level, which is why a project host is one label under `<your-domain>`:
   `<routingSlug>--<project>`, or the apex `<project>`.
4. **The URLs**: `urls.os` = `https://os.<your-domain>` and `urls.ingressRouting` =
   `{"type":"subdomains","hostname":"<your-domain>"}`.

Deploy again. `/mcp` then lives at
`https://os.<your-domain>/mcp`; reconnect your MCP client there. Keep `cloudflare.workersDev` on
while anything still uses the workers.dev origin.

A deploy adds and keeps the routes it names, and does not remove one you take out of
`cloudflare.workerRoutes`: delete it in the Cloudflare dashboard (the Worker's Settings, Domains &
Routes).

### A project's own domain

`urls.projectHostnames: [{ "hostname": "example.org", "project": "<id or slug>" }]` gives one
project a domain of its own: `example.org` is the project's apex, and `notes.example.org` is its
`notes` app, as with a hostname the project adds itself. Name the project by its id (`prj_…`): an
entry that names its slug stops serving it when the project is renamed, so `projects.rename`
refuses to rename a project the config names by its slug. Route `example.org/*` and
`*.example.org/*` on that zone to the Worker. The platform's own origin stays the platform's, even on the same zone (the
platform on `iterate.example.org`, its projects on `*.iterate.example.org`). A more specific route
on the zone wins over the wildcard, but a Custom Domain does not: give each Custom Domain on the
zone a route of its own to its Worker (`app.example.org/*`), or the wildcard takes it.

## Local development

`pnpm --dir core/os dev` (or `pnpm --dir core/os exec cf dev`) serves the platform on
`http://localhost:8788`, signed in with the password `dev`, projects under
`<project>.localhost:8788`. D1, KV and R2 stay on disk, and so does Images (an offline version
that knows `width`, `height`, `rotate` and `format` only; `text` and `draw` need a deployment); Workers AI, Browser Run and Artifacts have
no local version and reach the account set in `CLOUDFLARE_ACCOUNT_ID`, in the namespace
`os-dev-repos`. `itx.sandboxes` runs its containers in Docker (any Docker-compatible engine), so a sandbox verb needs one running; nothing else does. A deployment needs Cloudflare Containers on its account (the `SandboxContainer` class, `schedulingPolicy: "durable-object"`). Local dev never reads `iterate.config.local.ts` or `.secrets`: they are a
deployment's config.
