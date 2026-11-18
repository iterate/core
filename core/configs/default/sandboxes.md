# Sandboxes

A sandbox is a Linux computer of the mind: a Cloudflare container with a disk. This file says how
the mind gets one with git, Claude Code and Codex in it, and how you start yours from it.

## What there is

- A new sandbox starts Cloudflare's own image, `cloudflare/debian-trixie`: Debian 13 with Node 24
  and npm, and nothing else. No git, curl, Python, Claude Code or Codex.
- Cloudflare starts an image only from the account's own registry. It does not pull from Docker
  Hub or any other public registry, and the mind's token cannot push an image. So the mind
  installs its tools in one sandbox and takes a **snapshot** of its disk. Other sandboxes start
  as a copy of that snapshot, in about a second.
- **The mind's coding snapshot is the sandbox `/agents/onboarding/sandbox/coding`.** It holds git,
  gh, curl, jq, ripgrep, Python 3, pnpm, Claude Code and Codex, and git's sign-in for this mind's
  repos. The onboarding helper `/agents/onboarding/sandbox` builds it (`onboarding/sandbox.md`).
  Never run anything in that sandbox yourself: its next idle save would replace the snapshot.

## Start a sandbox from the snapshot

```ts
const box = "/agents/<your name>/box"; // a context creates sandboxes only beneath its own path
await itx.sandboxes.create(box); // harmless when it exists
const { events } = await itx.cd(box).readEvents();
if (!events.some((event) => event.type === "events.iterate.com/sandbox/started")) {
  await itx.sandboxes.get(box).start({ from: "/agents/onboarding/sandbox/coding" });
}
```

- Start from the snapshot ONCE, when the sandbox has never started (its log has no
  `sandbox/started`), before any other call: an `exec` or a file call on a new sandbox starts it
  on the plain image. Run the script again after a failure: it starts what never started.
- After that, the sandbox keeps its own disk: an idle sandbox is saved and stopped after five
  minutes, and the next call restores it. Files stay. Running processes do not.
- **Never call `start({ from })` on a sandbox you used.** On a stopped sandbox it replaces the
  sandbox's own disk with the snapshot, and your work is gone. To begin afresh on purpose:
  `container.destroy()`, then `start({ from })`.
- When `command -v git` finds nothing in your sandbox, its start from the snapshot never ran:
  begin afresh as above.
- Never delete a sandbox you may want again: a deleted path cannot be created again.

## Use it

- **One call answers within a minute.** Run longer work in the background and poll its log:
  `exec(["bash", "-c", "cd /work; setsid nohup <command> > /tmp/job.log 2>&1 < /dev/null & echo started"])`.
  The idle save stops the sandbox after five minutes with no call, and that kills background
  work: keep polling while it runs.
- **git and this mind's repos.** `git clone` the repo's remote,
  `await (await itx.cfArtifacts.get("/repos/config")).remote()`. git signs in with a placeholder
  for the token in `/secrets/git-<the remote's last name, without .git>`, which the egress fills
  in: no token is on the disk. `/secrets/git-repos--config` can push, and **a push to `main` of
  `/repos/config` publishes the mind**, as a commit does. A token reaches its own repo alone.
  Another repo needs its token once, and a repo's token needs the same script again when git
  answers 401 or "Authentication failed" (a token lasts 365 days):

  ```ts
  const repo = await itx.cfArtifacts.get("/repos/<name>");
  const remote = await repo.remote();
  const name = remote
    .split("/")
    .pop()
    .replace(/\.git$/, "");
  const token = await repo.createToken("write", 365 * 86400);
  await itx.secrets.set(`/secrets/git-${name}`, token.plaintext, {
    urls: [new URL(remote).origin],
  });
  ```

  The token's value is in the mind's vault alone, so deleting the secret stops every sandbox's
  git for that repo.

- **The `iterate` CLI in a sandbox needs no sign-in.** `iterate whoami`, `iterate itx run` and
  `iterate provide <file>` there reach this mind as the code of the sandbox's own context, with no
  token: each command has `ITERATE_MIND` and `ITERATE_SANDBOX`, and the sandbox's egress serves
  the session. A lend from a sandbox sits on its context, so call it as
  `itx.cd("<sandbox path>").<name>`. While the session is open the sandbox counts as used: its
  idle stop comes after the session ends. Install the CLI once with `npm i -g iterate` where the
  image has none.

