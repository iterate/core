# core/home-lab

The real mind Worker (`core/mind-worker`), unchanged, on your own machine in local workerd. Its
repos are git on this machine and its sandboxes run in the local Docker. The boundary, auth and the
secrets vault stay in the cloud. Deploy the stack with `mind: { provided: true }` first
(`core/alchemy/README.md`, "A provided mind").

```sh
node src/main.ts <zone>   # in core/home-lab, Node 24+; --port 8789 --git-port 8790 --name --bundle <js>
```

The first run signs you in for `https://iterate.<zone>/provide` (the CLI's session store, as
`iterate login`); `ITERATE_MIND_TOKEN` skips that. The root is born at start: its config repo is
seeded and published. Then `http://localhost:8789/` is the apex, `<label>.localhost:8789` is
`<label>.<zone>` (nobody signed in), and through the stack `https://<zone>/` is the same mind.

**Local**: contexts, KV, R2, the Worker Loader (`state/`), the repos, the sandboxes, the link.
**The cloud's**: every request in (the boundary), every request out that names a secret (the
boundary's door, which has the vault fill it in), every secret verb, sign-in, mail. A secret's facts land in the local
`/secrets/<name>` context; its value never reaches this machine. A request that names no secret
leaves from this machine. Everything lives in `.home-lab/<zone>/`.

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

## Telemetry

With a stack that has the telemetry part (`core/alchemy/README.md`, "Telemetry"), start with
`--telemetry`. Then the mind's metrics and its events reach the stack's warehouse through the
link, and `itx.telemetry.query` and the Dash's Analytics page answer from it. The `logs` and `spans`
tables hold nothing of the mind at home: Cloudflare exports the traces and Workers Logs of its
own Workers, and local workerd exports neither. A trace of a request to the mind ends at the boundary.
Without the flag the mind has no `itx.telemetry`, as on a stack without the part.

## Gaps

Workers AI, Browser Run and Images have no local form: each refuses in one sentence. Give agents a
model key as a secret: it leaves through the door.
