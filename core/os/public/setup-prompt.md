# Self-host iterate OS on a personal Cloudflare account

A recipe for a coding agent. If you were asked to set someone up with iterate.com, or with a
self-hosted iterate, follow it.

iterate OS (`core/os` in https://github.com/iterate/core) is one Worker: sign-in and OAuth, `/api`,
`/mcp` (one tool, `run({ project, script })`, which evaluates `async (itx) => …` against a project),
and a Durable Object per project. iterate's hosted apps (the dash, agents, voice) sign in to it.

End state:

1. **A clone of iterate/core** (`iterate/`), deployed to the user's Cloudflare account.
2. **A file with the config and secrets**: `iterate/core/os/iterate.config.local.ts` and
   `iterate/core/os/.secrets`. The only copy of the secrets.
3. **The user's coding agent connected to iterate over MCP**, and the user signed in to the dash,
   with a first project whose agents and voice apps work.

Opening the deployment's origin (`https://iterate.<domain>`, or
`https://iterate.<subdomain>.workers.dev` without a domain) in a browser goes to the dash, signed
in through that deployment. The dash links the other apps.

Work in the directory you were started in.

Whenever the user has to act somewhere else (the browser, or e.g. typing `/mcp` into their client),
end your turn or wait on a background command. Don't ask a blocking question: it takes over their
prompt box. Ask in plain text and end your turn instead.

One browser flow at a time, in order: the dash sign-in and project (step 6) finishes before any
client's OAuth (step 8) starts. Every one of them shows the same iterate sign-in and consent pages,
so say which flow a page is for when you open it.

## Before you start: tell the user what they need

Start with one message that lists these, before you run anything:

1. **A Cloudflare account with Workers Paid and R2 enabled**, ideally a new account just for
   iterate. The deployment takes a Worker, D1, R2, KV, Artifacts and the sandboxes' containers; an
   account of its own keeps all that, and its bill, apart from anything else.
   https://dash.cloudflare.com/sign-up makes one. Workers Paid and R2 each need a payment method on
   the account; [Enable Workers Paid and R2](#enable-workers-paid-and-r2) says where. Workers Paid
   also brings Cloudflare Artifacts (open beta), the git repos every project's code lives in.
2. **Ideally, a domain to burn**: a domain whose zone is active on that Cloudflare account and that
   nothing else uses. iterate then takes all of it:
   - `iterate.<domain>`: the OS itself (sign-in, consent, `/api`, `/mcp`);
   - `<domain>`: the first project's homepage;
   - `*.<domain>`: the first project's apps, `<app>.<domain>`, each on an origin of its own.

   Without a domain, everything runs on `https://iterate.<subdomain>.workers.dev`, and every project
   app shares that origin with the OS. That is fine for one person, or people who all trust each
   other; `core/os/SELF-HOSTING.md` (Project apps) says why.

3. **Who may sign in. You MUST ask this; it is a required question.** Sign-in is a password: a
   person types their email and the deployment's one password, which you generate in step 4 and the
   user keeps in their password manager. Ask which email addresses, and which whole email domains,
   may sign in. Never guess the list, never fill it from git config or the Cloudflare login, and
   never allow everyone. Don't write the config (step 4) until the user has answered.

Ask for the domain, if they have one, in the same message. Then end your turn, and start step 1
when the user answers.

## Enable Workers Paid and R2

Send the user these links. `:account` makes the dash pick the account; once you know the account
id (step 2), put it in the link instead.

- **Workers Paid**: https://dash.cloudflare.com/?to=/:account/workers/plans, then choose
  **Workers Paid**. It is a monthly subscription; the deploy fails without it, as the config
  declares paid-plan limits.
- **R2**: https://dash.cloudflare.com/?to=/:account/r2/overview, then **Purchase R2 Plan** (it has
  a free tier; Cloudflare still asks for a payment method). The R2 check in step 3 answers
  `10042 Please enable R2 through the Cloudflare Dashboard` until this is done.
- **A domain** (optional): https://dash.cloudflare.com/?to=/:account/add-site adds a domain the user
  already owns (they change its nameservers at the registrar to the two Cloudflare names); or
  https://dash.cloudflare.com/?to=/:account/domains/register buys one. The zone must show
  **Active** before you deploy.

## 1. Get the code

```bash
git clone --depth 1 https://github.com/iterate/core iterate   # gitignored
cd iterate && pnpm install
```

