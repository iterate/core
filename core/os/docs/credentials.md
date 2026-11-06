# Credentials

The platform accepts three kinds of bearer. Each has its own job.

| Credential                                    | Who holds it                                                                            | Works at                                                      | Lifetime                                                        | Ended by                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| **Personal access token** (`itk_…`)           | a person, for scripts, MCP clients, devices                                             | `/api`, `/mcp`, and the hosts of the projects it covers       | until its expiry, or none                                       | revoking it (Dash Sessions, `iterate tokens revoke`) |
| **OAuth access token**                        | an app a person signed in to: the Dash, the CLI, an MCP client that did the OAuth dance | its one resource: `/api` (with the projects' hosts) or `/mcp` | an hour; its grant refreshes for a week unused, 30 days at most | signing out, or ending the session in the Dash       |
| **Operator bearer** (`ITERATE` `adminBearer`) | the deployment, for automation                                                          | `/api` only                                                   | until the secret is rotated                                     | rotating the secret                                  |

## OAuth tokens

`core/os` is an OAuth authorization server (`src/oauth.ts`, on `@cloudflare/workers-oauth-provider`
1.0). It protects two **resources**, which are just the two URLs it serves APIs on: `/api` (Cap'n
Web, for the apps and the CLI) and `/mcp` (in production `https://mcp.iterate.com`). An app asks
for access to one of them, the person consents, and the app gets a token whose audience is that
one resource ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)). The MCP specification requires
it: an MCP server accepts only tokens issued for itself, so a token for another API can't be
replayed against it. That is why an OAuth token for `/api` is refused at `/mcp`, and the reverse.
The two resources are not project-specific: a grant's projects are what the person ticked at
consent.

## Who a project's host says is calling

A project's host serves the project's config worker. The edge tells the app who is calling in two
headers, and strips any copy a request brings (`src/project-host-sign-in.ts` holds the rules):

- `x-itx-person` (`{ userId, email }`): anyone signed in, member of the project or not. When a
  platform admin is signed in as the person, it says so in `impersonatedBy`, as `x-itx-principal`
  does: an app that hands out something personal refuses, or records, such a person.
- `x-itx-principal` (and the grant): a member of the project only.

A session cookie on a write or a WebSocket upgrade from another site gets neither. The SDK reads
them: `auth.require` asks for a member, `auth.requirePerson` for anyone signed in, and
`auth.person` says who it is.

An app for people who are not its project's members asks for the `identity` scope:
`/.auth/login?scope=identity`, or the challenge `auth.requirePerson` answers, which the edge turns
into that sign-in for a page load. The consent page then shows only who the app learns you are,
and the grant reaches no project: at `/api`, `whoami` and `info` answer (`scopes: ["identity"]`)
and `projects.get` is refused, except for the project that lends them a facet (below). Beside `iterate`, `identity` adds nothing: every grant says who you
are. Under paths routing (previews) every project's page shares the issuer's origin and cookie, so
a person signed in to the issuer arrives as a person on every project's page, with no consent.

