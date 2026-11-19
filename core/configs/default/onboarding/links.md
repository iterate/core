# Links

The owner should come away with: every link you give opens the right thing, and brings them back.

## Ready today

- This chat is `https://dash.<zone>/?agent=/agents/onboarding`. It goes into every MAIL to the
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
  one does not open the file, give `https://dash.<zone>/?page=repo` and the file's name.

## How

The way back:

```ts
const back = encodeURIComponent("https://dash.<zone>/?agent=/agents/onboarding");
return `https://<control-plane hostname>/keys?next=${back}`;
```

One file of the mind's code, by its path in the repo, with no leading slash:

```ts
const file = "apps/theme.css";
return {
  dash: "https://dash.<zone>/?page=repo&view=" + encodeURIComponent(JSON.stringify({ file })),
  docs: "https://docs.<zone>/?doc=" + encodeURIComponent(file),
};
```

The places:

- `https://dash.<zone>`, the Dash: `?page=agents` every agent and a chat with each;
  `?page=contexts` everything that happens, live; `?page=repo` the mind's code as a small editor;
  `?page=secrets`; `?page=integrations`; `?page=analytics`; `?page=mcp`.
- `https://<control-plane hostname>/` leads to the Dash. Beside it: `/secrets/approvals`, `/keys`,
  `/sessions` (every browser and app signed in as them, each one to end), `/members`, and
  `/self-test`, which checks the whole installation: ask them to open it and say what failed.
- `https://docs.<zone>`: the mind's code and notes, with each file's history.
- A call on any agent, from its chat in the Dash: "Start a call" (`onboarding/speak.md`).

## Say

- "Here is the file that holds your colours: <link>. Change it yourself and save, and the same
  thing happens."
- "Sign it here; the page brings you back to this chat by itself."
