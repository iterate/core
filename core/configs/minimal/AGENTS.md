# Mind configuration

This repository is the mind's code. A commit to `main` publishes it: the platform loads
`worker.ts`, the `main` in `package.json`, and every context of the mind runs the new code.
This mind has no agents and no schedules.

A mind has three methods, and `worker.ts` implements each. From outside come `fetch` (every
request) and `email` (every mail). Inside, `processEvent` adds every event; outside parties also
append to the mind's contexts through its API at `/api`, which is why much of a mind's logic
lives in `processEvent`.

`worker.ts` extends `IterateConfigEntrypoint` from `iterate/sdk`:

- `processEvent({ event, itx })` sees every durable event of every context of the mind, one at
  a time, in no particular order and at least once, so each reaction must be idempotent. `itx` is
  the mind's root; `itx.cd(event.path)` is the event's own context. A case for
  `events.iterate.com/mind/worker-updated` runs after every published commit: that is the init
  hook.
- `fetch` serves every hostname of the mind's zones but its control-plane hostname, where the platform
  answers (sign-in, the API, MCP). Route on `new URL(request.url).hostname` in plain code: an
  app's hostname is `<label>.<zone>` (`blog.example.com`). A request a fetch route takes never
  reaches it: the platform sends it to the route's target first (`iterate tunnel <port>` sets a
  route per tunnel; `itx.fetchRoutes.set` sets one by hand).
- `email({ mail, save, forward })` runs for every mail to an address of the mind, while its
  delivery is live. The platform has stored the mail's files under `/email/` before.
  `await save()` keeps the mail: the platform appends `email/received` on
  `/integrations/email`, once for each mail, and `processEvent` gets it: replies and agents
  react there. A mail is off the log only when the hook returns without saving it: then only
  its files are kept, and no agent gets it. A save that the mind does not take rejects, and the delivery fails, so
  Cloudflare delivers the mail again. `await forward("a@b.c")` sends
  the original on, as it arrived, to an address that a person verified as a destination
  in the mind's Cloudflare account; it records `email/forwarded`, and throws a coded error otherwise
  (`EmailHookArgs` in `iterate/email`). A throw here, or a hook that runs past its time limit
  (15 s of its own: the wait for Cloudflare's answer to a forward does not count), or a class
  with no `email`, leaves the mail on the log: the platform records it, with an
  `email/hook-failed` fact beside it. Await each save and forward:
  both capabilities end when `email` returns, a call after that throws EXPIRED, and a forward
  that is still running then ends EXPIRED.

`worker.ts` reaches the mind through the `itx` that `processEvent` is handed, or through
`using itx = this.getItx()`: when the block ends, the scope, every call made through it and every
handle it awaited are released. Put it in the smallest block that holds its calls, await every
call inside it, and hand data, not handles, out of it; an object that needs reach takes an
accessor, `() => this.getItx()`. Never keep a value from `this.env.ITX.get()`, which nothing
releases: a kept value keeps the mind's context, and any facet holding it, resident after the
mind goes idle.

Files may be TypeScript or JavaScript and import each other by relative path. Import packages by
name: `iterate/*` and `zod` come from the platform; list any other package in `package.json` and
it loads from npm through esm.sh (packages that need Node.js builtins are refused). Type-check
locally with `npm install && npx tsc`; the loader strips types but never checks them.

## How the platform works

The source code of the platform is public at https://github.com/iterate/core. Read it before you
guess how a capability behaves. List the files first:
`https://data.jsdelivr.com/v1/packages/gh/iterate/core@main?structure=flat` (`files[].name`; the
list can be hours behind). GitHub's own list,
`https://api.github.com/repos/iterate/core/git/trees/main?recursive=1` (`tree[].path`), is exact, but
GitHub allows 60 listings an hour to everyone behind one address, so from a mind it often
answers 403. Then read `core/AGENTS.md`, then the file you need:
`https://raw.githubusercontent.com/iterate/core/main/<path>`. `main` can differ from the code this
mind runs: where they disagree, what a call answers is right.
