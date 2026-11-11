# iterate/core

The platform behind [iterate](https://iterate.com). A mind is a stack of Cloudflare Workers in its owner's own account, at its own domain:

- `core/mind-worker`, `core/boundary-worker`, `core/secrets-worker`, `core/auth-worker` and `core/telemetry-worker` are the Workers.
- `core/itx` is the kernel they share.
- `core/alchemy` deploys a stack ([its README](core/alchemy/README.md) is where to start), and `core/home-lab` runs the mind Worker on your own machine.
- `core/lib` is the `iterate` package: the SDK that minds build on, the agents app and the `iterate` CLI.
- `core/configs` are the templates a mind starts from, which are also the plainest examples of configuring one.

The packages built on it are in [iterate/packages](https://github.com/iterate/packages).

Licenses: AGPL-3.0 ([LICENSE](LICENSE)), except the SDK (`core/lib`, npm `iterate`) and core's templates (`core/configs`), which are Apache-2.0 by the LICENSE in each folder.

This repo is a read-only copy of `core/` from iterate's own repo, made by [Copybara](https://github.com/google/copybara) after each change to it. Paths are the same in both, and each commit ends in `GitOrigin-RevId: <sha>`, naming the commit it came from.

- Found a bug, or want something? [Open an issue](https://github.com/iterate/core/issues).
- Have a fix in mind? Push it to a fork and link the compare view in an issue. Pull requests are turned off here: the next copy would overwrite them.

This README lives in iterate's repo at `copybara/core/README.md`.
