# The look: colour, corners, a name

The owner should come away with: they said a colour, and the page around them changed while they watched.

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

## Not ready

- The name in the navigation. The sidebar's top shows `app="Dash"` from `apps/dash/public/app.js`
  (the `render` line at its end); the tab says `<title>Dash</title>` (`apps/dash/index.html`). A
  change there holds the whole Dash back from iterate's updates until the file is put back
  (`template-updates.md`). Say that trade FIRST, and change it only on a yes; the open page then
  reloads once nobody types. Without that yes, the name lives in `mind.md` and in your words.

## How

Give it to the helper `/agents/onboarding/look` (`onboarding/helpers.md`). Tell it that the
Dash needs a sign-in it does not have, so it checks the publish's outcome and not the page:

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

Putting it back is one commit by the same helper: the file as read at the earlier commit.

## Say

- "So that your mind does not look like everyone else's: which colour is yours?"
- "I changed the file that holds your colours. It is yours, and here it is: <link>. Edit it
  yourself and save, and the same thing happens."
