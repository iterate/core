# The look: a logo, colour, corners, a name

The owner should come away with: they picked a logo, and the page around them changed while they watched.

## Ready today

- `apps/theme.css` is the look of every app of the mind (the Dash, Docs, Voice), the owner's by
  design. Each colour is `light-dark(<light>, <dark>)` of two `oklch(L C H)` values (lightness 0
  to 1, chroma 0 to about 0.37, hue 0 to 360); `color-scheme: light` picks the light one.
- The colour: `--primary` (buttons, links) and `--sidebar-primary`. In the template:
  `--primary: light-dark(oklch(0.205 0 0), oklch(0.922 0 0));` and
  `--sidebar-primary: light-dark(oklch(0.205 0 0), oklch(0.488 0.243 264.376));`. Keep
  `--primary-foreground` readable on the new colour.
- The corners: `--radius: 0.625rem;`. Square is `0rem`; round is `1rem` or more.
- The open Dash swaps a changed stylesheet in by itself, with no reload, about six seconds after
  it hears of the publish (`apps/live-reload/live-reload.js`). The owner does nothing.
- A changed `theme.css` no longer takes the template's later changes to that one file. It holds no
  app back: it is not inside an app's folder.
- The name: `profile/profile.json`, `{ "name": "…", "description": "…" }`, the mind's public
  profile (`profile.ts`, `AGENTS.md` "The mind's public profile"). The Dash's header and the
  homepage show the name; with none, they show the zone. The owner's own file: it holds no app
  back. It is PUBLIC: the name and the description are for the world to read.
- The icon: `profile/icon.svg`, one square SVG, the logo of the Dash and of every app, and each
  tab's icon.
- The open Dash reads the name and the icon again six seconds after it hears of a publish
  (`apps/dash/public/app.js`): both change at its top with no reload, and its tab's icon too.

## Not ready

- Any page but the open Dash (Docs, the homepage, a second tab that heard of no publish) shows a
  new name or icon at its next load, and a browser may keep the old icon for five minutes.
- The tab's title stays "Dash" (`apps/dash/index.html`): changing that file holds the Dash back
  from iterate's updates (`template-updates.md`). Leave it.

## How

The logo, the colour, the corners and the name are the onboarding agent's own scripts, in
`onboarding.md` ("THE LOOK", "THE NAME"): it commits and says so, and starts no subagent. The
logo of that script is one character on a square, a rounded square or a circle, in the owner's
colour. The owner watches the
page, so nobody waits for the publish.

A look that takes design (a drawn icon, a font, a whole palette) goes to the subagent
`/agents/main/look` (`onboarding/subagents.md`). The Dash needs a sign-in the subagent does
not have, so it checks the publish's outcome and not the page:

```ts
const repo = itx.repos.get("/repos/config");
const tip = await repo.tip();
const css = await repo.readFile("apps/theme.css", { commitOid: tip });
const colour = "light-dark(oklch(0.55 0.15 150), oklch(0.75 0.15 150))"; // a green
const next = css
  .replace(/^(\s*)--primary:.*$/m, `$1--primary: ${colour};`)
  .replace(/^(\s*)--sidebar-primary:.*$/m, `$1--sidebar-primary: ${colour};`);
const { commitOid } = await repo.commitFiles({
  message: "Look: a green primary colour",
  parent: tip,
  changes: [{ path: "apps/theme.css", content: next }],
});
return await itx.cd("/").waitForEvent({
  type: ["events.iterate.com/mind/worker-updated", "events.iterate.com/mind/worker-update-failed"],
  payload: { commitOid },
  afterOffset: 0,
  timeoutMs: 60000,
});
```

The icon, by the subagent, the same way: commit one square SVG as `profile/icon.svg` with the
message "Look: the icon", and wait for the outcome. Check it with `(await itx.config.profile()).icon`.

Putting it back is one commit: the file as read at the earlier commit.

## Say

- "Your mind needs a logo. Pick one: your G in a green circle, a black square with a white
  star, or an orange moon."
- "What shall we call your mind? It is at the top of the page in a moment."
- "I changed the file that holds your colours. It is yours, and here it is: <link>. Edit it
  yourself and save, and the same thing happens."
