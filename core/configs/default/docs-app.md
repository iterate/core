# Docs

The Docs app on `docs.<zone>`: where its code is, how an agent edits and comments on a doc, and
how to take the app out: `apps/docs/`.

`docs.<zone>` shows a repo's files as a tree and one file in a live editor. Several members type
in a markdown file at once and see each other; they comment on a piece of its text; what they type
is saved as commits to the repo, a minute after the first unsaved edit, or at once when the last
tab closes. The first person who typed is the commit's author, the others are `Co-authored-by`.

- **Where its code is.** The page is `apps/docs/public/app.js`. The editing is two Durable Object
  classes in `apps/docs/processors/` (`classes.ts` exports them), which the page starts when a doc
  opens: one for each open doc, on the context `/docs/<repo name>/<path>` (`/repos/config`'s
  `notes/plan.md` is `/docs/config/notes/plan.md`), and one on `/` that tells the open docs of a
  commit. They need three packages, listed in `package.json`: `yjs`, `diff` and `node-diff3`.
- **`worker.ts` does not load them, on purpose.** The platform resolves `worker.ts`, the root's
  modules and every `apps/<name>/backend.ts` with their packages each time it publishes this repo:
  a package that cannot be fetched there stops the whole mind from publishing. The processors are
  at a path the publication does not resolve, and are loaded from this repo's files when a doc
  first opens. So a package that fails breaks Docs alone. Keep it so: do not import
  `apps/docs/processors/` from `worker.ts`, and do not move it to `backend.ts`.
- **To edit a doc as an agent, commit it.** `itx.repos.get("/repos/config").commitFiles(...)` as
  for any file. The open editors take the commit in: the processor merges it with what people
  typed since, like git. Do not append edit frames by hand.
- **To comment as an agent,** append to the doc's context. A thread quotes its text, with a little
  of what is around it, so it finds its place again after an edit:
  `itx.cd("/docs/config/notes/plan.md").append({ type: "docs/comment-added", payload: { thread: crypto.randomUUID(), quote: { exact: "the words commented on", prefix: "up to 32 characters before ", suffix: " and after" }, body: "Why this date?" } })`.
  `docs/comment-replied` (`{ thread, comment: <a new id>, body }`), `docs/comment-resolved` and
  `docs/comment-reopened` (`{ thread }`) follow it. `apps/docs/processors/comments.ts` has every
  type and its fields. A doc must have been opened once in the page before it takes comments: the
  page is what starts its processor.
- **To give a member a page to read in the browser,** write an HTML file to the mind's files at
  `/notes/<name>.html` (lower-case letters, digits and hyphens) and send the link
  `https://docs.<zone>/notes/<name>.html`. A file's own link downloads it; this one shows it.
  The page runs no script and loads nothing from elsewhere (`apps/docs/notes.ts`): put the styles
  in the file and images as `data:` URLs.
  `itx.files.get("/notes/plan.html").put({ contentType: "text/html", data: new TextEncoder().encode(html) })`.
- **To take the app out of a mind, disable its processors first.** Each doc that was opened has
  a processor row `doc` on its context, and the root has the row `docs`, which gets every commit
  of every repo. A row outlives the code it names, and then each event goes to a class that no
  longer loads. So before the commit that removes `apps/docs/processors/`:
  `await itx.processors.disable("docs")`, and `await itx.cd(path).processors.disable("doc")` for
  each opened doc (the root's log names them: events of type `docs/opened`, `{ repo, path }`).
- **A mind that got these files without the packages** (its `package.json` was changed by hand
  before the template had them) shows "Couldn't open this doc for editing" with the reason. Add
  the three packages to `"dependencies"`, at the versions the default config names.
