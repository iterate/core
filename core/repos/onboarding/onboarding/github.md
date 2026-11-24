# GitHub

The owner should come away with: the mind's code lives in a repository of theirs, and a push there is live here seconds later.

## Ready today

Offer it once, when the owner has seen the mind change its own code, in one sentence that ends in
the question, with the reason: the code lives in a repository they own, and they read and change
it with their own tools. You connect iterate's GitHub App for the account that holds the
repository (an installation), never a grant of their whole account. You do the work; the owner
approves once. Every request uses a placeholder, never a token.

The iterate GitHub App acts only on repositories where it is installed. An issue or a pull request
on someone else's repository needs the owner's own personal access token (see Not ready).

## Not ready

- A force push to `main` publishes the older commit and leaves the mind's later commits behind.
- Opening an issue or pull request on a repository where the iterate GitHub App is not installed
  (someone else's repository) has no flow of its own yet. The owner makes a personal access token
  at GitHub and puts it into the secret form (`onboarding/secrets.md`), pinned to
  `https://api.github.com`.

## How

1. **Connect.** Ask which GitHub account holds the repository: theirs, or an organization.
   `const { authorizationUrl } = await itx.secrets.beginOAuth("/secrets/github", { client: { cloud: "github", origin: "https://cloud.iterate.com", accounts: ["<account>"] } })`.
   They confirm on iterate Cloud's page and approve at GitHub. Where iterate's App is not installed
   on that account yet, add `install: true` beside `client`. Refused because the Cloud has no
   such client: say so, and go to "If the owner declines".
2. **Check.** `(await itx.secrets.describe("/secrets/github")).set`, then tell them who answered:
   `itx.fetch(new Request("https://api.github.com/user", { headers: { authorization: 'Bearer getSecret("/secrets/github", { field: "accessToken" })', accept: "application/vnd.github+json", "user-agent": "iterate" } }))`.
3. **The repository.** A new private `<zone>-config`, or one they name that is EMPTY: no README,
   no licence, no `.gitignore`. For a new one, the same headers and the body
   `{ "name": "<zone>-config", "private": true }` to `POST https://api.github.com/user/repos`
   (their own account) or `POST https://api.github.com/orgs/<org>/repos`. On 403 or 404, ask them to
   make an empty private one at `https://github.com/new`, give iterate's App access, and name it.
4. **Link it** (what `linkThroughCloud` of `@iterate-com/github-sync` does, as three calls):
   - `GET https://api.github.com/user/installations?per_page=100`, same headers: the `id` of the
     installation whose `account.login` is the account.
   - `await itx.secrets.set("/secrets/github-installation-<id>", {}, { urls: ["https://api.github.com", "https://github.com"], refresh: { kind: "github-app-installation", apiOrigin: "https://api.github.com", installationId: "<id>", client: { cloud: "github", origin: "https://cloud.iterate.com" } } })`.
   - `await itx.repos.get("/repos/config").setOrigin('https://x-access-token:getSecret("/secrets/github-installation-<id>", { field: "accessToken" })@github.com/<account>/<name>.git')`.
5. **Push.** `await itx.repos.get("/repos/config").push()` answers `updated`. Not fast-forward: the
   repository was not empty; ask for an empty one. 403 or 404: the App has no access to it; they
   give it at `https://github.com/settings/installations`.
6. **Prove a commit comes back.** `deliveries.ts` keeps the two in step from now on: a push to `main`
   there is pulled here and published; a commit here is pushed there. Make one commit on GitHub:
   `PUT https://api.github.com/repos/<account>/<name>/contents/README.md` with the installation's
   placeholder (`getSecret("/secrets/github-installation-<id>", { field: "accessToken" })`) and
   `{ "message": "Say what this repository is", "content": "<base64 of two sentences: the code of the mind at <zone>; AGENTS.md is the guide>" }`.
   GitHub answers 201 with `commit.sha`. Each move is a `config/github-mirrored` fact on the root:
   ```ts
   await itx.cd("/").waitForEvent({
     type: "config/github-mirrored",
     payload: { commitOid: "<commit.sha>" },
     afterOffset: 0,
     timeoutMs: 60000,
   });
   return await itx.repos.get("/repos/config").readFile("README.md");
   ```
   Name the commit: an older fact proves nothing. If it did not arrive, say what you saw.
7. **Send the link**, `https://github.com/<account>/<name>`: `worker.ts` is where the mind starts, and
   its header names the files beside it; `onboarding.md` is what you were told. A push to `main` is live seconds later.

When the owner declines, do not press twice. Send them to `https://docs.<zone>`: the same code
in a browser, with each file's history, `AGENTS.md` first. They can ask you for GitHub later.

## Say

- "Shall I put your mind's code in a GitHub repository of yours, so you can read and change it
  with your own tools?"
