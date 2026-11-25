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
- A mail to an address of the mind is an event, and no method: the platform stores the mail's
  files under `/email/`, appends `events.iterate.com/email/received` on `/integrations/email`,
  once for each mail, and `processEvent` gets it: replies and agents react there. To send the
  original on, as it arrived, append a request there when the mail's event comes:

  ```ts
  await itx.cd("/integrations/email").append({
    type: "events.iterate.com/email/forward-requested",
    idempotencyKey: `forward:${mail.raw.path}:a@b.c`,
    payload: { raw: mail.raw.path, to: "a@b.c" },
  });
  ```

  `to` is an address that a person verified as a destination in the mind's Cloudflare account.
  The platform forwards only while the mail's delivery is open, about 10 s from its receipt, and
  answers with `email/forwarded` or `email/forward-failed` (its `error` says why: Cloudflare
  forwards no mail whose sender it did not prove). When that time is up the platform appends
  `email/forward-requests-closed` for the mail: a request after that fact on the log is never
  served and gets no answer. Code whose forward must not be lost reads the log from the mail's
  event to its own request, and sends a copy with `itx.email.send` when the fact comes first.
  Only a request that `worker.ts` itself appends counts, or a member's at the root: an agent's
  is refused (`iterate/email` has the events).

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
