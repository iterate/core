# Self-host iterate OS on a personal Cloudflare account

A recipe for a coding agent. If you were asked to set someone up with iterate.com, or with a
self-hosted iterate, follow it.

End state: `https://iterate.<subdomain>.workers.dev/mcp` is a working remote MCP server in the user's
agents. iterate OS (`core/os` in https://github.com/iterate/core) is one Worker: sign-in and
OAuth, `/mcp` (one tool, `run({ project, script })`, which evaluates `async (itx) => …` against a
project), and a Durable Object per project.

Work in the directory you were started in.

Whenever the user has to act somewhere else (the browser, or e.g. typing `/mcp` into their client), end
your turn or wait on a background command. Don't ask a blocking question: it takes over their prompt
box.

One browser flow at a time, in order: the dash sign-in and project (step 6) finishes before any
client's OAuth (step 8) starts. Every one of them shows the same iterate sign-in and consent pages,
so say which flow a page is for when you open it.

## Requirements

- **Workers Paid**: the config declares paid-plan limits.
- **R2** enabled.
- **Artifacts** (closed beta): every project's code lives in an Artifacts git repo. Without access,
  project creation fails; sign-in and MCP still work.

## 1. Get the code

```bash
git clone --depth 1 https://github.com/iterate/core iterate   # gitignored
cd iterate && pnpm install
```

The deployment offers core's project templates (`core/configs/`). A new project, the user's first
included, starts from `default`: the agents app. A bare homepage (`minimal`) is always offered too.

Run every `cf` command as `pnpm --dir core/os exec cf …`, from `iterate/`: that is the project's own
`cf`, which reads `core/os/cloudflare.config.ts`. A `cf` installed globally may be older.

## 2. Log in

- Always run `pnpm --dir core/os exec cf auth login --force --no-browser`, even if `cf` already has
  a login: you can't know which account the user wants. Run it in the background and `open` the
  link it prints. The user signs in to the dash as the right Cloudflare user, picks the account on
  Cloudflare's consent page and allows it. So don't ask which account up front. The command exits
  once they're done.
- `pnpm --dir core/os exec cf accounts list` then shows the account. Ask only if it shows several.

## 3. Check the account (before deploying)

- `pnpm --dir core/os exec cf r2 buckets list` must succeed. If not, the user enables R2 in the
  dash.
- `pnpm --dir core/os exec cf artifacts namespaces list`: `10004 Access denied by feature gate`
  means no access. The access form is https://forms.gle/DwBoPRa3CWQ8ajFp7 (name, account ID, use
  case, Workers Paid y/n, repo count; approval takes 2–4 weeks). Hand the user a prefilled link
  (`viewform?usp=pp_url&entry.<id>=…`); they submit it. Until access is granted, projects won't
  work. Deploy anyway if the user wants to.
- Workers Paid can't be checked from here. A successful deploy proves it.

## 4. The iterate config

Write two files in `core/os/`. Git ignores both. Keep them: `.secrets` holds the only copy of these
values.

`core/os/iterate.config.local.ts` holds the values that are not secret. It imports
`iterate.config.ts`, which reads the config from the environment and `.secrets`, and overrides what
it needs:

```ts
import type { IterateConfigInput } from "./src/iterate-config.ts";
import base from "./iterate.config.ts";

export default {
  ...base,
  cloudflare: { accountId: "<the account from step 2>", resourcePrefix: "iterate" },
} satisfies IterateConfigInput;
```

`resourcePrefix` is `iterate`, unless the account already has an iterate; it names the Worker and
its D1, R2 and Artifacts namespace.

`core/os/.secrets` (mode 600) holds the secrets, one `NAME=value` line each. Each name is the
variable of a config field:

- `ITERATE__LOGIN__PASSWORD`: generated, letters and digits. Anyone who has it can sign in as any
  email they type.
- `ITERATE__ADMIN_BEARER`: `openssl rand -hex 32`. Operator access to every project over `/api`
  (`/mcp` refuses it). You use it to find the user's project.
- `ITERATE__SECRETS_ENCRYPTION__KEY`: `openssl rand -hex 32`. It encrypts project secrets at rest; losing it
  loses them.

Leave every other field to its default: projects as paths on the Worker's own workers.dev origin,
iterate's dash. Generate the values with a script that writes the file and prints nothing. Never
print them in chat. When the user needs the password, copy it:
`sed -n 's/^ITERATE__LOGIN__PASSWORD=//p' core/os/.secrets | tr -d '\n' | pbcopy`. Then tell them
it's on their clipboard, and that it came from `core/os/.secrets` (give its absolute path) so they
can find it later.

