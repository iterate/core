# core

What goes public as `iterate/core`: a mind's stack.

- A mind is a stack of Workers, each in a folder named `<part>-worker`: `mind-worker/` (the only
  one that hosts contexts), `boundary-worker/`, `secrets-worker/`, `auth-worker/` and
  `telemetry-worker/`.
- `itx/` is the kernel library they share, and `alchemy/` deploys a stack.
- `home-lab/` runs the mind Worker on your own machine.
- `lib/` is npm `iterate`: the SDK, the agents app (`iterate/agents`) and the `iterate` CLI.
- `configs/` are the templates a mind starts from.

- **Core builds from a clone of itself.** Nothing in `core/` imports outside `core/`; outside code may
  import core, never the reverse. `.oxlintrc.json` enforces it (`lint/oxlintrc-core-boundary.test.ts`).
- **Core's configs** (`configs/`) are the templates a mind starts from, and the documentation of
  how a mind is configured: each depends on nothing outside core (`iterate/*` and `zod` come from
  the platform).
- **Internal tooling stays outside:** iterate's own deploys, tasks and CI.
- **No ids or keys**, here or in `packages/`, tests included: no UUID, account id, key, or long hex,
  base64 or digit string (`lint/public-copies.test.ts`). An id goes in `envs.ts`, a secret in
  Doppler; a test uses an obvious fake (`aaaaabbbbbccccc111112222233333aaaaabbbbb`).
