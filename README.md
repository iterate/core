# iterate/core

The platform behind [iterate](https://iterate.com). A **mind** is one deployment: a small stack of Cloudflare Workers in its owner's own Cloudflare account, at its own domain. It holds agents, their memory as event logs, git repos, secrets and the apps its owner writes. Its people are members, who reach all of it, and anyone else, who reaches only what its apps serve.

## What is where

| Folder                  | What it is                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/boundary-worker`  | The only public Worker. Every request comes in through it, and it says who is calling. Every request that leaves with a secret goes out through it.                     |
| `core/auth-worker`      | Who is a member, sign-in (passkeys, mailed codes) and the mind's own OAuth server, at `iterate.<domain>`.                                                               |
| `core/secrets-worker`   | The vault. A secret's value never reaches the mind's code: the vault fills it into an outgoing request, after an approval when a rule asks for one.                     |
| `core/mind-worker`      | The mind itself: its contexts (each a Durable Object with an event log), repos, sandboxes, and the owner's config code, which it loads from the mind's `/repos/config`. |
| `core/telemetry-worker` | Optional: events, logs and traces in the owner's account.                                                                                                               |
| `core/itx`              | The kernel the Workers share: a context, its log, and `itx`, the handle code uses to reach a mind.                                                                      |
| `core/lib`              | npm `iterate`: the SDK a mind's code builds on, the agents, and the `iterate` CLI.                                                                                      |
| `core/alchemy`          | The one program that deploys a stack, with its smoke check.                                                                                                             |
| `core/home-lab`         | Runs the mind Worker on your own machine, behind a deployed boundary.                                                                                                   |
| `core/configs`          | The templates a new mind's config repo starts from. `default/` has its apps (agents, onboarding, and a guestbook as an example of an app for end users).                |

## Deploy a mind

- With the wizard at [cloud.iterate.com](https://cloud.iterate.com), which runs the same deploy in your Cloudflare account.
- Or by hand: [core/alchemy/README.md](core/alchemy/README.md).

## Read the code in this order

1. [core/configs/default/AGENTS.md](core/configs/default/AGENTS.md) and its `worker.ts`: what a mind's owner writes.
2. [core/lib/README.md](core/lib/README.md): the SDK that code uses.
3. [core/alchemy/README.md](core/alchemy/README.md) and `core/alchemy/src/stack.ts`: the whole stack in one file.
4. Each Worker's `src/worker.ts`, the boundary's first.
5. `core/itx/src`: the kernel.

The packages built on core are in [iterate/packages](https://github.com/iterate/packages).

## License, and how to contribute

AGPL-3.0 ([LICENSE](LICENSE)), except the SDK (`core/lib`, npm `iterate`) and the templates (`core/configs`), which are Apache-2.0 by the LICENSE in each folder.

This repo is a read-only copy of `core/` from iterate's own repo, made by [Copybara](https://github.com/google/copybara) after each change to it. Paths are the same in both, and each commit ends in `GitOrigin-RevId: <sha>`, naming the commit it came from. A comment here may name a file outside `core/` (`docs/`, `tasks/`, `lint/`, `packages/`): that file is in iterate's own repo, or in iterate/packages.

- Found a bug, or want something? [Open an issue](https://github.com/iterate/core/issues).
- Have a fix in mind? Push it to a fork and link the compare view in an issue. Pull requests are turned off here: the next copy would overwrite them.

This README lives in iterate's repo at `copybara/core/README.md`.