The deployment offers core's project templates (`core/configs/`). A new project, the user's first
included, starts from `default`: the agents app. A bare homepage (`minimal`) is always offered too.

Run every later command from `iterate/core/os`. [Alchemy](https://alchemy.run) deploys the
platform: `pnpm run deploy` builds it and runs Alchemy's CLI there.

## 2. The Cloudflare API token

- `open` https://dash.cloudflare.com/profile/api-tokens. The user signs in as the right Cloudflare
  user and chooses **Create Token**, then **Create Custom Token**. Tell them to name it `iterate`
  and give it these permissions, all on the **Account** unless the row says **Zone**:
  - **Edit**: Workers Scripts, Workers KV Storage, Workers R2 Storage, D1, Containers, Artifacts
  - **Read**: Account Settings, Workers Tail, Workers Observability
  - With a domain, on the **Zone**, **Edit**: Workers Routes, DNS

  Under **Account Resources** they include the account to deploy to (and the zone under **Zone
  Resources** with a domain), so don't ask which account up front. They create the token and copy
  it. End your turn while they do this.

- Write the token into `core/os/.secrets` from the clipboard, so it never appears in chat:
  `(umask 077 && printf 'ITERATE__CLOUDFLARE__API_TOKEN=%s\n' "$(pbpaste)" > .secrets)` on macOS
  (on Linux, `wl-paste` or `xclip -o -selection clipboard`). If you can't read the clipboard, the
  user pastes it after `ITERATE__CLOUDFLARE__API_TOKEN=` in that file themselves. The token is
  part of the deployment's config (`cloudflare.apiToken`): the deploy runs with it, and the Worker
  keeps it.
- List the account the token reaches; its id goes into the config in step 4. Ask only if it lists
  several:

  ```bash
  (set -a && . ./.secrets && curl -s https://api.cloudflare.com/client/v4/accounts \
    -H "Authorization: Bearer $ITERATE__CLOUDFLARE__API_TOKEN")
  ```

## 3. Check the account (before deploying)

With the account id from step 2:

```bash
(set -a && . ./.secrets && for route in r2/buckets artifacts/namespaces; do
  curl -s "https://api.cloudflare.com/client/v4/accounts/<account id>/$route" \
    -H "Authorization: Bearer $ITERATE__CLOUDFLARE__API_TOKEN"; echo
done)
```

- `r2/buckets` must answer `"success":true`. If not, the user enables R2
  ([links](#enable-workers-paid-and-r2)).
- `artifacts/namespaces` must answer `"success":true`. `10004 Access denied` means the account has
  no Artifacts, which comes with Workers Paid: the user turns Workers Paid on
  ([links](#enable-workers-paid-and-r2)). Without Artifacts, sign-in and MCP work, but project
  creation fails.
- With a domain: `curl -s "https://api.cloudflare.com/client/v4/zones?name=<domain>"` with the same
  header must show it on this account, `"status":"active"`, and its `id` is the zone id for step 4.
- Workers Paid has no check of its own: the Artifacts check above fails without it, and a
  successful deploy proves it.

## 4. The iterate config

Write two files in `core/os/`. Git ignores both. Keep them: `.secrets` holds the only copy of these
values.

`core/os/iterate.config.local.ts` holds the values that are not secret. It imports
`iterate.config.ts`, which reads the config from the environment and `.secrets`, and overrides what
it needs. A section the file sets replaces the environment's whole, so spread `base.cloudflare`
(the token) and `base.login` (the password) into it. Without a domain:

```ts
import type { IterateConfigInput } from "./src/iterate-config.ts";
import base from "./iterate.config.ts";

export default {
  ...base,
  cloudflare: {
    ...base.cloudflare,
    accountId: "<the account from step 2>",
    resourcePrefix: "iterate",
  },
  // sign-in: the password in .secrets, for the addresses `allow` admits
  login: { ...base.login, allow: [{ email: "<the user's email>" }] },
} satisfies IterateConfigInput;
```

With a domain, the OS moves to `iterate.<domain>`, and the Worker takes the whole zone:

```ts
export default {
  ...base,
  cloudflare: {
    ...base.cloudflare,
    accountId: "<the account from step 2>",
    resourcePrefix: "iterate",
    workerRoutes: [
      { pattern: "<domain>/*", zone: "<domain>" },
      { pattern: "*.<domain>/*", zone: "<domain>" },
    ],
  },
  urls: { ...base.urls, os: "https://iterate.<domain>" },
  login: { ...base.login, allow: [{ email: "<the user's email>" }] },
} satisfies IterateConfigInput;
```

A route answers only where DNS does. Give the zone two proxied records, `<domain>` and
`*.<domain>` (the wildcard covers `iterate.<domain>`). Cloudflare's free Universal SSL certificate
covers both. First list what the zone has on those names
(`GET https://api.cloudflare.com/client/v4/zones/<zone id>/dns_records`, with the token's header);
if anything is there, show it to the user and ask before you delete it
(`DELETE …/dns_records/<record id>`). Then:

```bash
(set -a && . ./.secrets && for name in '<domain>' '*.<domain>'; do
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/<zone id>/dns_records" \
    -H "Authorization: Bearer $ITERATE__CLOUDFLARE__API_TOKEN" -H "Content-Type: application/json" \
    -d "{\"type\":\"AAAA\",\"name\":\"$name\",\"content\":\"100::\",\"proxied\":true}"; echo
done)
```

The first project gets `<domain>` and `*.<domain>` in step 6. Further projects live at
`https://iterate.<domain>/projects/<project>/`.

`resourcePrefix` is `iterate`, unless the account already has an iterate; it names the Worker and
its D1, R2 and Artifacts namespace.

People sign in with a password: they type their email and the password. Keep this method.
`login.allow` is the user's answer to the required question (who may sign in), one rule each:
`{ email: "a@b.com" }` for one address, `{ emailDomain: "b.com" }` for everyone at that domain. No
answer, no config: ask again. A shared password suits people who trust each other;
`core/os/SELF-HOSTING.md` ("Sign-in") has a mailed code and the provider sign-ins for anyone else.

`core/os/.secrets` (mode 600) holds the rest, one `NAME=value` line each, after the token line from
step 2:

- `ALCHEMY_STAGE`: the Worker's name, `iterate` (the `resourcePrefix`). Every Alchemy command acts
  on it.
- `DO_NOT_TRACK=1`: Alchemy's CLI sends its authors no telemetry.
- `ITERATE__ADMIN_BEARER`: `openssl rand -hex 32`. Operator access to every project over `/api`
  (`/mcp` refuses it). You use it to find the user's project and to add voice.
- `ITERATE__SECRETS_ENCRYPTION__KEY`: `openssl rand -hex 32`. It encrypts project secrets at rest;
  losing it loses them.
- `ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD`: `openssl rand -base64 18`. The sign-in password.
  Tell the user where it is (that line of `core/os/.secrets`) and to keep it in their password
  manager.

Leave every other field to its default. Generate the values with a script that appends them to the
file and prints nothing. Never print them in chat.

To change a value or a default later, set it in the environment (`ITERATE`, `ITERATE__*`) or in
`iterate.config.local.ts`; keep a secret a variable of its own in `.secrets`. The user may keep the
secrets in a secrets manager instead (Doppler, Infisical, 1Password): `iterate.config.ts` reads
them from the environment, so `doppler run -- pnpm run deploy` works with no `.secrets`.
`core/os/SELF-HOSTING.md` has the details.

## 5. Deploy

```bash
(set -a && . ./.secrets && curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<account id>/artifacts/namespaces" \
  -H "Authorization: Bearer $ITERATE__CLOUDFLARE__API_TOKEN" -H "Content-Type: application/json" \
  -d '{"namespace":"iterate-repos"}')
mkdir -p -m 700 .alchemy
pnpm run deploy --yes
```

The first command makes the Artifacts namespace `<resourcePrefix>-repos`, where every project's
code lives: a project's creation fails until it exists. It answers `"success":true`, or 409 with
code 10201 when the namespace exists. Without Artifacts access it fails; go on if the user wants
to. `mkdir -p -m 700 .alchemy` makes the folder of Alchemy's state private: the state holds every
secret, and Alchemy writes its files readable by every user of the machine.

`pnpm run deploy --yes` builds the Worker, checks the config, and applies Alchemy's plan without
asking: it makes the D1 database, the KV namespaces, the R2 bucket, the sandboxes' containers and
the Worker, and migrates the D1, which holds the users, organizations and projects. Without a
domain, it prints the Worker's `workers.dev` URL: that is the origin. With one, the origin is
`https://iterate.<domain>`. Alchemy's state is in `core/os/.alchemy/`: keep it beside `.secrets`.

Check the origin before you send the user to it: `curl -s <origin>/version` prints the deploy's
version id and the origin. A new domain's certificate can take a few minutes; wait for it.

To update: `git pull`, `pnpm install`, then `pnpm run deploy` in `core/os`, which shows the plan
and asks before it applies.

## 6. First sign-in and project

Signing in at the origin creates nothing: the organization and project are created on the consent
page, when an app connects. Send the user to the dash's connect page for the origin,
`https://dash.iterate.com/.auth/connect?issuer=<origin, URL-encoded>`; opening the origin itself
goes there too. They click Continue, sign in with their email and the password, then name the
organization and project on the consent page. Wait for them, then find the project and the email
they signed in with yourself, with the admin bearer, which `--env-file=.secrets` reads so it never
appears in a command (from `iterate/core/os`, where the SDK resolves). Ask only if there are
several:

```bash
node --env-file=.secrets --eval 'import("iterate/node").then(async ({ connectIterate }) => {
  const c = await connectIterate({ baseUrl: process.argv[1], auth: { type: "admin-secret", secret: process.env.ITERATE__ADMIN_BEARER } });
  console.log((await c.session.projects.list()).map((p) => `project ${p.slug} ${p.id}`).join("\n"));
  console.log((await c.session.users.list()).map((u) => `user ${u.email}`).join("\n")); process.exit(0); })' <origin>
```

The project row exists even when Artifacts is missing and project creation failed.

With a domain, give the project the zone now: add
`projectHostnames: [{ hostname: "<domain>", project: "<its id, prj_…>" }]` to `urls` in
`iterate.config.local.ts` (by id: a slug stops matching when the project is renamed) and run
`pnpm run deploy` again. `<domain>` is then the project's homepage, `<app>.<domain>` its apps, and
the dash's buttons and `itx.url` use them. A deploy takes a few seconds to reach every Cloudflare
location: until then `<domain>` still answers `421 Unknown platform origin`.

Every iterate app link you give the user carries the issuer:
`https://<app>/.auth/connect?issuer=<origin, URL-encoded>`. A bare `https://dash.iterate.com` (or
voice, …) signs in to iterate's hosted platform instead. Inside the dash, the sidebar's links to
the other apps carry it.

## 7. Add voice

Voice is the npm package `@iterate-com/voice`, on the agents app the project already has. The
voice and Kit pages refuse a project without it, so add it now, in one commit to the project's
config repo. From `iterate/core/os`, with the admin bearer:

```bash
node --env-file=.secrets --input-type=module --eval '
const { connectIterate } = await import("iterate/node");
const [origin, project] = process.argv.slice(1);
const c = await connectIterate({ baseUrl: origin, auth: { type: "admin-secret", secret: process.env.ITERATE__ADMIN_BEARER } });
const itx = c.session.projects.get(project);
const repo = itx.repos.get("/repos/config");
const parent = await repo.tip();
const pkg = JSON.parse(await repo.readFile("package.json"));
// the exact version npm`s main dist-tag names, never `main` itself, which moves
const { main } = await (await fetch("https://registry.npmjs.org/-/package/@iterate-com/voice/dist-tags")).json();
pkg.dependencies = { ...pkg.dependencies, "@iterate-com/voice": main };
let worker = await repo.readFile("worker.ts");
if (!worker.includes("installVoice")) worker = worker
  .replace(`import { installAgents } from "iterate/agents/install";\n`, (line) => `${line}import { installVoice } from "@iterate-com/voice/install";\n`)
  .replace(/^(\s*)await installAgents\(itx\);\n/m, (line, indent) => `${line}${indent}await installVoice(itx);\n`);
if (!worker.includes("await installVoice(itx)")) throw new Error("worker.ts has no installAgents(itx) to add voice after");
const { commitOid } = await repo.commitFiles({ message: "Add voice", parent, changes: [
  { path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" },
  { path: "voice.ts", content: `export { default, VoiceAgentDurableObject } from "@iterate-com/voice";\n` },
  { path: "worker.ts", content: worker },
] });
const outcome = await itx.waitForEvent({ type: ["events.iterate.com/project/worker-updated", "events.iterate.com/project/worker-update-failed"], payload: { commitOid }, afterOffset: 0, timeoutMs: 120_000 });
console.log(main, outcome?.type); process.exit(0);' <origin> <project slug>
```

`worker-updated` means it is published; the project's init case then installs voice within
seconds, and the voice and Kit pages work. `worker-update-failed` carries the build's error. iterate's voice template
(https://github.com/iterate/packages/tree/main/configs/voice) is the same config, whole. Voice talks
to OpenAI's live model: the voice page asks for an OpenAI key the first time and keeps it as a
project secret.

## 8. Connect the user's agents

- Register `<origin>/mcp` as a remote HTTP MCP server in the client you are running in, and only
  that one, e.g. Claude Code:
  `claude mcp add --transport http -s user iterate-<name> <origin>/mcp`, with the domain or the
  `workers.dev` subdomain as the name. Don't set up the user's other clients; the final message
  tells them how.
- Registering may open the sign-in page by itself (e.g. `codex mcp add` does). If it does, don't
  also `open` it or run a separate login command: that pops open the same page twice and confuses
  the user.
- The user signs the client in through the browser (their email and the password). E.g. in Claude
  Code: `/mcp`, pick the server, authenticate; after that, `claude mcp list`/`codex mcp list` shows
  it as connected.
- Then try the server's `run` tool in this session straight away. Some hosts attach a newly added
  server once it's signed in (e.g. Claude Desktop's Code tab does), so look for it among your tools
  (e.g. Claude Code's deferred tools). Call it with `async (itx) => itx.whoami()`: no `project`
  needed when the token reaches one project. `repo /repos/config: not created` there means project
  creation failed: check the project's page in the dash for the reason; without Workers Paid
  (step 3) it is Artifacts'. Once that is fixed, have the user create the project again from the
  dash's projects page. If the tool isn't there, the client only loads servers at startup. Tell the
  user to start a new session and ask it to run the same check.

## 9. Hand over

Finish with one message that has some things to get started with (show links in full, so the user
gets familiar with them):

- the origin, `<origin>`: opening it goes to the dash;
- the dash: `https://dash.iterate.com/.auth/connect?issuer=<origin>`: projects, secrets,
  integrations, and links to the other apps;
- agents: `https://agents.iterate.com/.auth/connect?issuer=<origin>`, to talk to the project's
  agents;
- voice: `https://voice.iterate.com/.auth/connect?issuer=<origin>`, to talk to the project from the
  laptop mic; the page asks for an OpenAI key the first time;
- kit: `https://k.iterate.com/.auth/connect?issuer=<origin>`, to flash a voice board (e.g. a Home
  Assistant Voice Preview Edition) over USB from Chrome or Edge, so it talks to the project too;
- the project's homepage: `https://<domain>/` with a domain, `<origin>/projects/<project>/`
  without;
- `<origin>/mcp` (remote HTTP) for other clients, and that each client signs in the same way (their
  email and the password);
- where the config and secrets are (`iterate/core/os/iterate.config.local.ts`,
  `iterate/core/os/.secrets`), that `.secrets` is the only copy, and how to update
  (`git pull`, `pnpm install`, then `pnpm run deploy` in `core/os`).

## Integrations

An integration is a package the user's project hosts
(https://github.com/jonastemplestein/iterategrations, one folder each with a recipe you follow): a
Telegram bot, the user's own GitHub App, Monzo, Pebble, and more. Adding one is an element of the
`integrations` array in the config repo's `worker.ts` (each recipe's `add-to-a-project.md` script
does it); its setup page and webhook live on the project's host, and the dash's project
Integrations page lists what the project registered, with a button to each page. Writing a new
package, and publishing it so an agent can add it:
https://github.com/jonastemplestein/iterategrations/blob/main/adding-an-integration.md. A self-host
has none of iterate's Slack, Google, Cloudflare or GitHub apps, and needs none. Signing in with
Google, Cloudflare or GitHub needs `login.<provider>` and that provider's app in the iterate config
as `integrations.<provider>`, registered with `<origin>/.auth/identity/callback` (Google),
`<origin>/.auth/identity/cloudflare/callback` (Cloudflare) or
`<origin>/.auth/identity/github/callback` (GitHub).

Google, Cloudflare or email-code sign-in, integrations, and custom domains:
`core/os/SELF-HOSTING.md`.