To change a value or a default later, set it in the environment (`ITERATE`, `ITERATE__*`) or in
`iterate.config.local.ts`. The user may keep the secrets in a secrets manager instead (Doppler,
Infisical, 1Password): `iterate.config.ts` reads them from the environment, so
`doppler run -- pnpm run deploy` works with no `.secrets`. `core/os/SELF-HOSTING.md` has the
details.

## 5. Deploy

```bash
pnpm run deploy
```

It checks the config, builds the Worker, makes the D1 database and the R2 bucket by name, deploys,
and migrates the D1, which holds the users, organizations and projects. It prints the Worker's
`workers.dev` URL: that is the origin. The Artifacts namespace is made by the first project.
`pnpm run deploy --check` runs everything but the deploy, touching nothing.

To update: `git pull`, `pnpm install`, `pnpm run deploy`.

## 6. First sign-in and project

Signing in at the origin creates nothing: the organization and project are created on the consent
page, when an app connects. So send the user to the dash's connect page,
`https://dash.iterate.com/.auth/connect?issuer=<origin>` (the origin's landing page links there too).
They click Continue, sign in with any email and the password, then name the organization and project
on the consent page. Wait for them, then find the slug and the email they signed in with yourself,
with the admin bearer, which `--env-file=.secrets` reads so it never appears in a command (from
`iterate/core/os`, where the SDK resolves). Ask only if there are several:

```bash
node --env-file=.secrets --eval 'import("iterate/node").then(async ({ connectIterate }) => {
  const c = await connectIterate({ baseUrl: process.argv[1], auth: { type: "admin-secret", secret: process.env.ITERATE__ADMIN_BEARER } });
  console.log((await c.session.projects.list()).map((p) => `project ${p.slug}`).join("\n"));
  console.log((await c.session.users.list()).map((u) => `user ${u.email}`).join("\n")); process.exit(0); })' <origin>
```

The project row exists even when Artifacts is missing and project creation failed.

Every iterate app link you give the user carries the issuer:
`https://<app>/.auth/connect?issuer=<origin, URL-encoded>`. A bare `https://dash.iterate.com` (or
voice, …) signs in to iterate's hosted platform instead. The dash's sidebar links to the other apps
drop the issuer too, so don't send the user through them.

## 7. Verify

`/mcp` takes a person's bearer, so verify it as the user: sign in with their email and the password,
and mint a personal access token for their project that expires in an hour (what the dash's
Sessions page does). From `iterate/core/os`, where capnweb resolves, with the password from
`.secrets`:

```bash
TOKEN=$(node --env-file=.secrets --eval 'import("capnweb").then(async ({ newHttpBatchRpcSession }) => {
  const [origin, email, slug] = process.argv.slice(1);
  const login = await fetch(`${origin}/login`, { method: "POST", redirect: "manual", headers: { origin },
    body: new URLSearchParams({ email, password: process.env.ITERATE__LOGIN__PASSWORD, next: "/" }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const account = () => newHttpBatchRpcSession(new Request(`${origin}/api`, { headers: { origin, cookie } }))
    .authenticate({ type: "from-server-cookie" });
  const project = (await account().projects.list()).find((p) => p.slug === slug);
  const { token } = await account().grants.mint({ name: "setup check", projects: [project.id], expiresAt: Date.now() + 3600_000 });
  console.log(token); })' <origin> <email> <slug>)
```

`/mcp` is stateless streamable HTTP. The token reaches one project, so `project` may be omitted:

```bash
jq -nc --arg s 'async (itx) => ({ who: await itx.whoami(), files: await itx.repos.get("/repos/config").listFiles() })' \
  '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"run",arguments:{script:$s}}}' |
curl -s <origin>/mcp -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d @-
```

Expect the project's id, slug and URL, plus the config repo's files. Then revoke the key: it is the
user's, and the check is done. A key can end itself (`logout`), so no sign-in is needed:

```bash
TOKEN=$TOKEN node --eval 'import("capnweb").then(async ({ newHttpBatchRpcSession }) => {
  await newHttpBatchRpcSession(new Request(`${process.argv[1]}/api`, { headers: { authorization: `Bearer ${process.env.TOKEN}` } }))
    .authenticate({ type: "bearer", token: process.env.TOKEN }).logout(); })' <origin>
```

`repo /repos/config: not created` means project creation failed. Check the project's page in the
dash for the reason; without Artifacts access (step 3) it is Artifacts'. Once that is fixed, have
the user create the project again from the dash's projects page. That starts a new attempt.

## 8. Connect the user's agents

- Register `<origin>/mcp` as a remote HTTP MCP server in the client you are running in, and only
  that one, e.g. Claude Code:
  `claude mcp add --transport http -s user iterate-<subdomain> <origin>/mcp`. Don't set up the
  user's other clients; the final message tells them how.
- Registering may open the sign-in page by itself (e.g. `codex mcp add` does). If it does, don't also
  `open` it or run a separate login command: that pops open the same page twice and confuses the user.
- The user signs the client in through the browser (any email plus the password). E.g. in Claude
  Code: `/mcp`, pick the server, authenticate; after that, `claude mcp list`/`codex mcp list` shows it as connected.
- Then try the server's `run` tool in this session straight away. Some hosts attach a newly added
  server once it's signed in (e.g. Claude Desktop's Code tab does), so look for it among your tools
  (e.g. Claude Code's deferred tools). Call it with `async (itx) => itx.whoami()`: no `project`
  needed when the token reaches one project. If the tool isn't there, the client only loads servers
  at startup. Tell the user to start a new session and ask it to run the same check.
- Finish with one message that has some things to get started with (for links, show them in full so the user gets familiar with them):
  - `<origin>/mcp` (remote HTTP) for other clients, where the password lives, and that each client signs in the same way;
  - the dash: `https://dash.iterate.com/.auth/connect?issuer=<origin>`;
  - voice: `https://voice.iterate.com/.auth/connect?issuer=<origin>`, to talk to the project from
    the laptop mic; the page asks for an OpenAI key the first time.
  - kit: `https://k.iterate.com/.auth/connect?issuer=<origin>`, to flash a voice board (e.g. a Home
    Assistant Voice Preview Edition) over USB from Chrome or Edge, so it talks to the project too.
  - Both need voice in the project's config, which `default` doesn't install. Offer to add it
    ([Adding voice](#adding-voice)).

## Adding voice

Voice is the npm package `@iterate-com/voice`, on the agents app the project already has. Add it to
the project's existing config in one commit, through the `run` tool:
`itx.repos.get("/repos/config")`, read its `tip()` and files, then `commitFiles({ message, changes,
parent: <that tip> })` with:

- `package.json`: `"@iterate-com/voice"` in `dependencies`, at the exact version npm's `main`
  dist-tag names (`curl -s https://registry.npmjs.org/-/package/@iterate-com/voice/dist-tags`,
  such as `0.1.0-main.20261002T164000Z-3202ce3`), not `main` itself, which moves;
- `voice.ts`: `export { default, VoiceAgentDurableObject } from "@iterate-com/voice";`
- `worker.ts`: `import { installVoice } from "@iterate-com/voice/install";` and
  `await installVoice(itx);` in the `events.iterate.com/project/worker-updated` case, after
  `installAgents(itx)`. Keep everything else in the file as it is.

Then wait for that commit's outcome on `/`: `itx.waitForEvent({ type:
["events.iterate.com/project/worker-updated", "events.iterate.com/project/worker-update-failed"],
payload: { commitOid }, afterOffset: 0, timeoutMs: 120_000 })` (`afterOffset: 0` finds an outcome
that landed before the wait began). Once it's published, the init case has installed voice, and the
voice and Kit pages work. iterate's voice template
(https://github.com/iterate/packages/tree/main/configs/voice) is the same config, whole.

## Integrations

A self-host has none of iterate's Slack, Google, Cloudflare or GitHub apps. If the user wants an
agent in Slack, Gmail or a GitHub repo, send them to the dash's project Integrations page and its
**Use your own app** button: it shows the redirect/callback, webhook and (Slack) interactivity URLs
to paste into the provider's console, and takes the app's credentials (client ID and secret; Slack's
signing secret; GitHub's App ID, slug, private key and webhook secret). `core/os/SELF-HOSTING.md`
has the steps per provider. Signing in with Google, Cloudflare or GitHub needs `login.<provider>`
and that provider's app in the iterate config as `integrations.<provider>`, registered with
`<origin>/.auth/identity/callback` (Google), `<origin>/.auth/identity/cloudflare/callback`
(Cloudflare) or `<origin>/.auth/identity/github/callback` (GitHub).

Google, Cloudflare or email-code sign-in, integrations, and custom domains:
`core/os/SELF-HOSTING.md`.
