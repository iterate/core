# Core's mind templates

A mind's root, at its birth, copies a template's files into a new `/repos/config` repository.
The mind owns that copy. A newer template adds only the files the repo lacks and replaces only
those still exactly as the platform wrote them (core/mind-worker/src/mind/template-update.ts).
Every build of core bundles these templates, and each depends on nothing outside core, so they
are also the plainest examples of how a mind is configured.

- `default/` — the template a stack's mind starts from unless its config names another
  (`mind.template`, core/alchemy). It has the homepage, the Agents and onboarding apps and a
  guestbook that is off (`apps/`), the agent kinds (`agent-kinds/`), cases in `worker.ts` that
  hand email, Slack and X messages to agents, and the place for the integration packages the
  mind hosts. Its init case (`mind/worker-updated`) installs the apps and sets no schedule: an
  idle mind sleeps. Its `AGENTS.md` says the rest.
- `minimal/` — the homepage and an empty `processEvent`: no agents, no schedules. A creation that
  names no template gets this one.

A template's `package.json` names its main module in `"main"` (`worker.ts` in each). It and the
files it imports may be TypeScript or JavaScript, and import packages by name: `iterate/*` and
`zod` come from the platform, any other package from npm as listed in `dependencies` (these list
none). The worker extends `IterateConfigEntrypoint` from `iterate/sdk`, whose docstrings say what
its `fetch` and `processEvent` are handed; each template's `AGENTS.md` says what its own do.

Templates are type-checkable as they stand: `package.json` lists the SDK's types as `iterate@main`
(npm's dist-tag for main's newest build), `@cloudflare/workers-types` and `typescript` as
devDependencies, so `npm install && npx tsc` checks a mind's checkout, while the loader links
the running platform's SDK (an `iterate` absent from `dependencies` is the platform's).
`devDependencies` are copied as written. In iterate's repo, `pnpm typecheck:configs` checks every
template against the workspace packages.

The build (core/mind-worker/scripts/build.ts) bundles each folder here under its name, with its
git-tracked files, and a mind is seeded from the build's copy with no GitHub request.
