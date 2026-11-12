# core/home-lab

The real mind Worker (`core/mind-worker`), unchanged, on your own machine in local workerd. Its
repos are git on this machine and its sandboxes run in the local Docker. The boundary, auth and the
secrets vault stay in the cloud. Deploy the stack with `mind: { provided: true }` first
(`core/alchemy/README.md`, "A provided mind").

```sh
node src/main.ts <zone>   # in core/home-lab, Node 24+; --port 8789 --git-port 8790 --name --template default --bundle <js> --telemetry
```

The first run signs you in for `https://iterate.<zone>/provide` (the CLI's session store, as
`iterate login`); `ITERATE_MIND_TOKEN` skips that. The root is born at start: its config repo is
seeded and published. Then `http://localhost:8789/` is the apex, `<label>.localhost:8789` is
`<label>.<zone>` (nobody signed in), and through the stack `https://<zone>/` is the same mind.

**After a deploy that changes the stack's boundary, restart this process.** A deploy does not move
an open socket: the link stays with the boundary instance that accepted it, which runs the code
from before the deploy until the socket ends (a restart here, or the end of the token's hour). The
stack's other Workers change at once.

**To upgrade, deploy the stack's Workers first, then restart the mind here.** From `core/alchemy` at
the new commit, `pnpm run deploy --stage <name>` with the stack's config. Then check out the same
commit on this machine, run `pnpm install`, and restart this process, so that its new connection
meets the new boundary. Then run `pnpm run smoke <zone>` from `core/alchemy`. `.home-lab/<zone>/`
stays as it is.

**Local**: contexts, KV, R2, the Worker Loader (`state/`), the repos, the sandboxes, the link.
**The cloud's**: every request in (the boundary), every request out that names a secret (the
boundary's door, which has the vault fill it in), every secret verb, sign-in, mail. A secret's facts land in the local
`/secrets/<name>` context; its value never reaches this machine. A request that names no secret
leaves from this machine, to public addresses alone: the mind's code reaches no other port of
this machine and nothing on your home network, as a mind on Cloudflare reaches none. A service of
yours that the mind should use needs a public address. The local port answers this machine's own
names alone: `localhost`, `<label>.localhost` and the loopback address. Everything lives in `.home-lab/<zone>/`.

Measured on 2026-11-10 from a laptop, medians of 12: a request with a secret took 251 ms at home
and 293 ms on a stack whose mind is a Worker; a vault verb 46 ms and 28 ms. A 20 MB download
with no secret took 1.0 s. Through the cloud's door it took 4.6 s, which is why it does not go
there.

## Repos

Bare repos in `.home-lab/<zone>/repos/<name>.git` (`/repos/config` is `repos--config.git`),
served by `git http-backend` on `http://127.0.0.1:8790` to holders of the token in
`.home-lab/<zone>/repos-token`. The mind's `ARTIFACTS` is a stand-in that makes and finds
them (`src/repos/`). Keep `--git-port` fixed: a repo keeps its remote URL for its life.

```sh
git clone "http://x:$(cat .home-lab/<zone>/repos-token)@127.0.0.1:8790/repos--config.git"
```

A push from outside does not publish by itself. Run `itx.repos.get("/repos/config").announceTip()`
after it, as on Cloudflare Artifacts.

## Sandboxes

With Docker answering, the launcher builds `images/iterate-dev-image` once per change, as
`iterate-dev-image:<content hash>`. A sandbox's HTTP and HTTPS requests are intercepted, as in the
cloud, and leave as the mind's own do: through the cloud when one names a secret, else from here. Without Docker, the launcher says so and a sandbox
refuses ("this class has no container"). No disk snapshots are tested at home.

For each sandbox, local workerd starts a second container beside it, `<name>-proxy` from
`cloudflare/proxy-everything`, which carries the sandbox's traffic. When the sandbox ends, workerd
removes the sandbox and leaves that sidecar running. The launcher removes the ones whose sandbox
is gone (`src/sandbox-sidecars.ts`): at its start, every five minutes, and when it stops. It
touches no other container.

## Telemetry

With a stack that has the telemetry part (`core/alchemy/README.md`, "Telemetry"), start with
`--telemetry`. Then the mind's metrics and its events reach the stack's warehouse through the
link, and `itx.telemetry.query` and the Dash's Analytics page answer from it. The `logs` and `spans`
tables hold nothing of the mind at home: Cloudflare exports the traces and Workers Logs of its
own Workers, and local workerd exports neither. A trace of a request to the mind ends at the boundary.
Without the flag the mind has no `itx.telemetry`, as on a stack without the part.

## Known log lines

- `RPC connection broken for non-DISCONNECTED reason … capnp/serialize-async.c++ … expected
expectedSizeInWords <= options.traversalLimitInWords […] incoming RPC message exceeds size
limit`: once in each run of the launcher, about half a minute after its start or right at it.
  It is a local link of workerd on this machine, not the link to the stack: no call fails with
  it, and the link stays connected. It is there since the first run (workerd 1.20261104.1), and
  which local link it is has not been found.

## Gaps

Workers AI, Browser Run and Images have no local form: each refuses in one sentence. Give agents a
model key as a secret: it leaves through the door.
