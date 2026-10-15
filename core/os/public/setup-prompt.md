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

To remove everything this makes later, follow [`teardown-prompt.md`](teardown-prompt.md), beside
this file and served at `<origin>/teardown-prompt.md`.

Work in the directory you were started in. Its name, `<folder>`, names what this setup makes on the
user's machine and Cloudflare account, `iterate-<folder>`, so setups from two folders don't clash.

Whenever the user has to act somewhere else (the browser, or e.g. typing `/mcp` into their client),
end your turn or wait on a background command. Don't ask a blocking question: it takes over their
prompt box. Ask in plain text and end your turn instead. When you ask, say what to answer: "Say
done" once they have done something, "Say yes" to accept what you propose.

One browser flow at a time, in order: Cloudflare's sign-in (step 2), the dash sign-in and project
(step 6), then each client's OAuth (step 8). Steps 6 and 8 show the same iterate sign-in and consent
pages, so say which flow a page is for when you open it.

## Before you start: tell the user what's coming

Start step 1 straight away. While it runs, send one message that needs no answer, so the user can
get ready while you work, and carry on without waiting:

- **A Cloudflare account with Workers Paid and R2 enabled**, ideally a new account just for
  iterate. The deployment takes a Worker, D1, R2, KV, Artifacts and the sandboxes' containers; an
  account of its own keeps all that, and its bill, apart from anything else.
  https://dash.cloudflare.com/sign-up makes one. Workers Paid and R2 each need a payment method;
  [Enable Workers Paid and R2](#enable-workers-paid-and-r2) has the links. Workers Paid also brings
  Cloudflare Artifacts (open beta), the git repos every project's code lives in.
- **A domain** (optional): iterate can take over a domain of theirs, or one you buy them in step 3:
  `iterate.<domain>` for the OS and `mcp.<domain>` for MCP; for each project `<project>.<domain>`
  and its apps at `<app>--<project>.<domain>`; and `www.<domain>` (where `<domain>` goes too) for
  their first project's homepage. Without one, everything runs on
  `https://iterate.<subdomain>.workers.dev`, where project apps share the OS's origin. That is fine
  for one person, or people who all trust each other; `core/os/SELF-HOSTING.md` (Project apps)
  says why.
- **What they'll do**: allow a Cloudflare sign-in and say who may sign in to iterate (step 2), pick
  or buy the domain (step 3), then sign in to their deployment and name their first project
  (step 6). You do the rest.

## Enable Workers Paid and R2

Send the user these links. `:account` makes the dash pick the account; once you know the account
id (step 2), put it in the link instead.

- **Workers Paid**: https://dash.cloudflare.com/?to=/:account/workers/plans, then choose
  **Workers Paid**. It is a monthly subscription; the deploy fails without it, as the config
  declares paid-plan limits.
- **R2**: https://dash.cloudflare.com/?to=/:account/r2/overview, then **Purchase R2 Plan** (it has
  a free tier; Cloudflare still asks for a payment method). The R2 check in step 3 answers
  `10042 Please enable R2 through the Cloudflare Dashboard` until this is done.
- **A domain the user owns elsewhere** (optional): https://dash.cloudflare.com/?to=/:account/add-site
  adds it, and they change its nameservers at the registrar to the two Cloudflare names. The zone
  must show **Active** before you deploy.
- **The account's first domain purchase** (step 3):
  https://dash.cloudflare.com/?to=/:account/domains/registrations. The Registrar API refuses to buy
  until the account has a default registrant contact and the user has accepted the Domain
  Registration Agreement there.

## 1. Get the code

```bash
git clone --depth 1 --branch setup-prompt-domains https://github.com/iterate/core iterate   # gitignored
cd iterate && pnpm install
```

The deployment offers core's project templates (`core/configs/`). A new project, the user's first
included, starts from `default`: the agents app. A bare homepage (`minimal`) is always offered too.

