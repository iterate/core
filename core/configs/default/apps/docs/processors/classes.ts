// Carried over from iterate/docs@fba5c21 (packages/docs/src/durable-object.ts and index.ts).
// processors/classes.ts — THE DOCS APP'S PROCESSORS: two Durable Object classes that let people co-edit a
// markdown file of one of this mind's repos in the browser, with comments, and save it as commits.
//
// - `DocDurableObject` is ONE OPEN DOC: the facet `doc` on the context `/docs/<repo name>/<path>`
//   (/repos/config's notes/plan.md is /docs/config/notes/plan.md). It holds the text as a Yjs
//   document in its own storage, takes the edits the open tabs send, and commits the text a minute
//   after the first unsaved edit, or at once when the last tab leaves (doc.ts). A tab
//   joins with `sync`. It also keeps the doc's comments (comments.ts).
// - `DocsDurableObject` is the processor `docs` on `/`: it remembers which docs were opened and
//   tells each one when a commit to its repo changed it, so an agent's commit reaches the open
//   tabs (root.ts).
//
// What the page and the processors say to each other is frames.ts.
//
// WHY THIS FOLDER IS NOT `backend.ts`. The classes need three packages (`yjs`, `diff` and
// `node-diff3`, in package.json). The platform resolves every `apps/<name>/backend.ts` with its
// packages each time it publishes this repo, so a package that cannot be fetched there would stop
// the whole mind from publishing. This folder is at a path the publication does not resolve, and
// worker.ts never imports its code (../app.ts takes the folder as text, to tell one version of
// it from the next). The page starts both processors as a doc opens and names where their code
// is: this file, in this repo's own files, loaded then. So the packages are fetched when a doc
// first opens, and a package that fails breaks Docs alone.
import { StreamProcessorDurableObject } from "iterate/sdk";
import type { ProcessorState } from "iterate/stream/processor";
import { DocContract, DocProcessor } from "./doc.ts";
import { DocsContract, DocsProcessor } from "./root.ts";

export class DocDurableObject extends StreamProcessorDurableObject<
  ProcessorState<typeof DocContract>
> {
  static override publicMethods = [...super.publicMethods, "sync"];

  processor = new DocProcessor({
    sql: this.ctx.storage.sql,
    getItx: () => this.getItx(),
    publishLiveState: () => this.publishLiveState(),
    // a minute after the first unsaved edit, however much typing follows (or sooner: the last tab
    // leaving); each commit to /repos/config publishes the mind again
    autosave: { idleMs: 60_000, maxMs: 60_000 },
  });

  sync(stateVector: string, client: number) {
    return this.processor.sync(stateVector, client);
  }
}

export class DocsDurableObject extends StreamProcessorDurableObject<
  ProcessorState<typeof DocsContract>
> {
  processor = new DocsProcessor(() => this.getItx());
}
