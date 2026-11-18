# The mind's own computer for code

The owner should come away with: their mind has its own computer for code, with git, Claude Code and Codex on it, ready for any agent in about a second.

## Ready today

- A sandbox is a Linux computer of the mind, a Cloudflare container. A new one has Debian, Node
  and npm alone. `sandboxes.md` says how the mind gets one with git, Claude Code and Codex: one
  sandbox installs them, a snapshot keeps its disk, and every later sandbox starts as a copy.
- A helper does it, `/agents/onboarding/sandbox` (`onboarding/helpers.md`), so the onboarding
  agent keeps talking. The build takes about two minutes.

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

## Say

- "Your mind now has its own computer for code: git, Claude Code and Codex are on it, and every
  agent gets a copy in about a second."
- With no key: "Claude Code and Codex are on it too. They need an API key to think, whenever you
  want that."
- Without Workers Paid: "Your mind gets its own computer for code once your Cloudflare account has
  Workers Paid."
