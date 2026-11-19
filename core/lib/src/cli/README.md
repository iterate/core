# The iterate CLI

The `iterate` command: each call talks to one mind, addressed by its control-plane hostname
(`iterate/mind-api`; `example.com` is read as `iterate.example.com`),
and a machine keeps a [profile](#profiles) for each mind it uses.
Requires Node >=22 (Node 24.7+ for creating or verifying ML-DSA-65 identity keys); no Bun runtime. It is part of the SDK's package, [`iterate`](../../README.md),
and every connection it makes is the Node client's ([`iterate/node`](../node.ts)).

```sh
npx iterate                               # offline help
npx iterate deploy                        # a new mind in your own Cloudflare account
npx iterate cloudflare sign-in --file f  # a kept sign-in, for deploys with nobody at the page
npx iterate identity show example.com     # the mind's id, and where its identity key is
npx iterate login example.com             # sign in, and make it the profile's mind
npx iterate login example.com --device    # approve from a phone, when the issuer offers it
npx iterate whoami
npx iterate repl --context /notes         # local Node REPL
npx iterate itx run --eval 'return await itx.whoami();'
npx iterate mcp claude                    # the command that adds the mind's MCP server to Claude Code
npx iterate use-my-computer --name myComputer
npx iterate tunnel 5173 --name blog       # a local port on blog.<address>
npx iterate provide ./whatsapp.ts         # a local file's functions as itx.whatsapp
npx iterate chatgpt connect example.com   # a ChatGPT plan pays for the mind's Responses requests
npx iterate logout
npx iterate fs read ./notes.md            # a file's bytes on stdout; also write, stat, lstat, ls, mkdir, mv, rm
```

`--mind <address>` names another mind for one command. A mind's API is
`https://<address>/api`, and its issuer is whatever the API's protected-resource metadata
names (RFC 9728): the CLI finds it, registers itself there (RFC 7591), and signs in with PKCE and a
loopback callback for the API as the resource (RFC 8707). The sign-in is kept per resource in
`${XDG_CONFIG_HOME:-~/.config}/iterate/sessions.json`, mode 600, and refreshed before a connection
when it ends within the minute. `ITERATE_MIND_TOKEN` supplies a token for scripts and replaces
the sign-in. `ITERATE_SKIP_BROWSER_OPEN=1` prints the sign-in URL without opening a browser.
`logout` ends the sign-ins at the issuer, when it can revoke, and forgets them.

In a sandbox of a mind the CLI needs no sign-in and no profile. The platform sets `ITERATE_MIND`
(the mind's address) and `ITERATE_SANDBOX` (the sandbox's context path) for each command. With
both set, and no `--mind` and no `ITERATE_MIND_TOKEN`, the CLI sends no bearer, and the sandbox's
egress serves the API as the code of the sandbox's own context. The variables are a hint and no
credential: on any other computer they give a 401. `provide` there lends on the sandbox's context
and prints `itx.cd("<sandbox path>").<name>`. A sandbox whose requests the mind filters (a rule for
`itx.fetch`) gets no such session, and the CLI says so. `tunnel` does not work from that session
yet: its fetch route rides a member's lend on `/`.

### Login without a browser

`iterate login --device` signs in a computer whose browser nobody sees, such as a remote machine or
an agent's, when the mind's issuer offers the device flow (RFC 8628,
`device_authorization_endpoint` in its metadata). The person opens the printed page on any device,
or scans the QR code, checks the code and approves. It is the default over SSH (`SSH_CONNECTION`),
on Linux with no display, and under a coding agent; `ITERATE_LOGIN_FLOW=browser` or `=device`
overrides that. With an issuer that does not offer it, the CLI prints the loopback flow's URL
instead, which needs this machine's localhost. Every login prints whom it signed in.
`--expect-user` ends and discards a session for anyone else.

In a terminal with colors, the QR code is drawn as `qrencode -t ANSI` draws it; without colors (a
pipe, `NO_COLOR`, `TERM=dumb`) as half blocks in the text color. `FORCE_COLOR=1` forces the colors.
The link under the code works everywhere.

## Deploy a mind

`iterate deploy` puts a mind into your own Cloudflare account, at its own domain. It is one
program with no model in it: it asks for the account and the domain, writes the one input of the
stack's script ([core/alchemy](../../../alchemy/README.md)), and runs that script from this
computer. Its code is [deploy.ts](deploy.ts) and [cloudflare-access.ts](cloudflare-access.ts).

```sh
npx iterate deploy                                   # a person at a terminal: two questions (no telemetry token needed)
npx iterate deploy --new-account --domain ada-labs.com --buy
npx iterate deploy --domain example.com --telemetry-token    # turn on telemetry tables later (prints dashboard link)
CLOUDFLARE_API_TOKEN=… npx iterate deploy --account <id> --domain example.com --owner you@example.org
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_TELEMETRY_API_TOKEN=… npx iterate deploy --account <id> --domain example.com --owner you@example.org
```

What it does, in order:

1. **Cloudflare.** You approve a code on Cloudflare's page (the device flow, with the `cf` CLI's
   public client: no secret, no server of iterate's). The access lives about an hour and is not
   renewed. It is kept in the CLI's config folder until a deploy works, then revoked, so a second
   run asks for no second approval. `CLOUDFLARE_API_TOKEN` replaces the sign-in.
   - The sign-in asks for what one deploy of the stack needs and for nothing more (never "Account
     API Token Provisioning"): `STACK_SCOPES` in [cloudflare-access.ts](cloudflare-access.ts) says
     which resource needs each scope.
2. **The account.** One that you selected on Cloudflare's page, or a new one in your name
   (`--new-account`): Cloudflare allows a login five extra accounts. An approval covers only the
   accounts selected on that page, so for a new account, or one you did not select, Cloudflare
   asks once more.
3. **The domain.** One unified list puts **Buy a brand new domain** at the top (available names
   made from your name with their yearly price, plus **Enter a brand new domain name and buy
   that** to type a domain or keywords) and **Use an existing cloudflare zone** right below it. It
   asks before it buys, with the price; `--buy` is the yes. Cloudflare charges the account's
   payment method and registers the domain to the account's contact. Both are set on Cloudflare's
   own pages: an account that never registered a domain is sent to the page for its contact details
   first, and a purchase that Cloudflare refuses says why and opens the page where that is set.
   A domain from another registrar you add on Cloudflare's own page, and the command waits until
   the account has it. The mind takes a whole domain that nothing else uses (a new one is
   best; a subdomain works when it is a zone of its own). A domain of the account with a route of
   another Worker, or with an A, AAAA, CNAME or MX record, is in use: the command says what is
   there and asks before it goes on. With your yes (or `--erase-records`) it erases every DNS
   record and Workers route of that domain, right before the deploy and after every other check.
4. **Telemetry API token (optional).** A deploy without `CLOUDFLARE_TELEMETRY_API_TOKEN` goes
   through with no prompt and no stop: the mind runs without the telemetry tables (`events`, `logs`,
   `spans`, and `metrics` SQL), and `itx.telemetry.query` answers `"telemetry tables are off: add a
telemetry token"`. To turn telemetry tables on (at first deploy or later), run
   `npx iterate deploy --telemetry-token` (which prints a pre-filled Cloudflare dashboard link for
   one account-owned token `iterate-<stage>-telemetry`, waits for Enter before opening it, and
   verifies the pasted token) or pass `CLOUDFLARE_TELEMETRY_API_TOKEN=<token>`. Once added, Alchemy
   keeps the token in the stack's encrypted state so later deploys and plans keep telemetry tables
   with no changes and without asking again. **Do not delete or roll this token:** the mind's
   telemetry tables keep the token they were made with, and a mind with a given token refuses a
   changed token.
5. **Workers Paid, R2 and Zero Trust.** It opens the page for each one that is off and waits
   until it is on. Off means Cloudflare refused the read, and the account's line shows its words.
   A read that failed is not a fact: a 429 or a 5xx is read again, and after three the command
   stops with nothing changed and says to run it again. An owner proves their address through Cloudflare Access, which needs the
   account's Zero Trust organization. When the account has none, the command first sets one up
   through Cloudflare's API, as the script would, with a team name that Cloudflare picks. When
   Cloudflare refuses that because Zero Trust was never turned on, it opens the account's Zero
   Trust page (`https://one.dash.cloudflare.com/<account id>/`): choose a team name and the Free
   plan there. Cloudflare may ask for a payment method and charges nothing for the Free plan.
   With nobody at the terminal it stops with that page's address. Whether Cloudflare allows the
   set-up through the API on an account that never had Zero Trust is not yet seen.
6. **The config**, which is the script's one input, written to
   `${XDG_CACHE_HOME:-~/.cache}/iterate/deploys/<stage>/config.json` and printed (with any
   sensitive keys redacted) to stdout after the deploy:
   - `controlPlaneHostname`: `iterate.<domain>`. `--control-plane-hostname` names another: the
     domain itself, or one label under it.
   - `ownerEmails`: the owner, who is the Cloudflare login unless `--owner` names another address.
     The address must not be at the mind's own domain.
   - `alchemy.stageName`, the middle of every resource's name (`iterate-<stage>-auth`): never
     asked. It is the domain with `-` for each dot, cut to 32 characters, with `z` first when
     the domain starts with a digit.
   - `topology: "full-cloudflare"`, and `cloudflare`: the account and the one domain.
   - `mail`: absent, unless `--mail-forward-to <address>` names where each mail to the mind is
     forwarded as it arrived ([core/alchemy](../../../alchemy/README.md#the-one-input)). The
     address must be a verified destination address of the account's Email Routing, which a
     person adds in the dashboard; while it is not, every mail to the mind fails for its sender.
   - `mindId`: for a new mind, the id of the identity that the command makes right before the
     deploy ([The mind's identity key](#the-minds-identity-key)). A mind that is there already
     keeps its own.
7. **The source.** It fetches [iterate/core](https://github.com/iterate/core) into
   `${XDG_CACHE_HOME:-~/.cache}/iterate/core` and installs it with pnpm (using local `pnpm` when
   its major version matches `packageManager`, otherwise `npx --yes <packageManager>`), while you
   sign in. In a checkout of the source it deploys that checkout.
   `--source <folder>` names a checkout, `--ref <branch or commit>` another version. It needs git.
   A source from before the one Alchemy script is refused, before anything changes.
8. **The deploy**: `pnpm run deploy --stage <stage> --yes` of core/alchemy. Its output goes to
   `deploy.log` beside the config. A new state store can refuse the run that made it ("State
   store request failed"): the command then deploys once more by itself. Any other failure prints
   the log's last lines and its path. Run the command again on the same computer: it goes on
   with that deploy ("A deploy that stopped", below). Then it reads the boundary Worker's
   settings again, up to five times two seconds apart, and checks that `DEPLOY_CONFIG` is the
   config it deployed and that `MAIL_FORWARD_TO` is there exactly when the config names
   `mail.forwardTo`. When all is held, one line says so, with the forward's address. When no read
   answers, a warning says that the check did not run; the deploy succeeded. A miss is a fault of
   the release, which a second run does not mend: its error comes at once, the command still does
   every later step, and then it ends non-zero with the same error, which asks for a report. Then the command waits until the sign-in
   page and the domain's own front page answered five times in a row. On a dev zone the whole
   command took 2 min 14 s (18 Nov 2026): the deploy 1 min 50 s, the wait 20 s.

**A mind that is there already.** When a route of the domain names a mind's boundary Worker, the
command reads that mind's own config from Cloudflare (the boundary Worker's variable `ITERATE`),
shows it, and deploys over it. The deploy starts from the whole config that the mind was deployed
with, which the stack keeps in the boundary Worker's variable `DEPLOY_CONFIG`, so every field
stays, the sandboxes' image and the mail forward among them. `--owner`,
`--control-plane-hostname` and `--mail-forward-to` each replace what the mind has;
`--mail-forward-to none` removes the forward. It asks first; `--yes` is the yes. No file of an earlier deploy is needed. A
run over a mind with a sandbox image planned no changes and took 29 s (18 Nov 2026).

- A mind deployed before the stack kept `DEPLOY_CONFIG` is refused, with nothing changed: deploy
  it once with core/alchemy's script and its own config, then the command works over it.
- A mind of iterate's earlier stack (its boundary Worker has no variable `ITERATE`) is refused
  too. The command does not move such a mind, and never offers to erase its domain: iterate
  moves it.

**A deploy that stopped** before its end (a failure, or Ctrl-C) leaves the stack's state store
(the Worker `iterate-<stage>-state`) and what else it made, the domain's records among them, and
no mind yet. A destroy leaves the store too ([Erase a mind](#erase-a-mind)). When the account has
the store and no mind's boundary Worker, the next run decides by what is there:

- **This computer holds the config of that stage, account and domain** (`config.json` above,
  written by the earlier run): it says "This computer holds the config of an earlier deploy of
  this mind (…), and the account holds its stack's state store: going on with that config", and
  deploys with it: the same mind id, owners and hostname, but for what a flag names. It asks
  nothing about the domain's records and erases none. Its deploy takes over (Alchemy's
  `--adopt`) what the earlier one made and had not yet recorded in the state, such as a
  telemetry stream that was under way at the stop.
- **No such config, and nothing else of the stack**: the domain is not in use (a destroy leaves
  only a `_dmarc` record, which is no use) and the account holds none of the stack's other
  Workers. The store is a destroy's leftover: the command deploys a new mind there, with a new
  identity. This deploy takes over too: a stack that stopped before its first Worker and its
  first record reads the same from outside, and after a real destroy nothing is there to take
  over.
- **No such config, and more of the stack** (the deploy began on another computer, or the cache
  is gone): the command makes no second identity for the mind. It says what is there and stops,
  with nothing changed. Run it on the computer that began the deploy, or erase the half-made
  stack ("Erase a mind", with a config of that stage and account); the command then deploys a
  new mind there. `--erase-records` erases no record of a half-made stack.

When a deploy stops after the boundary Worker already exists, `${XDG_CACHE_HOME:-~/.cache}/iterate/deploys/<stage>/deploying.json`
stays on disk until `deployStack` finishes. Rerunning the same command on this computer resumes
that unfinished deploy without asking for `--yes`, passes `--adopt` to take over any resource
that was under way at the stop, and reports the mind as deployed (not updated) when finishing a
first deploy. Running from another computer (without `deploying.json`) treats it as a deploy over
an existing mind and asks before going on.

After the deploy, once the mind is answering and its identity is posted, the command prints a short
success message, waits for Enter, and opens `https://onboarding.<zone>/` in the browser to continue
setup there. With `--no-setup`, in non-interactive mode, or over SSH / headless Linux, it prints
`https://onboarding.<zone>/` without waiting or opening a browser.

**It handles the expected way alone.** A run that stops says why. Run it again on the same
computer: each step reads what the account has, and a deploy keeps what it made. A coding agent
can run and supervise it: with nobody at the terminal each choice comes from its flag
(`iterate deploy --help`), and a missing one is named.

### Deploy with nobody at Cloudflare's page: a kept sign-in

A CI job, or a script that updates your minds, deploys by the same command and the same sign-in
as a person. The person signs in once and keeps the sign-in; each deploy then renews it.
Hand a kept sign-in only to code that no pull request can change: the CLI and the stack from a
checkout of your own default branch (`node <checkout>/core/lib/bin/iterate.js deploy --source
<checkout>`), or a CLI release that only your default branch can publish. A CI run of a pull
request that can publish a package or push a mirror can also put its own code there.

```sh
npx iterate cloudflare sign-in --file ~/.iterate-cloudflare-sign-in.json      # once, a person
ITERATE_CLOUDFLARE_SIGN_IN_FILE=~/.iterate-cloudflare-sign-in.json \
  npx iterate deploy --account <id> --domain example.com --yes --no-setup < /dev/null
npx iterate cloudflare sign-out --file ~/.iterate-cloudflare-sign-in.json     # the end of it
```

- **`iterate cloudflare sign-in`** opens the deploy's page with the deploy's scopes and
  `offline_access`. Select only the mind's account.
  A grant that lacks a scope, or comes with no refresh token, is revoked and nothing is kept.
  `--file <path>` keeps it in a new file of mode 600. `--print` prints it as one JSON document
  on standard output, for a pipe into a secret store (`| doppler secrets set NAME > /dev/null`,
  `| gh secret set NAME`); it refuses a terminal. The tokens never go through a flag's value,
  which stays in the shell's history and in the list of processes.
- **`iterate deploy`** with `ITERATE_CLOUDFLARE_SIGN_IN_FILE=<file>` uses it as a sign-in: the
  same check of the granted scopes, the same words. It does not revoke it at its end.
  `CLOUDFLARE_API_TOKEN` set as well is refused. An account that the sign-in does not cover is a
  stop: nobody is there to approve another.
- **`iterate cloudflare sign-out`** revokes both tokens at Cloudflare and deletes the file (or
  reads the JSON on standard input: a secret store's copy is yours to delete). It lists the API
  tokens that deploys made in the accounts it reached (`iterate-<stage>-telemetry-catalog` and
  `-analytics`): **a token made through a sign-in outlives the sign-in's revocation** until you
  delete it. Deleting them turns off the mind's telemetry until its next deploy.
- **`iterate deploy --plan`** changes nothing: over a mind that is there, with the same sign-in,
  source and config as a deploy, it writes the stack's plan (one line a resource: `noop`,
  `update`, `create`, `delete`, …) to `plan.log` beside the deploy's config. A caller with nobody
  at the terminal reads it before it deploys.

**What a kept sign-in can do: everything that a deploy can, in the accounts you selected.** It
writes Workers, DNS records and every other resource of the stack, and cannot mint API tokens or
OAuth clients. Keep it where you keep a production secret: a file of mode 600 on a computer that
only you use, or a secret store. End it with `iterate cloudflare sign-out` when you no longer need
it.

**Each renewal replaces the refresh token** (Cloudflare's rotation, measured 18 Nov 2026). So:

- The command renews the access token when it has less than 20 minutes left, and writes the
  renewed sign-in to the file (a temporary file and a rename) before it uses it. From then on
  the earlier refresh token is stale: **copy the file back to your secret store after every
  run**, whatever its exit code.
- When the file cannot be written, the renewed sign-in goes to the CLI's config folder
  (`cloudflare-sign-in-renewed-<time>.json`) and the command stops: the words name both files.
  When that write fails too, the renewed sign-in is revoked and you sign in again.
- **One command at a time on one sign-in.** The command holds `<file>.lock` while it runs and
  refuses a second one. The lock sees only this computer: a secret store's caller runs one deploy
  for a sign-in at a time (GitHub Actions: one `concurrency` group for the jobs that use it).
- **A sign-in that no longer works** stops the command with exit code 3 and "The kept sign-in
  at Cloudflare in <file> no longer works (Cloudflare: …)". A person signs in again. An outage
  at Cloudflare exits 1 and leaves the file as it is.
- Not known: whether Cloudflare keeps the earlier refresh token alive for a while after a
  renewal, and how long a refresh token lives unused. Deploy at least once a week, and watch
  for exit code 3.

## Erase a mind

The CLI has no erase command. The stack's own script erases a mind, from the source that
`iterate deploy` fetched, with the config that it wrote. It cannot be undone: the mind's contexts,
files, repos, members and secrets are gone.

```sh
cd "${XDG_CACHE_HOME:-$HOME/.cache}/iterate/core/core/alchemy"
export ITERATE_MIND_CONFIG="${XDG_CACHE_HOME:-$HOME/.cache}/iterate/deploys/<stage>/config.json"
export CLOUDFLARE_API_TOKEN=…   # a token of the mind's account, or: pnpm exec alchemy login
pnpm run destroy --stage <stage> --yes
```

`<stage>` is the mind's domain with `-` for each dot (`ada-labs-com`): the folder name under
`deploys/`. `--yes` is for a run with nobody at the terminal. What a destroy leaves (the state
store, a `_dmarc` record, the account's Zero Trust team, the zones) is in
[core/alchemy's README](../../../alchemy/README.md#what-a-destroy-leaves).

## Recover an owner

`iterate recover --domain <domain> --owner <email>` is for an owner who has no passkey left. The
mind itself has no way back for an owner: whoever holds an owner's mailbox must not hold the
mind. So the proof is the mind's Cloudflare account, as it is for a deploy. Its code is
[recover.ts](recover.ts).

The command signs in to Cloudflare as `iterate deploy` does, and asks for much less: it reads the
domain, its routes and the boundary Worker's settings, and it writes to D1. It finds the mind by
its domain, checks that the address is one of the mind's owners, asks for a yes (`--yes`), and
then runs two statements on the auth Worker's database, `iterate-<stage>-auth-db`:

1. It revokes every passkey of that owner. A link opens nothing while one is live.
2. It adds one sign-in link, of which the database holds only the SHA-256 of its random ticket.

It prints the link, `https://<control plane>/keys/first#<ticket>`. The link works once, within 24
hours, and whoever opens it adds the owner's new passkey: pass it on as you would a password.
What the owner was signed in to (apps, terminals) stays signed in, and the owner ends it on the
mind's page `/sessions`.

## The mind's identity key

A mind's id is the SHA-256 of its first signed identity record, the genesis
([`iterate/mind-identity`](../mind-identity.ts)). The id stays when the mind's domain, its
Cloudflare account or its keys change. A root key that signed the genesis proves that the mind is
yours. Its code is [identity.ts](identity.ts).

`iterate deploy` makes the identity of a new mind with no question, after your last answer and
before anything is deployed. It needs Node 24.7 or newer for that, and says so at its start. It
writes two files to `${XDG_CONFIG_HOME:-~/.config}/iterate/identities/`, each mode 600 in a folder
of mode 700:

- `<mind id>.key.json`: the one root key, an ML-DSA-65 key, as its 32-byte seed. It has no
  passphrase. **Keep a copy of this file**: whoever has it can change the mind's root keys, and
  without it nobody can. The command prints its path once, at the end of the first deploy. The
  key is never printed and never leaves the computer.
- `<mind id>.json`: the signed records, oldest first. The genesis names that key alone, with
  threshold 1, and the control plane's hostname. The second lists the stack's working key.

Once the mind answers, the command posts the records that the mind does not publish yet to
`POST https://<control plane>/.well-known/iterate`. No sign-in is needed: a record proves itself.
After a 5xx answer or a fault of the network it asks again after 1, 2, 4, 8 and 16 seconds, and
after nothing else: a 4xx is the mind's last word. A post that fails does not fail the deploy: the
command says what failed, and `iterate identity post` posts again.

Then the command lists the stack's working key. The stack makes an ML-DSA-65 key in the deploy and
shows it at `https://<control plane>/keys/stack.json` as a candidate: until a record lists it, the
mind signs nothing as itself and takes no statement from another mind. When the last record does
not list that key, the command writes the next record (the last one's content, with that key as
its working key for statements), signs it with the key file, saves it with the others, and posts
it. A stack on a new database shows a new key, and the next post lists it in place of the old one.
The key is read over TLS from the mind's own hostname: whoever answers there gets their key
listed.

A deploy over a mind that has an id passes the id on, signs nothing and makes no key. From a
computer that holds the mind's records it posts what is missing, and the last record again even
when the mind has it: the mind then answers that it knows the record, and that request makes its
stack deliver the events that it still owes the mind's own log. From any other computer it asks
nothing and says nothing. `iterate recover` reads the mind's config and deploys nothing, so the id stays.

```sh
npx iterate identity show example.com   # the id, the last record's hostnames, the records here and published, the key file
npx iterate identity post example.com   # post the records here that the mind lacks, and the last one again
```

Both read the id from the log that the mind publishes, so the mind must answer.

## Files of this machine

`iterate fs <op>` is one file operation on the machine it runs on (`read`, `write` from stdin, `stat`,
`lstat`, `ls`, `mkdir [--recursive]`, `mv`, `rm [--recursive] [--force]`). A failure is one JSON line on
stderr, `{"code":"ENOENT","message":"…"}`, and exit code 1. It needs no sign-in. A sandbox's `files`
(`itx.sandboxes.get(path).files`) is this command run inside its container, over `exec`:
[fs.ts](fs.ts) is standalone (`node fs.ts <op>`), which is how the platform puts it there. The same
operations, as functions, are `files` of [`use-my-computer`](#use-my-computer): one implementation,
two entry points, so a file is streamed by one code path.

## Running scripts

`itx run` executes a JavaScript function body in the mind with `itx` in scope. Use `return` for
the result. The mind records the run and its settlement; the CLI never retries a script. Scripts
execute in the mind, so local Node APIs and local files are unavailable.

```sh
iterate itx run --context /notes --eval '
  await itx.append({ type: "note", payload: { text: "hello" } });
  return await itx.readEvents(0, 10);
'
iterate itx run --file ./script.js
cat script.js | iterate itx run --file -
```

Specify exactly one of `--eval` or `--file`. `--context` is a path in the mind (default `/`).

## Use my computer

`use-my-computer` shares this computer as a live capability of the mind until Ctrl-C. It is
[`provide`](#provide) of `use-my-computer.ts` (`iterate provide use-my-computer.ts --name
jonasComputer` lends the same object), with a friendly default name:

- `itx.myComputer.exec(argv, { cwd?, env?, stdin?, timeoutMs? })`: run a command; answers
  `{ exitCode, stdout, stderr }` as bytes.
- `itx.myComputer.files.read(path)` (a stream), `.write(path, content)`, `.stat`, `.lstat`,
  `.readDirectory`, `.mkdir`, `.rename`, `.remove`: the same code as `iterate fs`, which a
  sandbox runs in its container.
- On a Mac: `itx.myComputer.mac.ask({ question, buttons? })`, `.notify({ message, title? })`
  and `.runSwift({ code })` (AppleScript and Swift, with the owner's local permissions).
- `itx.myComputer.__describe()`: usage instructions and method signatures.

Share only with a mind you trust: its callers can run local code, and `files` reaches
everything you can. The capability belongs to the live connection and is released on exit. A
disconnect reconnects as `provide` does; when every attempt fails the command ends with an error.

## Tunnel

`tunnel <port>` serves `http://localhost:<port>` on a host of the mind until Ctrl-C, WebSocket
upgrades included (a Vite dev server's hot module reloading works through it):

```sh
iterate tunnel 5173 --name blog
# https://blog.example.com/ → http://localhost:5173 (mind members only). Press Ctrl-C to stop.
iterate tunnel 3000 --public   # anyone may use it; the name is random
iterate tunnel 3000 --name hello --hostname hello.tunnels.example.com
```

The URL alone goes to stdout; everything else goes to stderr. The tunnel lends the local port to
the mind as `itx.tunnels.<name>` with the fetch route `tunnel-<name>` (`itx.fetchRoutes`) whose
target is it. The route matches one hostname (`requestMatcher: { url: { hostname } }`):
`<name>.<the mind's first zone>`, or the one `--hostname` names. By default only signed-in visitors
get through. The route lives as long as the lend: Ctrl-C deletes it, and a
tunnel that dies without it leaves the host answering 502 until the mind notices, then the
route is gone too.

### Without the CLI

A tunnel is one capnweb session: lend the mind a fetch-shaped `RpcTarget` with a fetch route
to it (`provide`'s `fetchRoute`, which ends with the lend), and delete the route on exit.
This is the whole thing (`npm install capnweb@npm:@iterate-com/capnweb`):

```js
class LocalSite extends RpcTarget {
  async fetch(request) {
    const url = new URL(request.url);
    // a WebSocket upgrade: dial ws://localhost:<port>, bridge it through a WebSocketPair and answer
    // upgradeWebSocketResponse(visitor, { headers: { "Sec-WebSocket-Protocol": local.protocol } })
    // Node's fetch decodes a compressed body but keeps its content-encoding: ask for none
    const headers = new Headers(request.headers);
    headers.set("accept-encoding", "identity");
    return fetch(`http://localhost:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
    });
  }
}
// the route rides the lend: set again when the platform re-attaches it, gone when it ends
// `mind.url()` is the apex of the mind's first zone
const hostname = `${name}.${new URL(await mind.url()).hostname}`;
await mind.provide(`itx.tunnels.${name}`, new LocalSite(), {
  fetchRoute: {
    fetchRouteName: `tunnel-${name}`,
    requestMatcher: { url: { hostname } },
    authRequirement: null,
  },
});
console.log(`https://${hostname}/`);
```

## Provide

`provide <file>` lends a local file's functions to a mind as `itx.<name>` until Ctrl-C, for
code that has to run on this computer: a device on its network, a session tied to its IP, local
state. The file is `.ts`, `.mts`, `.mjs` or `.js` alike, imported by Node itself (which strips a
TypeScript file's types), and its default export answers the functions:

```ts
// whatsapp.ts
import makeWASocket from "baileys"; // from this file's own folder's node_modules

export const description = "My WhatsApp: sendMessage(jid, content) …"; // the line a model reads

let socket; // module scope lives as long as the process, across reconnects
export default function provide({ itx }) {
  // called on every connection with that connection's mind
  socket ??= makeWASocket({/* … */});
  return {
    sendMessage: (jid, content) => socket.sendMessage(jid, content),
    async note(text) {
      await itx.append({ type: "whatsapp/note-added", payload: { text } });
    },
  };
}
```

```sh
iterate provide ./whatsapp.ts                    # itx.whatsapp (the file's name)
iterate provide ./dummy.ts --name whatsappDummy
```

`itx.<name>` alone goes to stdout once it is live; everything else goes to stderr. The mind's
scripts and agents call it like any capability (`await itx.whatsapp.sendMessage(…)`); the file
reaches the mind through the `itx` it was handed.

- **Dependencies are the file's folder's.** Node resolves the file's bare imports from its own
  folder's `node_modules`, never the CLI's: install them there first (`npm install`, `pnpm
install`). A missing one is refused before any sign-in, naming the folder to install in. The CLI
  installs nothing.
- **Plain functions, no capnweb.** The CLI wraps the functions in its own `RpcTarget`: capnweb lends
  only its own copy's, which a file's own `capnweb` install is not. A plain object's own functions
  are lent, or a class instance's methods (never its fields). Arguments and answers cross as they
  are, so they must be plain data, bytes or stubs.
- **Every connection calls it again.** The CLI reconnects when its connection closes or the lend
  ends under it (for about five minutes, as `tunnel` does), calls the default export with the new
  connection's mind, and lends the answer at the same name. Keep long-lived state in module
  scope and reach the mind through the newest `itx`.
- **Share only with a mind you trust.** Its callers run the file's functions with this
  computer's authority. A killed or stopped `provide` takes the name with it: the mind's calls
  answer `NO_ITX_EXPRESSION_MATCH`, as before it was lent.

For a machine that stays up, the stored sign-in refreshes itself, and the issuer keeps the grant
for as long as it does: a grant ends after 7 days with no refresh, when its person stops being a
member, or when it is revoked. `ITERATE_MIND_TOKEN` takes a token as it stands.

#### A bridge that is not a person: `--key`

A stored sign-in acts as its person, with everything that person may do. A bridge that should
lend one capability and nothing else gets a key of its own:

```sh
iterate provide ./whatsapp.ts --key ~/.iterate/whatsapp.key --mind example.com
```

- **The first run** makes a P-256 key pair, writes the private half to the file (mode 600) and
  prints a link to `<mind>/keys/enrol`. A member of the mind opens it, signs in and presses
  Allow, which asks for their passkey: the passkey signs the key and what it may do. The bridge
  waits for that, for 15 minutes, and then connects.
- **Every later run** connects with no person. Each connection asks the mind for a token with a
  statement the key signs. The token lives one hour and there is no refresh token: when it ends,
  the connection closes and `provide` connects again with a new one.
- **The key may do one thing:** lend `itx.<name>`, the name it was allowed for. Its `itx` has
  `provide` and nothing else, so the file cannot read or write the mind through it. With
  `--paths /integrations/whatsapp/` the link also asks for those paths, and the file's default
  export gets `append(path, { type, payload })`: it adds an event there, signed by the key.
- **The key has no end date.** The member who allowed it sees it on `<mind>/keys`, with
  what it may do and the day it last asked for a token, and removes it there. After a removal the
  mind gives it no new token, and its open connection ends when its token does, within the hour.
- **The file is the bridge.** Whoever can read the key file can lend that name. Keep it on the
  bridge's machine alone. The private key is read in one function (`signer` in `bridge-key.ts`):
  a TPM, a Secure Enclave or the OS keychain would go there, so the key never leaves the hardware.

## A ChatGPT plan

`chatgpt connect [address]` lets a person's ChatGPT plan pay for the mind's Responses API
requests, with OpenAI's
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source). It needs a
personal Plus or Pro account. The sign-in must end at `http://127.0.0.1:1455/auth/callback` on the
computer the browser runs on, so the CLI listens there, opens OpenAI's consent page, and gives the
code to the mind. One `itx.run` script in the mind trades the code for tokens and keeps them
in `/secrets/chatgpt`, pinned to OpenAI's origins, and the secret refreshes itself. The tokens never
reach this computer. A Codex sign-in uses the same port: close it first. Without a sign-in to the
mind, the command runs `iterate login` first. Then it sends one test request on the plan, unless
`--no-test`. A new sign-in replaces the plan that the mind had.

## Profiles

One machine can hold several minds side by side. A profile names one mind. Profiles live in
`${XDG_CONFIG_HOME:-~/.config}/iterate/minds.json`, and the sign-ins in `sessions.json` beside it,
one per mind, so a sign-in to one mind never replaces another's. Selection order is `--config`,
the profile the current folder or a parent of it is mapped to, the default profile, the only
profile, then `default`. `iterate login <address>` points the selected profile at the mind.
`--mind <address>` names another mind for one command, with that mind's own sign-in.

```sh
iterate login example.com                  # the profile `default`
iterate config set --name lab              # a second profile
iterate --config lab login example.org     # sign it in; the first sign-in stays
iterate whoami                             # iterate.example.com
iterate --config lab whoami                # iterate.example.org
iterate --config lab provide ./whatsapp.ts # both can run at once, each in its own terminal
iterate config set --name lab --set-workspace   # in a folder: commands there use `lab`
iterate config use lab                     # make it the default
iterate config list
iterate config get
```

A command that needs a sign-in starts one when the profile's mind has none, `whoami` included.

## Node REPL

`iterate repl` opens a local Node REPL with the mind's context as `itx` (`--context`, default
`/`) and the transport's `RpcTarget` constructor. Top-level `await`, Node APIs and `.load` are
available. The bindings remain available after `.clear`; `.exit` releases the context and the
connection. A lost connection ends the REPL visibly; it never silently repeats your commands.

## Development

In this repository `pnpm exec iterate` runs the source (`src/cli.ts`); the launcher uses the
published build when installed through `npx`, or when `ITERATE_FORCE_BUILT_PACKAGE=1`.