A person who is no member can still reach the facets a project lends them, through `/api`
([a project lends a facet](../README.md#a-project-lends-a-facet-to-a-person)). Which grant reaches
which project's lends:

| Grant                                                                           | Reaches the lends of             |
| ------------------------------------------------------------------------------- | -------------------------------- |
| one made by a project host's own client (`https://<host>/.auth/client.json`)    | that project only                |
| one bound to no list of projects (the issuer's session, an app given every one) | every project that lends to them |
| one bound to chosen projects (a personal access token, another site's identity) | none                             |

A lend is to a person, so without this rule every site the person signed in to could use what any
other project lent them. Under paths ingress every project's page holds the issuer's session, so a
lend is no defence between projects there, as membership is not.

## Signing in through another deployment

`login.methods.iterate` (**Log in with iterate**) names another iterate deployment as the one that
says who a person is (`src/iterate-sign-in.ts`). The deployment is that issuer's OAuth client, and
its client id is the URL of a document it serves (`/.auth/sign-in/iterate/client.json`). It asks
for the issuer's `/oauth2/userinfo` resource alone, reads the person's address there, and revokes
the token at once. That token reaches no project (`/api` and `/mcp` refuse it by audience). The
address then signs in here as any sign-in does: only when `login.allow` admits it, and with
`adminsOnly` only when `admins` lists it too. The person's sessions here are this deployment's own:
signing out at the issuer ends none of them.

From the issuer's Dash into such a deployment is straight through: the one click, ever, is the
identity card the first time. Three rules make it so.

- **The issuer remembers an identity confirmation.** Approving the identity card records
  `account/identity-confirmed` for that client on the person's account. Consent answers that
  client's next identity request at once (`src/consent.ts`). The Dash lists these under Sessions as
  "Sites that know who you are", where **Forget** shows the card again next time.
- **The deployment approves the issuer's own apps.** The issuer serves its first-party apps' client
  ids at `/.well-known/iterate-apps.json` (its `urls.dash` and `urls.apps`, `src/iterate-apps.ts`).
  A deployment whose session for the person was started by log in with iterate approves those
  clients with no consent page: the scopes asked for but `admin`, every project. Sessions says the
  grant was approved because the person signed in with that issuer. The deployment keeps the list
  for five minutes.
- **The Dash goes straight on.** Its `/.auth/connect` asks its own issuer, through the Dash's
  session there, whether the person confirmed who they are to the deployment's sign-in client
  (`<deployment>/.auth/sign-in/iterate/client.json`). When they did, the Dash binds to the
  deployment with no page (iterate/app-server `confirmedTo`). With no session at its issuer to ask
  through, the Dash first gets one by redirects alone: an authorization with `prompt=none` that
  asks only who the person is, back to the connect URL marked `checked=1` so it is asked once.
  When the person never confirmed, the connect page shows as before, and that session goes.

The issuer answers an authorization with `prompt=none` (OpenID Connect) with no page at all
(`src/silent-authorize.ts`). A browser with no session there goes back to the client with
`error=login_required`. A request it answers without a page goes on: an identity confirmed before,
one of its own apps asking only who a signed-in person is, or a deployment's issuer's own app. Any
other goes back with `error=interaction_required`. Each answer carries the request's `state`.

The chain the Cloud's **Open** starts is the deployment's deep link,
`<deployment>/.auth/sign-in/iterate?next=/`. The issuer shows the identity card the first time and
answers at once after that. The deployment signs the person in. Its `/` sends the page on to the
Dash's connect for it, which signs the Dash in at the issuer silently, asks, and binds to the
deployment. The deployment then approves the Dash, which shows the deployment. A deployment's
`next` never leaves its own origin, which is why the chain goes through the deployment's `/`.

## Personal access tokens

A personal access token is iterate's own API key, the kind a SaaS product lets you make in its
settings. You make one and paste it wherever you need it: an MCP client, `curl`, a script, a
device. It is not an OAuth token, so it has no single audience, and one key works at `/api`,
`/mcp` and your projects' hosts.

- **What it can do.** It acts as you, with the `iterate` scope, on the projects you chose when you
  made it. It can't see or manage your sessions or keys, and it can't create organizations, so a
  leaked key can't mint another. `/api` and `/mcp` refuse a project it doesn't cover; that
  project's host lets the request through as a person who is no member, as it does any
  non-member's ([below](#who-a-projects-host-says-is-calling)), so the app learns who you are and
  never treats you as a member.
- **Format.** `itk_<your user id>_<key id>_<256 random bits><CRC32>`, 103 characters
  (`src/personal-access-token.ts`). The fixed prefix and checksum make a leaked key easy to find:
  `\bitk_[0-9a-f]{32}_[0-9a-f]{16}_[0-9A-Za-z]{49}\b` is a pattern for secret scanning.
- **Storage.** The key is shown once, and never recorded: the Dash shows it in a block PostHog's
  session replay and autocapture leave out (`NotRecorded`, `packages/ui`). Your account keeps its
  SHA-256, never the key (the account's `personalAccessTokens`, folded from
  `account/personal-access-token-minted`, which also names the session that minted it). No log
  line carries a key.
- **Admission.** A key proves itself before any Durable Object is dialled. The format and the
  checksum are public, and user ids are not secret, so anyone can write a well-formed key under
  anyone's id. So the platform first looks the key's SHA-256 up in KV (`OAUTH_KV`, an index the
  mint writes and revocation deletes), as the OAuth library looks up an access token it issued. A
  miss is refused on that one read. Only a hit reads your account, the truth of the key: its hash,
  compared in constant time, its end and its expiry.
- **Revocation.** Revoking lands `account/grant-ended` on your account before the call returns,
  then deletes the key's index entry. From then on `/api`, `/mcp` and the project hosts refuse the
  key. What it holds open closes at its next re-check, within 30 seconds of when it opened and at
  most a minute: a socket on `/api` (`src/rpc.ts`), and a WebSocket or a streamed body (one with
  no `content-length`, such as server-sent events) on a project's host, which the edge relays for
  any bearer with a grant (`src/project-host-lease.ts`). Two things run to their end: an MCP
  `run` already executing (at most ten minutes), and a response of known length already being
  sent. A key also stops working, like any grant, once the deployment's sign-in rules (`login.allow`, `login.deny`) no
  longer names its person's email.
- **Refusals.** A refused key is logged as `oauth.refusal` with `category: "protected-resource"`
  and a `reason`: `token_unknown_or_expired` for a malformed, forged, revoked or expired key, and
  `grant_not_live` for one the index still held when the account refused it. The platform does not
  rate-limit bad bearers, keys included: a string that fails the checksum is refused without any
  lookup, a well-formed one costs one KV read, and only a real key reads its person's account.
- **MCP.** At `/mcp` a key is outside the MCP authorization profile, which expects a token from
  the OAuth flow. The platform accepts it anyway, so you can use the same key everywhere. MCP
  clients that do the OAuth dance keep working as before.

Make one:

- **Dash:** Sessions → Personal access tokens. Pick the projects and an expiry (30 days by
  default, or none).
- **CLI:** `iterate tokens create --name my-script --project <slug>`. It expires in 30 days;
  add `--never-expires` for a key with no expiry. `iterate tokens list` and
  `iterate tokens revoke <pat_id>` do the rest. Each `tokens` command signs you in in the browser
  for that one call with the `account` scope, then ends that sign-in: the session `iterate login`
  stores on disk has `iterate` alone, so a copied config file can't mint keys.
- **Local dev:** `pnpm -s getin --token` prints one for `test@preview.iterate.test` on the `test`
  project.
- **Production, as an operator:** sign in to https://dash.iterate.com as yourself and use
  Sessions, or run
  `pnpm exec iterate --config prd tokens create --name <what for> --project <slug>` and approve
  the sign-in it opens. The key covers projects you are a member of.

Use one:

```sh
export ITERATE_BEARER_TOKEN=itk_…   # the CLI and the repo's scripts read it
pnpm exec iterate itx run --project <slug> --eval 'return await itx.whoami();'
eval "$(pnpm exec iterate mcp claude)"  # Claude Code against /mcp with the key
```

`iterate mcp claude` prints a command that reads the key from `$ITERATE_BEARER_TOKEN` when it
runs, so the key stays out of a transcript. To register the server with Claude Code for good,
`claude mcp add --transport http iterate https://mcp.iterate.com/ --header "Authorization: Bearer
$ITERATE_BEARER_TOKEN"` works too, but it writes the key in plain text into Claude Code's
configuration (`~/.claude.json`); give such a key an expiry.

## The operator bearer

`adminBearer` is the deployment's machine credential. It reaches every project as the
`admin` actor, so it's for automation that has no person behind it: a test harness creating
people and projects per test, deploy scripts and their readiness gates, load scripts, backups.
`/api` accepts it in-band (`authenticate({ type: "admin-secret" })`) or as a bearer. Every other entry point refuses it and logs
`reason: "operator_bearer_not_accepted"`
(`src/oauth.ts`):

- `/mcp`, where an MCP client configured with it would hold every project;
- a project's host, where the project's app would be handed an operator over every project;
- a secret's OAuth callback (`/.secrets/oauth/callback`), which a project's member completes;
- a browser session, which only ever holds an OAuth token.

People and agents use personal access tokens instead. The one exception is a project you are not
a member of: a key can't reach it, so debugging a customer's project in production takes the
bearer, on `/api`, through the CLI:
`ITERATE_ADMIN_BEARER=… iterate --config <deployment> itx run --project <slug> …`
([the CLI's configs](../../lib/src/cli/README.md#configs)).

The CLI and `examples/serve-localhost.mjs` read the bearer from `ITERATE_ADMIN_BEARER` (one
underscore: a client's variable, not the deployment's `ITERATE__ADMIN_BEARER`), before
`ITERATE_BEARER_TOKEN`.
