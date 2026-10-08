# OS

`core/os` is the Iterate platform at https://os.iterate.com. One Cloudflare Worker provides
the OAuth issuer, `/api`, `/mcp`, project ingress, and the Durable Objects that hold project
contexts. First-party clients authenticate through this issuer and use `iterate/*`.

## Develop and test

Run from the repository root:

```sh
pnpm install
pnpm --dir core/os dev         # the platform on local workerd (scripts/dev.ts; `cf dev` serves it too)
pnpm --dir core/os build       # with core's templates; `--template <github reference>` adds others
pnpm --dir core/os typecheck
pnpm --dir core/os test
```

The Worker is a TanStack Start app built by Vite: `src/worker.ts` serves the platform, and the
pages people see (`/`, `/login`, the `/oauth2/auth` consent) are server-rendered routes in
`src/routes/` using core/os's own components: shadcn's in `src/components/ui/`, written by its CLI
and never edited
([packages/ui/AGENTS.md](https://github.com/iterate/packages/blob/main/packages/ui/AGENTS.md#vendored-shadcn-components)),
and ours beside them. Their look is `iterate/theme.css` (`core/lib/src/theme/`), which
`src/styles.css` imports. Its UI is the auth flow and nothing more: a component only another app needs,
or anything first-party and opinionated (stream views, app shells), belongs in packages/ui
([iterate/packages](https://github.com/iterate/packages)). The Worker's Cloudflare config is
`cloudflare.config.ts`, which `cf` and the Cloudflare Vite plugin read; the build writes the Worker
and its config to `.cloudflare/output/`, which the tests and deploys use. The end-to-end and browser
suites that run against a deployment are iterate's, outside core.

## Deployments

One object configures a deployment, the iterate config (`src/iterate-config.ts`): its
`cloudflare` section says where the Worker deploys, the rest what the Worker does. `pnpm run deploy`
(`scripts/deploy.ts`) reads it from the environment (`iterate.config.ts`) or a gitignored
`iterate.config.local.ts`, builds the Worker from `cloudflare.config.ts`, migrates the D1 and runs
`cf deploy`. [Self-hosting](SELF-HOSTING.md) explains the config and the deploy. iterate's own
deployments, production and one per tested commit of a pull request, are configured and deployed
by iterate's tooling, outside core.

## The control plane's database

The control plane — users, identities, organizations, memberships, projects, invitations, custom
hostnames and the OAuth provider's grants — is one D1 per deployment, bound as `DB`, and
`os-dev-db` locally (`src/control-plane/db/`). [sqlfu](https://github.com/mmkal/sqlfu) authors it: the schema is
`definitions.sql`, the migrations `migrations/*.sql`, and every query a named statement in
`queries/*.sql`, typed into `queries/.generated/` (committed); `db/index.ts` says why each write is
one statement or one batch. It is the one truth of organizations, members, invitations and projects:
`session.organizations` and `session.projects` read it as it stands (the Dash reads nothing else),
and the facts a verb lands on an organization's context and a member's account are their activity.

To change the schema, edit `definitions.sql`, write the next migration (`pnpm --dir core/os db:draft`
drafts it), then:

```sh
pnpm --dir core/os db:check     # the migrations replay to definitions.sql
pnpm --dir core/os db:generate  # the typed queries; commit what changes
pnpm --dir core/os db:migrate   # this worktree's local D1 (`pnpm --dir core/os dev` runs it too)
```

A deployment's D1 is migrated before the code that reads it uploads (`pnpm run deploy` applies the
migrations, then deploys): a migration must keep the running version working until then. D1 Time Travel restores a database to any minute of the last 30 days.

## Projects and MCP

`session.projects.create()` starts a durable project-creation saga. Each project has a config
repository; a commit to `/repos/config` publishes its `main` (`src/project/publication.ts`). A repo can remember
a git remote as its origin and `pull()` or `push()` it, fast-forward only unless `force`, keeping one
history with the same commits on both ([a config repo on GitHub](docs/project-creation.md#a-config-repo-on-github)). A project
created with no template gets a homepage alone (`core/configs/minimal`); the presets a deployment
offers are core's configs (`core/configs/`, whose `default` installs the agents app from
`iterate/agents`) and any others its build is given (`pnpm build --template <github reference>`),
such as `configs/voice` in [iterate/packages](https://github.com/iterate/packages). See [project creation](docs/project-creation.md).

A project's id never changes; its slug is the label of its hosts and the local part of its email
address. `session.projects.rename(project, { slug })` changes the slug: the owner of its
organization or the operator renames it, its hosts and address follow the new slug, and the old ones
stop answering (within five seconds on every edge isolate). Its data, custom hostnames and
connections stay, keyed by the id. A rename lands `project/renamed` on the project's root and
`organization/project-renamed` on its organization. `session.projects.delete(project)` deletes it.

A context hosts Durable Object classes as facets (`itx.facets.get(name, { source, className })`, or
a processor's row). A caller reaches a facet by itx expression only through the methods its class
lists in `static publicMethods`: extend `FacetDurableObject` or `StreamProcessorDurableObject` from
`iterate/sdk` and add your own (`[...super.publicMethods, "send"]`); the platform's own calls
go around the list (`src/context/facet-public-methods.ts`).

Anything a caller or a facet keeps can hold a context resident and billed after its last call.
[Context residency](docs/residency.md) explains the seven mechanisms that prevent, end or record
that.

The MCP endpoint is `/mcp` on each platform deployment (production also serves
https://mcp.iterate.com). It exposes `run({ project?, script })`, where `script` is an
`async (itx) => …` function. [examples/mcp-run-scripts.mjs](examples/mcp-run-scripts.mjs) has
runnable scripts, which the instructions link and an e2e test runs. An MCP client signs in with OAuth or
presents a personal access token; [credentials](docs/credentials.md) says which bearer works
where, and why the operator bearer is `/api`'s alone.

## Integrations

How a project hosts integration packages (a Telegram bot, its own GitHub App) and what they
register for the Dash, connects Slack, Google, Cloudflare, GitHub and X through the deployment's
own apps, uses a member's own accounts, borrows the deployment's keys, holds a WebSocket through a
secret, and logs in to vendors without OAuth: [integrations](docs/integrations.md).

For a deployment in another Cloudflare account, follow [self-hosting](SELF-HOSTING.md).
