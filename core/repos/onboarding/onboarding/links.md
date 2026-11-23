# Links

The owner should come away with: every link you give opens the right thing, and brings them back.

## Ready today

- Build every Dash link with `await itx.config.dashLink(input)` (never hand-assemble query strings).
- This chat is `await itx.config.dashLink({ view: "agent", contextPath: "/agents/onboarding" })`
  (`https://dash.<zone>/agents/agents/onboarding`). It goes into every MAIL to the
  owner, and you give it when they say they are lost. Never a link to this chat inside this chat.
- Always write the full hostname. The owner need not learn the Dash: the next step is always to
  tell you, or another agent, what they want.
- `/keys` and `/keys/enrol` on `https://<control-plane hostname>` take `next=`, a way back: after they
  sign, the page brings them back by itself.
- The chat opens a link whose `next=` points to the Dash in the SAME tab. So add `next=` only to a
  page that reads it. `/members` and `/secrets/approvals` do not (their code reads no `next=`):
  give those plain, and say "come back to this tab". So too for another site (GitHub, a
  service's consent page).

## Not ready

- The two links to one file below are read from the apps' code, and not tried in onboarding. When
  one does not open the file, give `await itx.config.dashLink({ view: "repos" })` and the file's name.

## How

The way back:

```ts
const back = encodeURIComponent(
  await itx.config.dashLink({ view: "agent", contextPath: "/agents/onboarding" }),
);
return `https://<control-plane hostname>/keys?next=${back}`;
```

One file of the mind's code, by its path in the repo, with no leading slash:

```ts
const file = "apps/theme.css";
return {
  dash: await itx.config.dashLink({ view: "repos", repo: "config", file }),
  docs: "https://docs.<zone>/?doc=" + encodeURIComponent(file),
};
```

The places:

- `https://dash.<zone>`, the Dash (build links with `itx.config.dashLink(...)`): `/agents` every
  agent and `/agents/<path>` its chat; `/contexts` and `/contexts/<path>` everything
  that happens, live; `/repos` and `/repos/config/<file>` the mind's code as a small editor;
  `/secrets`; `/integrations`; `/analytics`.
- `https://<control-plane hostname>/` leads to the Dash. Beside it: `/secrets/approvals`, `/keys`,
  `/sessions` (every browser and app signed in as them, each one to end), `/members`, and
  `/self-test`, which checks the whole installation: ask them to open it and say what failed.
- `https://docs.<zone>`: the mind's code and notes, with each file's history.
- A call on any agent, from its chat in the Dash: the microphone button in its header (`onboarding/speak.md`).

## Say

- "Here is the file that holds your colours: <link>. Change it yourself and save, and the same
  thing happens."
- "Sign it here; the page brings you back to this chat by itself."