Run every later command from `iterate/core/os`. [Alchemy](https://alchemy.run) deploys the
platform: `pnpm run deploy` builds it and runs Alchemy's CLI there.

## 2. Sign in to Cloudflare

One sign-in of `cf` (Cloudflare's CLI, which the clone has) does the Cloudflare side of the setup:
it makes the deploy token, in step 3 it buys a domain if the user wants one, and in step 5 it sets
up the domain's mail. You delete it at the end of step 5. With `CLOUDFLARE_API_TOKEN` unset (cf
would use it instead), run in the background:

```bash
pnpm exec cf auth create iterate-<folder> --browser=false --scopes \
  account:read user:read offline account_api_tokens:create registrar:read registrar:write \
  account-settings.read workers_scripts:write workers-scripts.write workers_kv:write \
  workers-kv-storage.write workers-r2.write d1:write d1.write containers:write containers.write \
  artifacts.write workers_tail:read workers-tail.read workers_observability:read \
  workers-observability.read workers_routes:write workers-routes.write dns_records:edit dns.write \
  zone:read zone.read email_routing:write email-routing-rule.write email_sending:write \
  email-sending.write
```

A token it makes holds no more than the sign-in does, so the sign-in asks for every permission the
deploy token gets (cf knows each in two spellings, and the list has both), the registrar's, and the
mail's. `--browser=false`, not `--no-browser`: cf refuses the second form.

It prints Cloudflare's consent link and a code, and exits once the user allows it. Don't leave the
page to cf, which may have no browser it can open: `open` the link yourself (it carries the code),
and give the user the link and the code to check against the page. Tell them the page is
Cloudflare's, for the iterate setup. It opens as whoever is signed in at dash.cloudflare.com: if
that's not the user they want, they sign out there first. They allow it and pick the account for
iterate (with Workers Paid and R2, as your first message said). The link expires after a few
minutes; if it does, run the command again.

Wait for the command. Then see who signed in:

```bash
pnpm exec cf --profile iterate-<folder> auth whoami
```

It shows the Cloudflare user's `email` and the `accounts` the sign-in reaches. With a domain, a
person signs in to iterate with a six-digit code mailed to their address; without one, with their
email and the deployment's one password, which you generate in step 4 and the user keeps in their
password manager. Ask in one message, e.g.:

> Signed in to Cloudflare as `<email>`, account `<name>`. I'll let `<email>` sign in to iterate.
> Say yes, or name other email addresses or whole email domains to let in too.

The answer is `login.allow` (step 4). Never allow everyone, and never add an address or domain the
user didn't confirm. If the user or account is wrong, `pnpm exec cf auth delete iterate-<folder>`,
the user signs out of dash.cloudflare.com, and sign in again. If it reaches several accounts, ask
which.

### The deploy token

Make an account-owned token, `iterate-<folder>`, with only what the deployment needs, and write it
to `core/os/.secrets`. It prints the token's name and id alone, so the token never appears in chat:

```bash
node --input-type=module --eval '
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [name, account] = process.argv.slice(1);
const cf = (...args) => JSON.parse(execFileSync("node_modules/.bin/cf", ["--profile", name, ...args],
  { encoding: "utf8", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account } }));
if (existsSync(".secrets") && readFileSync(".secrets", "utf8").includes("ITERATE__CLOUDFLARE__API_TOKEN="))
  throw new Error(".secrets already has a token");
const groups = cf("accounts", "tokens", "permission-groups", "list");
const group = (wanted) => {
  const names = [wanted, wanted.replace(/ Write$/, " Edit")].map((n) => n.toLowerCase());
  const found = groups.find((g) => names.includes(g.name.toLowerCase()));
  if (!found) throw new Error(`no permission group ${wanted}; near: ${groups.map((g) => g.name)
    .filter((n) => n.startsWith(wanted.split(" ")[0])).join(", ")}`);
  return { id: found.id };
};
const onAccount = `com.cloudflare.api.account.${account}`;
const policies = [
  { effect: "allow", resources: { [onAccount]: "*" }, permission_groups: ["Workers Scripts Write",
    "Workers KV Storage Write", "Workers R2 Storage Write", "D1 Write", "Workers Containers Write",
    "Artifacts Write", "Account Settings Read", "Workers Tail Read", "Workers Observability Read",
  ].map(group) },
  // every zone of the account, so a domain bought in step 3 is covered too
  { effect: "allow", resources: { [onAccount]: { "com.cloudflare.api.account.zone.*": "*" } },
    permission_groups: ["Workers Routes Write", "DNS Write", "Zone Read"].map(group) },
];
const token = cf("accounts", "tokens", "create", "--body", JSON.stringify({ name, policies }));
appendFileSync(".secrets", `ITERATE__CLOUDFLARE__API_TOKEN=${token.value}\n`, { mode: 0o600 });
console.log(`made token ${token.name} (${token.id})`);' iterate-<folder> <account id>
```

A missing permission group stops it and lists the near names: use the matching one and run it
again. The token is part of the deployment's config (`cloudflare.apiToken`): the deploy runs with
it, and the Worker keeps it. Check that it works; this lists the account:

```bash
(set -a && . ./.secrets && curl -s https://api.cloudflare.com/client/v4/accounts \
  -H "Authorization: Bearer $ITERATE__CLOUDFLARE__API_TOKEN")
```

If cf refuses to list permission groups or make the token, the user makes it by hand instead:
`open` https://dash.cloudflare.com/?to=/:account/api-tokens, **Create Token**, **Create Custom
Token**, named `iterate-<folder>`, with these permissions on the **Account** unless the row says
**Zone**, and **All zones from an account** under **Zone Resources**:

- **Edit**: Workers Scripts, Workers KV Storage, Workers R2 Storage, D1, Workers Containers,
  Artifacts
- **Read**: Account Settings, Workers Tail, Workers Observability
- On the **Zone**: **Edit** Workers Routes and DNS, **Read** Zone

They copy it, and you write it from the clipboard, so it never appears in chat:
`(umask 077 && printf 'ITERATE__CLOUDFLARE__API_TOKEN=%s\n' "$(pbpaste)" >> .secrets)` on macOS
(on Linux, `wl-paste` or `xclip -o -selection clipboard`).

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
- Workers Paid has no check of its own: the Artifacts check above fails without it, and a
  successful deploy proves it.

### Pick a domain

Settle the domain now: it decides the OS's origin, which is the OAuth issuer every sign-in is
bound to. List the zones the token reaches:

```bash
(set -a && . ./.secrets && curl -s \
  "https://api.cloudflare.com/client/v4/zones?account.id=<account id>&per_page=50" \
  -H "Authorization: Bearer $ITERATE__CLOUDFLARE__API_TOKEN")
```

Each has a `name`, a `status` and an `id` (the zone id for step 4). Look at each one's records
(`GET https://api.cloudflare.com/client/v4/zones/<zone id>/dns_records`, same header) to see
whether anything uses it. Show the user the list and ask: one of these, a new one (bought below),
or none. For a domain that has records, show them too, and ask which of these iterate does with it.
End your turn.

- **Take it over**, as a new domain always is: every name under it and its mail, as your first
  message said. A site or mail already there stops answering: step 4 shows the records it would
  replace before deleting them, and step 5 the mail records.
- **Share it**, when the user keeps a site or mail there: the OS on `iterate.<domain>` alone. In
  step 4, route only `iterate.<domain>/*`, make only the record `iterate.<domain>`, set `urls.os`
  alone, and skip the domain's own mail in step 5 and step 6's `projectHostnames`. Projects then
  live at `https://iterate.<domain>/projects/<project>/`, and their apps share the OS's origin, as
  without a domain.
- A `pending` zone is waiting for its nameservers to change at the registrar. Wait for `active`,
  which can take hours.
- A domain the user owns elsewhere: add-site ([links](#enable-workers-paid-and-r2)), then the same
  wait.

### Buy a domain

Cloudflare's Registrar API buys a domain in seconds, at cost, through step 2's sign-in. The deploy
token can't, and mustn't: the Worker keeps it, and a deployment must not be able to spend money.

1. Ask the user for a few names, or suggest some (their name or handle on `.com`, `.dev`, `.app`).
   Check them, up to 20 at once:

   ```bash
   CLOUDFLARE_ACCOUNT_ID=<account id> pnpm exec cf --profile iterate-<folder> \
     registrar registrations check <name> <name>
   ```

   Each answers `registrable`, with `pricing` (`registration_cost`, `renewal_cost`) when it is and a
   `reason` when it isn't. Show the user each registrable name with both prices, and say it renews
   every year on the account's card and can't be refunded. Ask which to buy, and end your turn. Buy
   only a name the user picked, at the price you showed: check it once more right before, and if
   the price moved, ask again.

2. Buy it, and turn auto-renew on (the API leaves it off, and a domain that lapses takes the OS's
   origin with it):

   ```bash
   CLOUDFLARE_ACCOUNT_ID=<account id> pnpm exec cf --profile iterate-<folder> \
     registrar registrations create <name> --force
   CLOUDFLARE_ACCOUNT_ID=<account id> pnpm exec cf --profile iterate-<folder> \
     registrar registrations update <name> --auto-renew
   ```

   `--force` skips cf's own prompt, which your shell can't answer: the user's answer in chat is the
   confirmation. `create` is done at `"state":"succeeded"`. If it is still running, poll
   `registrar registrations get-registration-status <name>` (same prefix); at `action_required` or
   `failed`, stop and show the user what it says. The account's first purchase fails until it has a
   default registrant contact and the user has accepted the Domain Registration Agreement: send
   them the registrations page ([links](#enable-workers-paid-and-r2)), end your turn, then run
   `create` again.

   If `update --auto-renew` is refused, don't stop for it: tell the user to turn auto-renew on for
   the domain on the registrations page ([links](#enable-workers-paid-and-r2)) when they can, carry
   on, and remind them in step 9.

3. Wait for the zone: `GET https://api.cloudflare.com/client/v4/zones?name=<name>`, with the deploy
   token, until it shows `"status":"active"`. If no zone appears within a few minutes, the user adds
   the domain at add-site; it goes active at once, as its nameservers are already Cloudflare's.

4. Tell the user to look for ICANN's mail to the registrant address and confirm it within 15 days.
   If they don't, the domain is put on hold, and the OS's origin stops answering.

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

With a domain taken over, the Worker takes the whole zone. The OS moves to `iterate.<domain>` and
MCP to `mcp.<domain>`, and every project gets names of its own under the domain, each an origin of
its own (`ingressRouting`):

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
  urls: {
    ...base.urls,
    os: "https://iterate.<domain>",
    mcp: "https://mcp.<domain>",
    ingressRouting: { type: "subdomains", hostname: "<domain>" },
  },
  login: {
    ...base.login,
    methods: { ...base.login.methods, emailCode: { from: "iterate <login@mail.<domain>>" } },
    allow: [{ email: "<the user's email>" }],
  },
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

Each project is then `<project>.<domain>`, its apps `<app>--<project>.<domain>`, and when iterate
took the domain over, its address `<project>@<domain>` (step 5 sets up the mail). No project may be
called `iterate`, `mcp` or `www`: the deployment answers on those names itself. In step 6,
`www.<domain>` becomes the first project's homepage.

`resourcePrefix` is `iterate`, unless the account already has an iterate; it names the Worker and
its D1, R2 and Artifacts namespace.

Without a domain, people sign in with a password: their email and the password. With one, the
config adds a six-digit code mailed from `login@mail.<domain>` (step 5): the sign-in page leads with
it, and the password stays the alternate, should mail fail. Keep these methods.
`login.allow` is the user's answer in step 2 (who may sign in), one rule each:
`{ email: "a@b.com" }` for one address, `{ emailDomain: "b.com" }` for everyone at that domain. No
answer, no config: ask again. A shared password alone suits people who trust each other;
`core/os/SELF-HOSTING.md` ("Sign-in") has the provider sign-ins too.

`core/os/.secrets` (mode 600) holds the rest, one `NAME=value` line each, after the token line from
step 2:

- `ALCHEMY_STAGE`: the Worker's name, `iterate` (the `resourcePrefix`). Every Alchemy command acts
  on it.
- `DO_NOT_TRACK=1`: Alchemy's CLI sends its authors no telemetry.
- `ITERATE__ADMIN_BEARER`: `openssl rand -hex 32`. Operator access to every project over `/api`
  (`/mcp` refuses it). You use it to find the user's project and to add voice.
- `ITERATE__SECRETS_ENCRYPTION__KEY`: `openssl rand -hex 32`. It encrypts project secrets at rest;
  losing it loses them.
- `ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD`: `openssl rand -base64 18`. The sign-in password
  (with a domain, the alternate to the mailed code).

Leave every other field to its default. Generate the values with a script that appends them to the
file and prints nothing. Never print them in chat.

Whenever the user is about to sign in (steps 6 and 8), copy the password to their clipboard: without
a domain it is how they sign in, and with one it is the way in if the code doesn't come:
`sed -n 's/^ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD=//p' .secrets | tr -d '\n' | pbcopy` on
macOS (on Linux, `wl-copy` or `xclip -selection clipboard` in place of `pbcopy`). Tell them it's on
their clipboard, that it lives in `.secrets` (give its absolute path), and to save it in their
password manager when the browser offers.

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

### Mail on the domain

With a domain, now that the Worker exists, set up its mail. Each command with
`CLOUDFLARE_ACCOUNT_ID=<account id> pnpm exec cf --profile iterate-<folder> -z <domain>` in front.

Sign-in codes, taken over or shared: the deployment mails them from `login@mail.<domain>`, a
subdomain of its own, so no project's mail can pass for them. This adds sending records under
`mail.<domain>` only:

```bash
email-sending subdomains create --name mail.<domain>
```

When iterate took the domain over, every project's address too, `<project>@<domain>`: mail to it
lands on the project's `/integrations/email`, and the project sends from it. If the zone already
has MX records, show them to the user and ask first: these replace them.

```bash
email-routing enable    # the domain's MX and SPF records; `--name` is for a subdomain, so none here
email-routing rules catch-all update --enabled --matchers '[{"type":"all"}]' \
  --actions '[{"type":"worker","value":["<resourcePrefix>"]}]'    # every address, to the Worker
email-sending subdomains create --name <domain>    # its DKIM, return path and DMARC records
```

`email-sending subdomains list`, then `email-sending subdomains dns status <its id>` for each,
shows when the sending records are in place. Wait for them before step 6: a mail sent before then
is refused (`destination address is not a verified address`).

### Sign out of Cloudflare

Delete step 2's sign-in (without a domain, straight after step 3). The deploy token is all the rest
of the setup needs, and nothing that can make tokens or buy domains stays on the machine:

```bash
pnpm exec cf auth delete iterate-<folder>
```

## 6. First sign-in and project

Signing in at the origin creates nothing: the organization and project are created on the consent
page, when an app connects. Send the user to the dash's connect page for the origin,
`https://dash.iterate.com/.auth/connect?issuer=<origin, URL-encoded>&login_hint=<their email,
URL-encoded>` (the hint fills the email in on the sign-in page); opening the origin itself goes
there too. Copy the password to their clipboard first (step 4). They click Continue and sign in:
with a domain, with the code mailed to them (the link fills their email in); without one, with
their email and the password. The first mail from a new domain often lands in spam: if the code
isn't in their inbox within a minute, they look there, or use the password instead (the page
offers it, and it is on their clipboard). Then they name the
organization and project on the consent page (with a domain taken over, the project's name is its
`<project>.<domain>`, and `iterate`, `mcp` and `www` are taken). Wait for them, then find the project and the email
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

When iterate took the domain over (step 3), make `www.<domain>` the project's homepage now: add
`projectHostnames: [{ hostname: "www.<domain>", project: "<its id, prj_…>" }]` to `urls` in
`iterate.config.local.ts` (by id: a slug stops matching when the project is renamed) and run
`pnpm run deploy` again. `www.<domain>` then serves the project's homepage, and `<domain>` and
`<project>.<domain>` go there; its apps stay `<app>--<project>.<domain>`, and the dash's buttons and
`itx.url` use these. A deploy takes a few seconds to reach every Cloudflare location: until then
`www.<domain>` still answers `421`.

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

- The deployment's MCP URL, `<mcp>`, is `https://mcp.<domain>` with a domain taken over, else
  `<origin>/mcp`. Register it as a remote HTTP MCP server in the client you are running in, and
  only that one, e.g. Claude Code: `claude mcp add --transport http -s user iterate-<name> <mcp>`,
  with the domain or the `workers.dev` subdomain as the name. Don't set up the user's other clients; the final message
  tells them how.
- Registering may open the sign-in page by itself (e.g. `codex mcp add` does). If it does, don't
  also `open` it or run a separate login command: that pops open the same page twice and confuses
  the user.
- The user signs the client in through the browser, as in step 6 (the mailed code, or the password,
  which you copy to their clipboard again first). E.g. in Claude
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
- the project's homepage: `https://www.<domain>/` when iterate took the domain over (with its
  apps at `https://<app>--<project>.<domain>/`), `<origin>/projects/<project>/` otherwise;
- when iterate took the domain over, the project's address, `<project>@<domain>`: mail to it lands
  on the project, which can answer from it;
- with a domain you bought: that it renews every year on the account's card (or, if the API refused
  auto-renew, that they turn it on), and, until they have, that they must confirm ICANN's mail;
- `<mcp>` (remote HTTP) for other clients, and that each client signs in the same way (the mailed
  code, or their email and the password);
- where the config and secrets are (`iterate/core/os/iterate.config.local.ts`,
  `iterate/core/os/.secrets`), that `.secrets` is the only copy, and how to update
  (`git pull`, `pnpm install`, then `pnpm run deploy` in `core/os`);
- that `iterate/core/os/public/teardown-prompt.md` removes everything again, for their agent to
  follow.

## A domain later

A deployment that started on workers.dev can move to a domain. Sign in to Cloudflare (step 2's `cf
auth create`; a deploy token without zone permissions needs replacing too), pick or buy one (step
3), add the domain's parts of step 4, run `pnpm run deploy`, then set up its mail and sign out (step
5). Keep `cloudflare.workersDev` on (the default) until nothing uses the old origin. `urls.os` is
the OAuth issuer, so every sign-in moves with it: the user connects the dash again at
`https://dash.iterate.com/.auth/connect?issuer=<new origin>`, and each MCP client is added again at
the new MCP URL (`https://mcp.<domain>`) and signs in. Users and projects stay; their addresses move
to `<project>.<domain>`. Then make `www.<domain>` the first project's homepage (step 6) and deploy
again.

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
