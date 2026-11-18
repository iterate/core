# The iterate CLI

The `iterate` command: each call talks to one mind, addressed by its domain (`iterate/mind-api`),
and a machine keeps a [profile](#profiles) for each mind it uses.
Requires Node >=22.18; no Bun runtime. It is part of the SDK's package, [`iterate`](../../README.md),
and every connection it makes is the Node client's ([`iterate/node`](../node.ts)).

```sh
npx iterate                               # offline help
npx iterate deploy                        # a new mind in your own Cloudflare account
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
`https://iterate.<address>/api`, and its issuer is whatever the API's protected-resource metadata
names (RFC 9728): the CLI finds it, registers itself there (RFC 7591), and signs in with PKCE and a
loopback callback for the API as the resource (RFC 8707). The sign-in is kept per resource in
`${XDG_CONFIG_HOME:-~/.config}/iterate/sessions.json`, mode 600, and refreshed before a connection
when it ends within the minute. `ITERATE_MIND_TOKEN` supplies a token for scripts and replaces
the sign-in. `ITERATE_SKIP_BROWSER_OPEN=1` prints the sign-in URL without opening a browser.
`logout` ends the sign-ins at the issuer, when it can revoke, and forgets them.

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

`iterate deploy` puts a new mind into your own Cloudflare account, at its own domain. It is one
program with no model in it: it asks for the account and the domain, and does the rest. Its code is
[deploy.ts](deploy.ts) and [cloudflare-access.ts](cloudflare-access.ts).

```sh
npx iterate deploy                                   # a person at a terminal: two questions
npx iterate deploy --new-account --domain ada-labs.com --buy
CLOUDFLARE_API_TOKEN=… npx iterate deploy --account <id> --domain example.com --owner you@example.org
```

What it does, in order:

1. **The stack's source.** It fetches [iterate/core](https://github.com/iterate/core) into
   `${XDG_CACHE_HOME:-~/.cache}/iterate/core` and installs it with pnpm (through `npx` when pnpm is
   not installed), while you sign in. In a checkout of the source it deploys that checkout.
   `--source <folder>` names a checkout, `--ref <branch or commit>` another version. It needs git.
2. **Cloudflare.** You approve a code on Cloudflare's page (the device flow, with the `cf` CLI's
   public client: no secret, no server of iterate's). The access lives about an hour and is not
   renewed. It is kept in the CLI's config folder until a deploy works, then revoked, so a second
   run asks for no second approval. `CLOUDFLARE_API_TOKEN` replaces the sign-in ([the permissions
   it needs](../../../alchemy/README.md#the-api-token)).
3. **The account.** One you have, or a new one in your name (`--new-account`): Cloudflare allows a
   login five extra accounts. Cloudflare then asks once more, for the new account.
4. **The domain.** A domain of the account, a new one that Cloudflare's registrar sells, or one
   from another registrar, whose nameservers you then change. It asks the registrar about up to
   20 names made from your name (the "-erate" names first, as iterate's is) and lists the free
   ones with their price a year. You can type a domain, or a few words to get more names. It asks
   before it buys; `--buy` is the yes. The mind takes the whole domain, and the owner's own address must
   be elsewhere.
5. **Workers Paid and R2.** It opens the page for each one that is off and waits until it is on.
6. **The deploy**: `pnpm run deploy` of [core/alchemy](../../../alchemy/README.md), with a config
   that names you as the only member. On a dev zone the whole command took 1 min 41 s, and 2 min 10 s when the new state store refused the first try.

After the deploy, with a person at the terminal, it does the mind's first steps:

1. **The passkey and the first sign-in.** It opens one page of your mind, with a link that works
   once, within 24 hours. You add your passkey there, and the same page then signs this terminal
   in (`iterate login`). A passkey is made in a browser: the CLI cannot make one.
2. **What pays for the model:** a ChatGPT Plus or Pro plan ([A ChatGPT plan](#a-chatgpt-plan)), an
   OpenAI API key that you paste on a page of your own mind, or nothing now.
3. **The onboarding agent answers.** It says "hi" to `/agents/onboarding` and waits for the
   model's answer, up to 50 seconds. With none it says why, and step 2 comes again.
4. **The MCP server.** It offers to add `https://iterate.<domain>/mcp` to Claude Code and Codex,
   whichever is installed, under the domain's name (`ada-labs-com`) for the whole user, and says how each one signs
   in.

`--no-setup` leaves these steps out, and so does a run with nobody at the terminal: it then
prints the link alone. The first sign-in comes back to this computer's browser: over SSH, use
`--no-setup`, then `iterate login --device`. The config, the log and the name of the stack are in
`${XDG_CACHE_HOME:-~/.cache}/iterate/deploys/<name>/`.

- **It handles the expected way alone.** A run that stops says why. Run it again: each step reads
  what the account has, and a deploy keeps what it made. A coding agent can run and supervise it:
  with nobody at the terminal each choice comes from its flag (`iterate deploy --help`), and a
  missing one is named.
- **No telemetry and no Cloudflare connection for the mind after a sign-in.** Both make API tokens
  of the account, and Cloudflare's public client offers no such scope. With a token of your own
  that may make API tokens, `--api-tokens` turns both on.
- **Sandboxes start on Cloudflare's small image** (Node and npm). `--sandbox-image published`
  copies iterate's full image into the account during the deploy, about 1.6 GB through this
  computer.
- **It is for a new mind.** To update one, deploy from its stored config
  ([core/alchemy](../../../alchemy/README.md#the-stored-config)). A deploy over a mind that this
  command made writes its config again, with the owner as its only member.
- `--no-cloud` leaves iterate Cloud out of the mind's config: no GitHub, Google or Slack client of
  iterate's.

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
target is it. The route matches the name's host, `<name>.<address>` (`requestMatcher: {
routingSlug }`), or with `--hostname` that one hostname alone (`url: { hostname }`). By default
only signed-in visitors get through. The route lives as long as the lend: Ctrl-C deletes it, and a
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
await mind.provide(`itx.tunnels.${routingSlug}`, new LocalSite(), {
  fetchRoute: {
    fetchRouteName: `tunnel-${routingSlug}`,
    requestMatcher: { routingSlug },
    authRequirement: null,
  },
});
console.log(`https://${routingSlug}.${address}/`);
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
  prints a link to `iterate.<mind>/keys/enrol`. A member of the mind opens it, signs in and presses
  Allow, which asks for their passkey: the passkey signs the key and what it may do. The bridge
  waits for that, for 15 minutes, and then connects.
- **Every later run** connects with no person. Each connection asks the mind for a token with a
  statement the key signs. The token lives one hour and there is no refresh token: when it ends,
  the connection closes and `provide` connects again with a new one.
- **The key may do one thing:** lend `itx.<name>`, the name it was allowed for. Its `itx` has
  `provide` and nothing else, so the file cannot read or write the mind through it. With
  `--paths /integrations/whatsapp/` the link also asks for those paths, and the file's default
  export gets `append(path, { type, payload })`: it adds an event there, signed by the key.
- **The key has no end date.** The member who allowed it sees it on `iterate.<mind>/keys`, with
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
iterate whoami                             # example.com
iterate --config lab whoami                # example.org
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