- **Code in an unfiltered sandbox can do what its creator's code can, the mind's config
  included.** It can also use every secret of the mind through the egress, the git tokens too. So
  a sandbox that runs text from outside (a cloned repository, a web page, a guest's words) gets
  `start({ egress })` aimed at a fetch module that lets through only what that job needs (the
  contract of `itx.sandboxes` says how), or lives beneath a jail, or does not exist. A sandbox
  with a rule for `itx.fetch` on its context or above it gets no session of its own, and a rule
  that lands later ends an open one.

- **Claude Code and Codex** sign in with a placeholder in the command's environment, which the
  egress fills in. A command does not inherit the environment of another call: pass it each time.
  - Codex: `exec(["codex", "exec", "--skip-git-repo-check", prompt], { env: { CODEX_API_KEY: 'getSecret("/secrets/openai")' } })`.
    `codex exec` reads `CODEX_API_KEY`, not `OPENAI_API_KEY`. Its log line "failed to refresh
    available models … 403 … not sent to https://chatgpt.com" is harmless: the key goes to
    api.openai.com alone.
  - Claude Code: `env: { ANTHROPIC_API_KEY: 'getSecret("/secrets/anthropic")', IS_SANDBOX: "1" }`, with
    `claude -p <prompt>`. The secret must be pinned to `https://api.anthropic.com`. `IS_SANDBOX`
    lets it run as root with `--dangerously-skip-permissions`.
  - With no key, they answer "Not logged in" or 401. The mind's AI Gateway credit does not reach
    them. A key is the owner's choice (`onboarding/pays.md`): never ask for one in a chat.

## Serve a port at a host

A server in a sandbox gets a host of the mind, `https://<name>.<this mind's domain>/`: HTTP,
streamed answers and WebSockets. Say it once:

```ts
const box = itx.sandboxes.get("/agents/<your name>/box");
await box.files.write(
  "/root/server.mjs",
  `import { createServer } from "node:http";
createServer((request, response) => response.end("hello from the sandbox\\n")).listen(8080);
`,
);
return await box.exposePort(8080, { name: "hello", command: ["node", "/root/server.mjs"] });
// { port: 8080, name: "hello", url: "https://hello.<domain>/", public: false }
```

- **It starts on demand.** A request that finds the sandbox stopped starts it from its own disk.
  A request that finds the port closed runs `command` and waits for the port. So the idle stop
  costs nothing but the first request's wait: 45 seconds at most, then the request gets 503
  (still starting) or 502 (the port stayed closed). The command's output is in
  `/var/log/iterate-port-<port>.log` in the sandbox. A command that did not open the port is
  not run again for 30 seconds: until then a request gets the same 502. Write `command` with
  absolute paths; with none, a closed port answers 502.
- **A request is use.** Each request keeps the sandbox from its idle stop, and so does a
  WebSocket while it is open. The idle stop comes after the last one closes.
- **Members only**, as a tunnel: anyone else gets the sign-in. `public: true` serves every
  visitor. **A public port lets any visitor start that one container and keep it running, with no
  bound on how often.** Use it for a server that strangers must reach, and `unexposePort` it
  after.
- **Never put a secret in `command`**: the sandbox's log keeps it. A server needs no secret's
  value: when it calls an API, it puts the placeholder (`getSecret("/secrets/<name>")`) in that
  request's header, and the egress fills it in on the way out. A placeholder that the server
  only reads stays the placeholder's text.
- **The server sees the visitor's request and nothing of the mind's**: no sign-in cookie, no
  identity of the member, no `x-itx-*` header. It hears `http:`; the visitor's scheme is in
  `x-forwarded-proto`.
- **The name** is a DNS label that no other fetch route takes, and not `iterate`, `auth`, `dash`,
  `docs` or `voice`. A fetch route is served before this mind's own code (`apps.md`), so a name
  that one of your own apps serves takes that host from the app until `unexposePort`: pick a free
  one. Only a context that the sandbox is beneath exposes its port.
- `await box.getExposedPorts()` lists them. `await box.unexposePort(8080)` frees the host. An
  idle stop keeps the host, and deleting the sandbox removes it.
- **From code**, the same request is one call:
  `await box.container.invoke([["getTcpPort", 8080], ["fetch", request]])` with a `Request`.
  An app's `fetch` can send a visitor's HTTP request on to a sandbox this way, and the sandbox
  starts on demand there too. A WebSocket does not pass through an app's `fetch`: it needs the
  port's own host. Write it as that one call: `box.container.getTcpPort(8080).fetch(request)`
  fails from a script and from an app.

## Build or rebuild the snapshot

Rebuild when a start from the snapshot fails ("cannot restore snapshot"): a snapshot lasts 30
days after its last restore, and it works only on the image it was taken from. To add a tool, add
it to `APT` or `NPM` below and rebuild. Only the helper `/agents/onboarding/sandbox` runs this: it
creates the sandbox beneath its own path. About two minutes, in one script:

```ts
const BASE = "/agents/onboarding/sandbox/coding";
const APT = "ca-certificates git gh curl jq ripgrep python3 unzip openssh-client procps less";
const NPM = "@anthropic-ai/claude-code @openai/codex pnpm";
const text = (bytes) => new TextDecoder().decode(bytes);
const config = await itx.cfArtifacts.get("/repos/config");
const origin = new URL(await config.remote()).origin;
const domain = new URL(await itx.url()).hostname;
const token = await config.createToken("write", 365 * 86400);
await itx.secrets.set("/secrets/git-repos--config", token.plaintext, { urls: [origin] });
await itx.sandboxes.create(BASE);
const box = itx.sandboxes.get(BASE);
await box.container.destroy(); // a rebuild starts again from the image
await box.start({ image: "cloudflare/debian-trixie" });
await box.files.write(
  "/usr/local/bin/git-credential-mind",
  String.raw`#!/bin/sh
# git's password for a repo of this mind: a placeholder for the token in /secrets/git-<repo>
test "$1" = get || exit 0
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  [ "$key" = path ] && repo="$value"
done
echo username=x
echo "password=getSecret(\"/secrets/git-$(basename "$repo" .git)\")"
`,
);
await box.files.write(
  "/root/setup.sh",
  String.raw`#!/bin/bash
set -euo pipefail
trap 'echo "SETUP-FAILED at line $LINENO"' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends ${APT}
npm install -g --no-fund --no-audit --loglevel=error ${NPM}
chmod +x /usr/local/bin/git-credential-mind
git config --system credential.${origin}.helper mind
git config --system credential.${origin}.useHttpPath true
git config --system user.name "${domain} agent"
git config --system user.email "agent@${domain}"
git config --system init.defaultBranch main
echo SETUP-DONE
`,
);
await box.exec([
  "bash",
  "-c",
  "setsid nohup bash /root/setup.sh > /root/setup.log 2>&1 < /dev/null & echo started",
]);
let log = "";
for (let i = 0; i < 60 && !/SETUP-(DONE|FAILED)/.test(log); i++) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  log = text((await box.exec(["tail", "-5", "/root/setup.log"])).stdout);
}
if (!log.includes("SETUP-DONE")) throw new Error(`the setup did not finish:\n${log}`);
const snapshot = await box.container.snapshotContainer({ name: "coding" });
await box.container.destroy();
return snapshot; // { id, size, name }
```

## Check it

This starts `/agents/onboarding/sandbox/proof` from the snapshot, runs each tool, clones this
mind's code and checks that git may push (a dry run: nothing is pushed). Claude Code and Codex
answer one prompt when the mind has their key.

```ts
const PROOF = "/agents/onboarding/sandbox/proof";
const text = (bytes) => new TextDecoder().decode(bytes);
const remote = await (await itx.cfArtifacts.get("/repos/config")).remote();
const secrets = new Set((await itx.secrets.list()).map((secret) => secret.path));
const env = { IS_SANDBOX: "1" };
if (secrets.has("/secrets/openai")) env.CODEX_API_KEY = 'getSecret("/secrets/openai")';
if (secrets.has("/secrets/anthropic")) env.ANTHROPIC_API_KEY = 'getSecret("/secrets/anthropic")';
await itx.sandboxes.create(PROOF);
const proof = itx.sandboxes.get(PROOF);
await proof.container.destroy();
await proof.start({ from: "/agents/onboarding/sandbox/coding" });
const run = async (command) => {
  const answer = await proof.exec(["bash", "-c", command], { env });
  return {
    ok: answer.exitCode === 0,
    out: (text(answer.stdout) + text(answer.stderr)).slice(-400),
  };
};
const checks = {
  tools: await run(
    "git --version && gh --version | head -1 && claude --version && codex --version && pnpm --version && python3 --version",
  ),
  git: await run(
    `cd /tmp && rm -rf code && git clone -q --depth 1 ${remote} code && cd code && git log --oneline -1 && git push --dry-run origin HEAD:refs/heads/sandbox-check`,
  ),
  codex: env.CODEX_API_KEY
    ? await run(
        "cd /tmp && timeout 50 codex exec --skip-git-repo-check 'Reply with the single word: pong'",
      )
    : "no key: /secrets/openai is not set",
  claude: env.ANTHROPIC_API_KEY
    ? await run("cd /tmp && timeout 50 claude -p 'Reply with the single word: pong'")
    : "no key: /secrets/anthropic is not set",
};
await proof.container.destroy();
return checks;
```
