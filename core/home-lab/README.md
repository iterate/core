# core/home-lab

The real mind Worker (`core/mind-worker`), unchanged, on your own machine in local workerd. Its
repos are git on this machine and its sandboxes run in the local Docker. The boundary, auth and the
secrets vault stay in the cloud. Deploy the stack first, with
`topology: "external-mind-connects-into-cloudflare-boundary"` in its config.

```sh
# in core/home-lab, Node 26+; --port 8789 --git-port 8790 --bundle <js>
node src/main.ts <control-plane hostname> --mind-id <id> --zone <zone> --owner <email>
```

The four are the config that every Worker of the mind gets, as the stack's deploy gave it to the
boundary: the mind's control-plane hostname (`iterate.example.com`), its id (`mindId` of the
deploy's config), each of its zones (`--zone` once for each) and each of its owners (`--owner`
once for each).

The first run signs you in for the right to hand in the mind (the CLI's session store, as
`iterate login`; the token's audience is `https://<control-plane hostname>/api/provide-connect`);
`ITERATE_MIND_TOKEN` skips that. The mind then dials its own API, `https://<control-plane hostname>/api`,
authenticates there with that token as every client does, and calls `provideExternalMind` on the
session that it gets, with a function that takes the boundary's door and answers the mind
(`iterate/workers` `ControlPlaneSession`). The boundary keeps what the function
answers in a Durable Object, `ProvidedMind`, for as long as the socket is open, and sends the mind
every request, mail, act and API session through it. The root is born at start: its config repo is
seeded and published. Then `http://localhost:8789/` is the apex of the first zone,
`<label>.localhost:8789` is `<label>.<zone>` (nobody signed in), and through the stack
`https://<zone>/` is the same mind.

**A deploy of the stack's boundary ends the link, and this process dials again by itself.**
Cloudflare restarts a Durable Object when its Worker's code changes, and that closes its sockets
([Durable Objects: WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
The link is one of them, and so is every WebSocket that a visitor has open to the mind. The new
link meets the new boundary. While there is no link, the boundary answers 503 for the mind. The
link also ends when its token does, and then this process dials again with a fresh token.

**To upgrade, deploy the stack's Workers first, then restart the mind here.** From `core/alchemy` at
the new commit, `pnpm run deploy --stage <name>` with the stack's config. Then check out the same
commit on this machine, run `pnpm install`, and restart this process, so that it runs the new
mind Worker.
`.home-lab/<control-plane hostname>/` stays as it is.

**Local**: contexts, KV, R2, the Worker Loader (`state/`), the repos, the sandboxes, the link.
**The cloud's**: every request in (the boundary), every request out that names a secret (the
boundary's door, which has the vault fill it in), every secret verb, sign-in, mail. A secret's facts land in the local
`/secrets/<name>` context; its value never reaches this machine. A request that names no secret
leaves from this machine, to public addresses alone: the mind's code reaches no other port of
this machine and nothing on your home network, as a mind on Cloudflare reaches none. A service of
yours that the mind should use needs a public address. The local port answers this machine's own
names alone: `localhost`, `<label>.localhost` and the loopback address. Everything lives in `.home-lab/<control-plane hostname>/`.

Measured on 2026-11-10 from a laptop, medians of 12: a request with a secret took 251 ms at home
and 293 ms on a stack whose mind is a Worker; a vault verb 46 ms and 28 ms. A 20 MB download
with no secret took 1.0 s. Through the cloud's door it took 4.6 s, which is why it does not go
there.

## Repos

Bare repos in `.home-lab/<control-plane hostname>/repos/<name>.git` (`/repos/config` is `repos--config.git`),
served by `git http-backend` on `http://127.0.0.1:8790` to holders of the token in
`.home-lab/<control-plane hostname>/repos-token`. The mind's `ARTIFACTS` is a stand-in that makes and finds
them (`src/repos/`). Keep `--git-port` fixed: a repo keeps its remote URL for its life.

```sh
git clone "http://x:$(cat .home-lab/<control-plane hostname>/repos-token)@127.0.0.1:8790/repos--config.git"
```

A push from outside does not publish by itself. Run `itx.repos.get("/repos/config").announceTip()`
after it, as on Cloudflare Artifacts.

## Sandboxes

With Docker answering, the launcher builds `images/iterate-dev-image` once per change, as
`iterate-dev-image:<content hash>`. A sandbox's HTTP and HTTPS requests are intercepted, as in the
cloud, and leave as the mind's own do: through the cloud when one names a secret, else from here. Without Docker, the launcher says so and a sandbox
refuses ("this class has no container"). No snapshots are tested at home.

For each sandbox, local workerd starts a second container beside it, `<name>-proxy` from
`cloudflare/proxy-everything`, which carries the sandbox's traffic. When the sandbox ends, workerd
removes the sandbox and leaves that sidecar running. The launcher removes the ones whose sandbox
is gone (`src/sandbox-sidecars.ts`): at its start, every five minutes, and when it stops. It
touches no other container.

## Telemetry

The mind's metrics and its events reach the stack's warehouse through the link, and
`itx.telemetry.query` and the Dash's Analytics page answer from it. The `logs` and `spans` tables
hold nothing of the mind at home: Cloudflare exports the traces and Workers Logs of its own
Workers, and local workerd exports neither. A trace of a request to the mind ends at the
boundary.

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
