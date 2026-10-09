# @iterate-com/deployer

An iterate deployment on Cloudflare as an Alchemy stack, and the engine that runs it inside a
Durable Object. core/os deploys with it, from Alchemy's CLI (`core/os/alchemy.run.ts`) and from a
project's deployment facet (`core/os/src/deployment/run.ts`); the facet hands it a release, the
config's `cloudflare` section and the Worker's variables, and the engine plans, applies or
destroys the stack over Alchemy's state in the facet's SQLite.

| Module      | What it holds                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stack`     | `iterateStack(input)`: the platform Worker and every resource it binds, as Alchemy declares them. `StackInput` is a release directory, the `cloudflare` section and the variables. |
| `engine`    | Alchemy's engine as a host composes it inside a Durable Object: `runStack`, `hostLayer`, `cloudflareProviders` over one API token, `stageRelease` for a release zip.               |
| `state-sql` | Alchemy's `State` service over a Durable Object's SQLite (`ctx.storage.sql`).                                                                                                      |
| `names`     | `resourceNamesOf(cloudflare)`: what the Worker, its D1, KV namespaces, R2 bucket and Artifacts namespace are called, and the `cloudflare` section's shape as the stack reads it.   |
| `attempt`   | `attempt(input)`: one plan, deploy or destroy as a promise, for a host that composes nothing of Effect itself: a project's own deployment facet over the workerd build (below).    |

`engine` and `state-sql` import Alchemy, Effect and @effect/platform-node alone (the repository's
lint holds them to it): nothing of iterate's. The stack reads `iterate/compatibility-date`.

Built with tsdown, twice (tsdown.config.ts): `dist/`, one module per export with Alchemy, Effect
and @effect/platform-node left as imports, for a host that bundles the package itself; and
`dist/workerd/`, the same with those bundled in and the shims a Worker needs (Alchemy's dev-only
imports stubbed, `import.meta` defined, Node's modules by their `node:` names, no dynamic import of
a computed specifier), which a project's config repo vendors as it is and a facet of its own imports
(`attempt`): the `deployment-demo` project on prd deploys iterate's platform that way, into an
account connected through its own Cloudflare OAuth client. test/vitest/os/deployer-workerd-build.test.ts
loads the build in a bare workerd. Not published yet: core/os consumes it as a workspace package,
and a config repo that wants it from pkg.pr.new waits for it to join pkg-pr-new.yml's publish line
(docs/depot-ci.md "A new package on npm"). Self-hosting is
[core/os/SELF-HOSTING.md](../os/SELF-HOSTING.md).
