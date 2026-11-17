# The sandbox image

The image a new sandbox of this mind starts on: how the mind gets iterate's full image into its
own Cloudflare account, and how it gives it back: `sandbox-image.ts` and
`itx.config.sandboxImage`.

- **Before:** a mind that iterate Cloud installs has no image of its own. Its sandboxes start on
  Cloudflare's lean image: Node and npm, no git, no `gh`, no coding CLI.
- **After:** its sandboxes start on iterate's full image: git, `gh`, Node, pnpm, Chromium and the
  Claude and Codex CLIs. A Container starts only from `registry.cloudflare.com`, so the mind
  copies iterate's public image (`ghcr.io/iterate/iterate-dev-image`, pinned by digest) into its
  own account's registry, Cloudflare prepares it, and the mind names it with
  `events.iterate.com/mind/sandbox-image-configured` on `/`.
- The copy needs a Cloudflare token with the permission "Workers Containers Write", for the
  registry's push credential. The mind's own token ([cloudflare.md](cloudflare.md)) does not hold
  it: it reads the account and changes nothing in it. So with that token the call answers
  `cannot-copy`, and a deploy of the stack copies the image (its config says
  `mind.sandboxImage: "published"`).

`await itx.config.sandboxImage()` is one pass. It goes on from what the account holds, so call it
again until it answers `ready` (but never after `cannot-copy`); a call after `ready` copies nothing and names nothing again. It
answers `{ state, words, image?, copied?, left? }`:

- `no-connection`: `/secrets/cloudflare` is not set. Tell a member what `words` says.
- `cannot-copy`: Cloudflare refused the token (403) at the account's lookup or the push
  credential. Tell a member what `words` says, and do not call it again: no pass can copy with
  this token. Do not look for a way round.
- `copying`: the pass stopped after about 4 minutes with blobs left (`left`). Call it again.
- `preparing`: the image is in the registry, and Cloudflare has not said `ready` within the pass (a pass ends within about 8 minutes).
  Call it again in a few minutes.
- `ready`: the mind names the image. New sandboxes start on it.
- `failed`: `words` names the step and what Cloudflare or the registry said. Call it again once;
  if it fails at the same step, tell a member.

The copy is about 1.6 GB and takes several minutes, and the preparation of new layers more. Run
it in a helper agent, never in the turn that talks to a person, and tell the person when it is
`ready`. The pass's own facts are on `/sandbox-image` (`sandbox-image/pass`,
`sandbox-image/configured`).

The image changes nothing for a sandbox that has a saved disk: it keeps its disk, and only a
sandbox that starts with no disk starts on the new image.

To give the lean image back:

```js
await itx.cd("/").append({
  type: "events.iterate.com/mind/sandbox-image-configured",
  payload: { image: null },
});
```

After that, `itx.config.sandboxImage()` still answers `ready` and does not name the image again:
its fact on `/sandbox-image` says it named it once. To name it again, append the event with the
`image` that the call answers.
