# The mind's own computer for code

The owner should come away with: their mind has its own computer for code, with git, Claude Code and Codex on it, ready for any agent in about a second.

## Ready today

- A sandbox is a Linux computer of the mind, a Cloudflare container. A new one has Debian, Node
  and npm alone. `sandboxes.md` says how the mind gets one with git, Claude Code and Codex: one
  sandbox installs them, a snapshot keeps its disk, and every later sandbox starts as a copy.
- A helper does it, `/agents/onboarding/sandbox` (`onboarding/helpers.md`), so the onboarding
  agent keeps talking. The build takes about two minutes.
- **A server in a sandbox gets a host of the mind**, `https://<name>.<domain>/`, with its pages
  and WebSockets. A request that finds it stopped starts it (`sandboxes.md`, "Serve a port at a
  host"). So the mind runs open-source software that the owner wants: a game for them and their
  friends, a wiki, a tool they would host themselves.

## Not ready

- Claude Code and Codex think only with an API key of the mind (`/secrets/anthropic`,
  `/secrets/openai`). The AI Gateway credit that pays for the mind's own agents does not reach
  them. Without a key they are installed, and say "Not logged in".
- A Cloudflare account without Workers Paid has no containers: a start answers `NO_SANDBOXES_YET`.

## How

You are the helper `/agents/onboarding/sandbox`, and this is your job. Do it yourself and start
no other agent.

1. Read `sandboxes.md` in the mind's code: `await itx.repos.get("/repos/config").readFile("sandboxes.md")`.
2. Run its script "Build or rebuild the snapshot" as it stands, in one script. If it fails, read
   the error, fix the cause, and run it again, at most twice more.
3. Run its script "Check it", as it stands. `tools` and `git` must be `ok: true`. `codex` and
   `claude` are `ok: true`, or say that their key is not set.
4. When an error says `NO_SANDBOXES_YET`, stop: the account has no Workers Paid.
5. Report with the rule of `onboarding/helpers.md`. Later, a message that asks for another tool
   or a rebuild is yours too: add the tool to `APT` or `NPM` in the build script, and run both
   scripts again.

### A server at a host

A message that asks for a server or a program at a link is yours too.

1. Start a new sandbox for it, `/agents/onboarding/sandbox/<name>`, from the snapshot
   (`sandboxes.md`, "Start a sandbox from the snapshot"). Never use `coding`, the snapshot's own.
2. Install the program there: apt, `git clone`, its install and its build. Long work goes to the
   background, and you poll its log (`sandboxes.md`, "Use it").
3. Write `/root/<name>/start.sh`: it runs the server in the foreground on one port, with
   absolute paths. Do not run it yourself: a server never ends, and `exec` gives up after a
   minute. The platform runs it, detached, when a request finds the port closed.
4. `await box.exposePort(<port>, { name: "<name>", command: ["bash", "/root/<name>/start.sh"] })`.
   It is for the mind's members. Add `public: true` only when the owner's words name people
   who are not members (friends, customers, anyone with the link). Anyone who opens a public
   link can start the sandbox.
5. Check it from code, as a visitor's request:
   `await box.container.invoke([["getTcpPort", <port>], ["fetch", new Request("https://<name>.<domain>/")]])`.
   The first request runs `start.sh` and waits up to 45 seconds. Any answer of the server's own
   is good, a redirect too. A 502 or a 503 is the platform's: the server did not start, and its
   output is in `/var/log/iterate-port-<port>.log`. Report the link, and with `public: true` say
   that anyone with it can open it.

## Say

- "Your mind now has its own computer for code: git, Claude Code and Codex are on it, and every
  agent gets a copy in about a second."
- With no key: "Claude Code and Codex are on it too. They need an API key to think, whenever you
  want that."
- Without Workers Paid: "Your mind gets its own computer for code once your Cloudflare account has
  Workers Paid."
- A server: "The game is live at https://game.<domain>/. Anyone with the link can play: send it
  to your friends. The first page after a quiet while takes a few seconds, while it starts."
