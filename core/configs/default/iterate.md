# What iterate is

An orientation to how a mind is built, who can do what, and how to recover when something breaks.

## What a mind is

A mind is a stack of Cloudflare Workers running in its owner's own Cloudflare account, at its own
domain. Each mind runs five platform Workers:

- `mind-worker`: hosts the mind's contexts (durable event logs), runs facets and stream processors,
  and loads the config repo.
- `boundary-worker`: handles inbound and outbound HTTP, email delivery, and the control-plane API.
- `auth-worker`: runs sign-in, passkeys, keys, sessions, and mind melds.
- `secrets-worker`: stores credentials pinned to their target origins and injects them on egress.
- `telemetry-worker`: collects the mind's logs, traces, and metrics.

Each mind has three kinds of hostname on its domain:

- `iterate.<domain>`: the control plane, served by the platform (sign-in, `/api`, `/mcp`, `/keys`,
  `/members`, `/minds`, `/sessions`, `/secrets/approvals`).
- `<app>.<domain>`: the mind's apps, served by `/repos/config` (`dash`, `docs`, `meet`,
  `onboarding`, `tasks`, plus any app you add).
- `<domain>`: the mind's public website (`homepage.ts` and `profile/`).

A mind is permanently identified by its id: 64 hex characters, the hash of its first identity
record, published at `https://iterate.<domain>/.well-known/iterate`. The id stays the same even if
the mind's domain, Cloudflare account, or working keys change.

## The three layers

1. **The platform (kernel and stack Workers).** `core/itx` and `core/*-worker`. Holds every context's
   event log, runs loaded workers and facets, enforces passkey auth and secret pinning, and routes
   traffic. It cannot be edited from inside the mind: it updates only when someone with Cloudflare
   access runs `npx iterate deploy`. A daily read-only mirror of its public source lives in this
   mind at `/repos/github.com/iterate/core`.
2. **The template (`/repos/config`, the stdlib).** The git repo that defines what the mind does:
   `worker.ts` (`fetch`, `email`, `processEvent`, `processMindEvent`), its apps (`apps/`), and its
   agents (`agent/`, `agents.ts`, `agent-kinds/`). A commit to `main` publishes a few seconds later.
   Every file here is editable and replaceable in place. A platform deploy only updates files that
   are still byte-for-byte what the platform wrote ([template-updates.md](template-updates.md)).
3. **The owner's own code and data.** Changes committed to `/repos/config`, other repos (such as
   `/repos/onboarding`), every context's event log, files (`itx.files`), KV, secrets
   (`itx.secrets`), and public profile (`profile/`). All of it lives in the owner's Cloudflare
   account.

## Who can do what

- **Members** sign in with a passkey on `iterate.<domain>`. They reach the whole mind: the Dash,
  `/api`, `/mcp`, every context, and approving guarded requests or statements. Owners (listed in the
  stack config) can add or remove members on `/members`.
- **People who are not members (and guests)** may sign in by mailed code or join a shared Meet call
  as a guest, depending on the app. They never become members, never hold `itx`, and reach only what
  `fetch` serves them ([people.md](people.md)).
- **Who can deploy:** Whoever holds the mind's Cloudflare account, using `npx iterate deploy` (or a
  kept Cloudflare sign-in). Neither the mind nor its agents can change its Cloudflare account or
  deploy the platform.
- **Agents** run this repo's code (`agent/`) and act through `itx` with the mind root's full reach:
  reading and appending to contexts, committing to `/repos/config`, calling `itx.config.*`, making
  secret-backed HTTP requests via `getSecret(...)` placeholders (without seeing raw tokens), and
  running Linux sandboxes. Everything a member can do in the mind, an agent can do through an API,
  except signing with a passkey: for passkey-gated rules, melds, or statements, the agent proposes
  the act and sends the `signAt` link to a member.
- **Other minds** can append events only if a member signed a `mind-meld/configured` rule allowing
  them under specific path prefixes. Those events reach `processMindEvent`, never `processEvent`
  ([minds.md](minds.md)).

## How to recover

- **A broken `/repos/config` commit does not go live.** The platform loads and validates each commit
  before publishing. If it fails, the platform appends `events.iterate.com/mind/worker-update-failed`
  on `/` with `payload.error` (also copied to `/exceptions`, readable via `itx.config.exceptions()`),
  and the mind keeps running the last working commit. Fix the error and commit again.
- **If the Dash or another app breaks:** `iterate.<domain>/api`, `iterate.<domain>/mcp`, and the
  `iterate` CLI (`iterate login`, `iterate itx run`) are served by the platform, not `/repos/config`,
  so they stay up. You can also push to `/repos/config` over git; a force push to `main` publishes
  the older commit and records `leftBehind` in `repo/pushed` so later commits can be restored.
- **To follow the template again:** Commit the template's file from `core/configs/default` in
  `https://github.com/iterate/core` (or `/repos/github.com/iterate/core`) over your copy
  ([template-updates.md](template-updates.md)).
- **Lost passkey:** An owner with no passkey left runs
  `npx iterate recover --domain <domain> --owner <email>` from a computer with access to the mind's
  Cloudflare account. It revokes that owner's passkeys and prints a one-use 24-hour link
  (`https://iterate.<domain>/keys/first#<ticket>`) to add a new one. For another member, an owner
  creates a one-use 24-hour link on `/members`.
- **Sessions, keys, and melds:** End active sessions on `/sessions`, revoke passkeys or bridge keys
  on `/keys`, and end mind melds on `/minds` (all on `iterate.<domain>`).
- **Interrupted deploy:** Re-run `npx iterate deploy` on the same computer; it resumes from the cached
  config and adopts resources created before the stop.

## Where to read more

- [AGENTS.md](AGENTS.md): `worker.ts`, agents, safety rules, public profile, and the task index.
- [apps.md](apps.md): apps, the Dash, UI components, calls, Meet, onboarding, integration packages.
- [accounts.md](accounts.md): GitHub, Gmail, Calendar, Slack, X, and MCP servers via iterate Cloud.
- [secrets.md](secrets.md): signing keys, derived keys, GitHub App JWTs, and passkey approval rules.
- [minds.md](minds.md): letting another mind in and sending events between minds.
- [people.md](people.md): pages and sign-in for people who are not members.
- [docs-app.md](docs-app.md): the Docs app, editing and commenting on docs, and HTML notes.
- [agent-kinds.md](agent-kinds.md): custom agent kinds.
- [sandboxes.md](sandboxes.md): Linux sandboxes with git, Claude Code, and Codex.
- [cloudflare.md](cloudflare.md): reading the mind's Cloudflare account, logs, and telemetry.
- [errors.md](errors.md) and [page-events.md](page-events.md): exceptions, crashes, and page speed.
- [mail-replies.md](mail-replies.md): mail routing and reply threading.
- [top-of-mind.md](top-of-mind.md): the context catalog and status labels.
- [template-updates.md](template-updates.md): how platform deploys update or skip template files.
