// The default config's Docs processors (core/configs/default/apps/docs/processors/classes.ts): one open doc's
// processor over an in-memory log, node:sqlite and a fake repo; the comments it reduces; the root's
// processor that tells open docs of a commit; where a quote is found again; and that worker.ts never
// reaches the packages the processors need. The page that drives it is out of scope here.
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  findQuote,
  quoteAt,
  type Quote,
} from "../../configs/default/apps/docs/processors/anchor.ts";
import {
  COMMENT_ADDED,
  COMMENT_DELETED,
  COMMENT_EDITED,
  COMMENT_REANCHORED,
  COMMENT_REOPENED,
  COMMENT_REPLIED,
  COMMENT_RESOLVED,
  COMMENT_ROUTED,
} from "../../configs/default/apps/docs/processors/comments.ts";
import { DocProcessor } from "../../configs/default/apps/docs/processors/doc.ts";
import {
  COMMIT_NOTICED,
  DOC_LEFT,
  DOC_OPENED,
  EDIT_FRAME,
  EditFrame,
  fromBase64,
  toBase64,
} from "../../configs/default/apps/docs/processors/frames.ts";
import { DocsProcessor } from "../../configs/default/apps/docs/processors/root.ts";
import type { IterateContextApi } from "./api.ts";
import { ProcessorEngine, type StreamEventInput } from "./stream/processor.ts";
import {
  memoryStorage,
  memoryStream,
  nodeSqliteDurableObjectStorage,
  reduceProcessor,
} from "./stream/test-support.ts";

// ── one open doc ──

test("two people's edits land in one autosave commit, the second as a co-author", async () => {
  // time for Bo to see Ada's line and add his before the save
  const doc = openDoc({ "plan.md": "# Plan\n" }, { idleMs: 200, maxMs: 1000 });
  const ada = await doc.join("ada@example.com");
  const bo = await doc.join("bo@example.com");
  ada.type(ada.text().length, "Ada's line.\n");
  await vi.waitFor(() => expect(bo.text()).toBe("# Plan\nAda's line.\n"));
  bo.type(bo.text().length, "Bo's line.\n");

  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "# Plan\nAda's line.\nBo's line.\n" },
      author: { email: "ada@example.com" },
      message: "docs: edit plan.md\n\nCo-authored-by: bo@example.com <bo@example.com>",
    }),
  );
  expect(doc.repo.commits).toHaveLength(2);
  expect(await doc.live()).toMatchObject({ commitOid: doc.repo.latest().oid, dirty: false });
});

test("a commit made elsewhere merges into the live text, and every open editor gets it", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n\nWe fly in on Tuesday.\n\n## Agenda\n" });
  const ada = await doc.join("ada@example.com");
  // Ada is typing under Agenda while an agent rewords the date and commits
  ada.type(ada.text().length, "- Retro\n");
  doc.repo.commitElsewhere("plan.md", "# Plan\n\nWe fly in on Wednesday.\n\n## Agenda\n");
  doc.notice();

  const merged = "# Plan\n\nWe fly in on Wednesday.\n\n## Agenda\n- Retro\n";
  await vi.waitFor(() => expect(ada.text()).toBe(merged));
  await vi.waitFor(() => expect(doc.repo.latest()).toMatchObject({ files: { "plan.md": merged } }));
});

test("a save the repo refuses because main moved takes the tip in and saves the merge on top", async () => {
  const doc = openDoc({ "plan.md": "one\ntwo\nthree\n" });
  const ada = await doc.join("ada@example.com");
  // an agent commits and no notice arrives: the save finds out
  doc.repo.commitElsewhere("plan.md", "one\ntwo\nthree\nfour\n");
  ada.type(0, "zero\n");

  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "zero\none\ntwo\nthree\nfour\n" },
    }),
  );
  expect(doc.repo).toMatchObject({ refusals: 1 });
  await vi.waitFor(() => expect(ada.text()).toBe("zero\none\ntwo\nthree\nfour\n"));
});

test("a commit deleting a doc with unsaved edits in it: the save writes it back, edits and all", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { idleMs: 60_000, maxMs: 60_000 });
  const ada = await doc.join("ada@example.com");
  ada.type(ada.text().length, "Unsaved.\n");
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ dirty: true }));

  doc.repo.deleteElsewhere("plan.md");
  doc.notice();
  ada.leave();

  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({ files: { "plan.md": "# Plan\nUnsaved.\n" } }),
  );
});

test("the last person closing the doc saves it at once, not a minute later", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { idleMs: 60_000, maxMs: 60_000 });
  const ada = await doc.join("ada@example.com");
  const bo = await doc.join("bo@example.com");
  ada.type(ada.text().length, "Ada's line.\n");
  await vi.waitFor(() => expect(bo.text()).toBe("# Plan\nAda's line.\n"));
  bo.type(bo.text().length, "Bo's line.\n");
  await vi.waitFor(() => expect(ada.text()).toBe("# Plan\nAda's line.\nBo's line.\n"));

  ada.leave();
  bo.leave();
  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "# Plan\nAda's line.\nBo's line.\n" },
      author: { email: "ada@example.com" },
      message: "docs: edit plan.md\n\nCo-authored-by: bo@example.com <bo@example.com>",
    }),
  );
});

test("someone joining gets the live text, unsaved edits included", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { idleMs: 60_000, maxMs: 60_000 });
  const ada = await doc.join("ada@example.com");
  ada.type(ada.text().length, "Unsaved.\n");
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ dirty: true }));

  const bo = await doc.join("bo@example.com");
  expect(bo.text()).toBe("# Plan\nUnsaved.\n");
});

test("a facet reset loses nothing: the next incarnation has the unsaved text and saves it", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { idleMs: 60_000, maxMs: 60_000 });
  const ada = await doc.join("ada@example.com");
  ada.type(ada.text().length, "Before the reset.\n");
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ dirty: true }));

  const next = doc.restart({ idleMs: 5, maxMs: 20 });
  await next.engine.revive();
  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "# Plan\nBefore the reset.\n" },
      author: { email: "ada@example.com" },
    }),
  );
});

test("a typo fixed under a comment keeps the comment, and a deleted sentence detaches it", async () => {
  const doc = openDoc({
    "plan.md": "The hotle is booked for three nights near the station.\n\nBring a coat.\n",
  });
  const ada = await doc.join("ada@example.com");
  const text = ada.text();
  ada.append(COMMENT_ADDED, { thread: "typo", quote: quoteOf(text, "hotle"), body: "Which one?" });
  ada.append(COMMENT_ADDED, {
    thread: "coat",
    quote: quoteOf(text, "Bring a coat."),
    body: "It's July.",
  });
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ threads: [{}, {}] }));

  ada.fix("hotle", "hotel");
  ada.fix("Bring a coat.\n", "");

  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "The hotel is booked for three nights near the station.\n\n" },
    }),
  );
  await vi.waitFor(async () =>
    expect(await doc.live()).toMatchObject({
      threads: [
        { id: "typo", quote: { exact: "hotel", prefix: "The " }, detached: false },
        { id: "coat", quote: { exact: "Bring a coat." }, detached: true },
      ],
    }),
  );
});

test("a reply on a doc whose processor has just started again still shows the doc as saved", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" });
  const ada = await doc.join("ada@example.com");
  ada.append(COMMENT_ADDED, { thread: "t1", quote: null, body: "Looks good?" });
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ threads: [{}] }));
  // a new incarnation (a new build of the config, an eviction): nothing has loaded the doc yet
  doc.restart({ idleMs: 5, maxMs: 20 });

  const [reply] = await ada.append(COMMENT_REPLIED, { thread: "t1", comment: "c2", body: "Yes." });

  // as the page sees it: the live state the push published, not a read that catches up first
  await doc.engine.waitUntilProcessed({ offset: reply!.offset });
  expect(await doc.live()).toMatchObject({
    commitOid: doc.repo.latest().oid,
    dirty: false,
    threads: [{ comments: [{ body: "Looks good?" }, { body: "Yes." }] }],
  });
});

// ── the comments a doc's processor reduces ──

const byAda = { principal: { actor: "ada@example.com", email: "ada@example.com" } };
const byBo = { principal: { actor: "bo@example.com", email: "bo@example.com" } };
/** What a `run` script appends for Bo (an agent over MCP, as him): no principal, Bo in
 *  `onBehalfOf`. */
const byBoThroughAnAgent = { onBehalfOf: { principal: byBo.principal, run: "/@1" } };
const tuesday = { exact: "Tuesday", prefix: "We fly in on ", suffix: "." };

test.for([
  {
    name: "a comment starts a thread on its quote, and a reply joins it",
    events: [
      {
        type: COMMENT_ADDED,
        source: byAda,
        payload: { thread: "t1", quote: tuesday, body: "Wed?" },
      },
      {
        type: COMMENT_REPLIED,
        source: byBoThroughAnAgent,
        payload: { thread: "t1", comment: "c2", body: "Cheaper.", via: "Claude Code" },
      },
    ],
    expected: [
      {
        id: "t1",
        quote: tuesday,
        detached: false,
        resolved: null,
        routedTo: null,
        comments: [
          { id: "t1", author: "ada@example.com", via: null, body: "Wed?", edited: false },
          { id: "c2", author: "bo@example.com", via: "Claude Code", body: "Cheaper." },
        ],
      },
    ],
  },
  {
    name: "only a comment's author edits it",
    events: [
      { type: COMMENT_ADDED, source: byAda, payload: { thread: "t1", quote: null, body: "Wed?" } },
      {
        type: COMMENT_EDITED,
        source: byBo,
        payload: { thread: "t1", comment: "t1", body: "Thu?" },
      },
      {
        type: COMMENT_EDITED,
        source: byAda,
        payload: { thread: "t1", comment: "t1", body: "Fri?" },
      },
    ],
    expected: [{ comments: [{ body: "Fri?", edited: true }] }],
  },
  {
    name: "only a comment's author deletes it, and a thread goes with its last comment",
    events: [
      { type: COMMENT_ADDED, source: byAda, payload: { thread: "t1", quote: null, body: "Wed?" } },
      { type: COMMENT_ADDED, source: byAda, payload: { thread: "t2", quote: null, body: "Who?" } },
      { type: COMMENT_DELETED, source: byBo, payload: { thread: "t1", comment: "t1" } },
      { type: COMMENT_DELETED, source: byAda, payload: { thread: "t2", comment: "t2" } },
    ],
    expected: [{ id: "t1", comments: [{ body: "Wed?" }] }],
  },
  {
    name: "anyone resolves a thread, and anyone reopens it",
    events: [
      { type: COMMENT_ADDED, source: byAda, payload: { thread: "t1", quote: null, body: "Wed?" } },
      { type: COMMENT_ADDED, source: byAda, payload: { thread: "t2", quote: null, body: "Who?" } },
      { type: COMMENT_RESOLVED, source: byBo, payload: { thread: "t1" } },
      { type: COMMENT_RESOLVED, source: byBo, payload: { thread: "t2" } },
      { type: COMMENT_REOPENED, source: byAda, payload: { thread: "t2" } },
    ],
    expected: [
      { id: "t1", resolved: { by: "bo@example.com" } },
      { id: "t2", resolved: null },
    ],
  },
  {
    name: "a thread routed to an agent names it until it is routed elsewhere",
    events: [
      { type: COMMENT_ADDED, source: byAda, payload: { thread: "t1", quote: null, body: "Book?" } },
      { type: COMMENT_ROUTED, payload: { thread: "t1", to: "/agents/web/t1" } },
      { type: COMMENT_ADDED, source: byAda, payload: { thread: "t2", quote: null, body: "Who?" } },
      { type: COMMENT_ROUTED, payload: { thread: "t2", to: "/agents/web/t2" } },
      { type: COMMENT_ROUTED, payload: { thread: "t2", to: null } },
    ],
    expected: [
      { id: "t1", routedTo: "/agents/web/t1" },
      { id: "t2", routedTo: null },
    ],
  },
  {
    name: "a quote re-anchored takes the new text, and one re-anchored to nothing is detached",
    events: [
      {
        type: COMMENT_ADDED,
        source: byAda,
        payload: { thread: "t1", quote: tuesday, body: "Wed?" },
      },
      {
        type: COMMENT_ADDED,
        source: byAda,
        payload: { thread: "t2", quote: tuesday, body: "Thu?" },
      },
      {
        type: COMMENT_REANCHORED,
        payload: { thread: "t1", quote: { ...tuesday, exact: "Tues" } },
      },
      { type: COMMENT_REANCHORED, payload: { thread: "t2", quote: null } },
    ],
    // a detached thread keeps its old quote, to show what it was about
    expected: [
      { id: "t1", quote: { exact: "Tues" }, detached: false },
      { id: "t2", quote: tuesday, detached: true },
    ],
  },
])("comments: $name", ({ events, expected }) => {
  const { threads } = reduceProcessor(bareDocProcessor(), events);
  expect(threads).toMatchObject(expected);
  expect(threads).toHaveLength(expected.length);
});

// ── the root ──

test("the root's docs processor tells only the opened docs a commit changed", async () => {
  const root = memoryStream("/");
  const noticed: { path: string; event: StreamEventInput }[] = [];
  const docs = new DocsProcessor(() =>
    fakeItx({
      cd: (path: string) => ({
        append: async (event: StreamEventInput) => noticed.push({ path, event }),
      }),
    }),
  );
  root.engines.push(new ProcessorEngine(docs, { stream: root.stream, storage: memoryStorage() }));
  root.stream.append(
    { type: DOC_OPENED, payload: { repo: "/repos/config", path: "plan.md" } },
    { type: DOC_OPENED, payload: { repo: "/repos/config", path: "notes/retro.md" } },
    commitCompleted("/repos/config", "c1", ["plan.md", "never-opened.md"]),
    // the same path in another repo is another doc
    commitCompleted("/repos/docs", "c2", ["plan.md"]),
    commitCompleted("/repos/config", "c3", ["notes/retro.md"]),
  );

  // exactly these two, in this order
  await vi.waitFor(() =>
    expect(noticed).toEqual([
      {
        path: "/docs/config/plan.md",
        event: { type: COMMIT_NOTICED, ephemeral: true, payload: { commitOid: "c1" } },
      },
      {
        path: "/docs/config/notes/retro.md",
        event: { type: COMMIT_NOTICED, ephemeral: true, payload: { commitOid: "c3" } },
      },
    ]),
  );
});

// ── where a quote is found again ──

const offsite = "# Offsite\n\nWe fly in on Tuesday and leave on Friday. The hotel is booked.\n";

test.for([
  {
    name: "a quote is found where its text is",
    quote: quoteOf(offsite, "leave on Friday"),
    text: `A new first line.\n${offsite}`,
    expected: { text: "leave on Friday", exact: true },
  },
  {
    name: "of several copies of the text, the one in the quote's surroundings is found",
    quote: quoteAt("Friday: drinks. We leave on Friday. Friday is a holiday.", 28, 34),
    text: "Friday: drinks. We leave on Friday. Friday is a holiday.",
    expected: { text: "Friday", exact: true, from: 28 },
  },
  {
    name: "a typo fixed under a comment keeps it, on the corrected word, as a loose match",
    quote: quoteOf(offsite.replace("hotel", "hotle"), "hotle"),
    text: offsite,
    expected: { text: "hotel", exact: false },
  },
  {
    name: "a quote moves with its text",
    quote: quoteOf(offsite, "leave on Friday"),
    text: "The hotel is booked. We fly in on Tuesday and leave on Friday.\n",
    expected: { text: "leave on Friday", exact: true },
  },
  {
    name: "a quote whose text is gone, and its surroundings reworded, is detached",
    quote: quoteOf(offsite, "The hotel is booked."),
    text: "# Offsite\n\nPlans are still open.\n",
    expected: null,
  },
  {
    name: "a quote whose text was deleted between surroundings that stayed is detached, not empty",
    quote: quoteOf(offsite, " The hotel is booked."),
    text: offsite.replace(" The hotel is booked.", ""),
    expected: null,
  },
  {
    name: "a quote at the very start of the text is found by its suffix alone",
    quote: quoteAt(offsite, 0, "# Offsite".length),
    text: offsite.replace("# Offsite", "# Off-site"),
    expected: { text: "# Off-site", exact: false },
  },
])("anchor: $name", ({ quote, text, expected }) => {
  const found = findQuote(text, quote);
  const slice = found && { text: text.slice(found.from, found.to), ...found };
  expect({ found: slice }).toMatchObject({ found: expected });
});

// ── what worker.ts loads ──

test("worker.ts's import graph never reaches yjs, diff or node-diff3, which the processors do, at a path no publication resolves", () => {
  // the isolation that core/configs/default/apps/docs/processors/classes.ts explains
  const processorPackages = ["diff", "node-diff3", "yjs"];
  // none of the paths a publication resolves (core/mind-worker/src/mind/publication.ts)
  expect("apps/docs/processors/classes.ts").not.toMatch(/^(?:[^/]+|apps\/[^/]+\/backend\.[a-z]+)$/);
  const fromWorker = packagesReachedFrom("worker.ts");
  // the walk reaches the platform's packages, so it walks
  expect(fromWorker).toEqual(expect.arrayContaining(["iterate"]));
  expect(fromWorker.filter((name) => processorPackages.includes(name))).toEqual([]);
  expect(packagesReachedFrom("apps/docs/processors/classes.ts")).toEqual(
    expect.arrayContaining(processorPackages),
  );
});

// ── fixtures ──

/** One doc's context: its log, its processor over a real engine and node:sqlite, and a fake repo
 *  that refuses a stale parent the way the repo facet does. `join` is a browser: its own Y.Doc,
 *  synced the way the Docs page syncs (`sync`, then edit frames both ways). */
function openDoc(
  files: Record<string, string>,
  autosave: { idleMs: number; maxMs: number } = { idleMs: 5, maxMs: 20 },
) {
  const log = memoryStream("/docs/config/plan.md");
  const repo = fakeRepo(files);
  const storage = nodeSqliteDurableObjectStorage();
  // the engine's checkpoint outlives an incarnation, as the facet's storage does
  const checkpoints = memoryStorage();
  const start = (timing: { idleMs: number; maxMs: number }) => {
    const processor = new DocProcessor({
      sql: storage.sql as unknown as SqlStorage,
      getItx: () =>
        fakeItx({
          whoami: () => ({ path: "/docs/config/plan.md" }),
          // the repos are the root's, as on the platform
          cd: (path: string) => {
            if (path !== "/") throw new Error(`only the root has repos, not ${path}`);
            return { repos: { get: () => repo } };
          },
          append: log.stream.append,
        }),
      publishLiveState: () => engine.publishLiveState(),
      autosave: timing,
    });
    const engine = new ProcessorEngine(processor, { stream: log.stream, storage: checkpoints });
    log.engines.splice(0, log.engines.length, engine);
    return { processor, engine };
  };
  let current = start(autosave);
  const browsers: Y.Doc[] = [];
  // every edit frame on the log reaches every browser, as the Docs page's subscription does
  const deliver = (event: { type: string; payload?: unknown }) => {
    if (event.type !== EDIT_FRAME) return;
    const frame = EditFrame.parse(event.payload);
    for (const browser of browsers)
      if (frame.client !== browser.clientID)
        Y.applyUpdate(browser, fromBase64(frame.update), "remote");
  };
  const append = log.stream.append;
  log.stream.append = (...events) => {
    const committed = append(...events);
    void Promise.resolve(committed).then((landed) => landed.forEach(deliver));
    return committed;
  };
  return {
    repo,
    live: async () => (await current.engine.liveSnapshot()).state,
    restart: (timing: { idleMs: number; maxMs: number }) => (current = start(timing)),
    get engine() {
      return current.engine;
    },
    /** What the root's docs processor appends when a commit changed the doc. */
    notice: () =>
      log.stream.append({ type: COMMIT_NOTICED, ephemeral: true, payload: { commitOid: "?" } }),
    async join(email: string) {
      const browser = new Y.Doc();
      const synced = await current.processor.sync(
        toBase64(Y.encodeStateVector(browser)),
        browser.clientID,
      );
      Y.applyUpdate(browser, fromBase64(synced.update), "remote");
      browsers.push(browser);
      browser.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === "remote") return;
        log.stream.append({
          type: EDIT_FRAME,
          ephemeral: true,
          payload: { update: toBase64(update), client: browser.clientID },
          source: { principal: { actor: email, email } },
        });
      });
      const text = () => browser.getText("file").toString();
      return {
        text,
        type: (at: number, insert: string) => browser.getText("file").insert(at, insert),
        /** Replace the first `from` with `to`, as someone selecting it and typing would. */
        fix: (from: string, to: string) => {
          const at = text().indexOf(from);
          browser.transact(() => {
            browser.getText("file").delete(at, from.length);
            browser.getText("file").insert(at, to);
          });
        },
        /** A durable event from this person, as the Docs page appends a comment. */
        append: (type: string, payload: Record<string, unknown>) =>
          log.stream.append({ type, payload, source: { principal: { actor: email, email } } }),
        leave: () =>
          log.stream.append({
            type: DOC_LEFT,
            ephemeral: true,
            payload: { client: browser.clientID },
          }),
      };
    },
  };
}

type Commit = {
  oid: string;
  files: Record<string, string>;
  message: string;
  author?: { name: string; email: string };
};

/** The repo verbs the doc's processor calls, refusing a parent that is not the tip with the repo
 *  facet's own words. */
function fakeRepo(files: Record<string, string>) {
  const commits: Commit[] = [{ oid: oid(0), files, message: "first" }];
  const repo = {
    commits,
    refusals: 0,
    latest: () => commits.at(-1)!,
    tip: async () => repo.latest().oid,
    readFile: async (path: string, options: { commitOid: string }) =>
      commits.find((commit) => commit.oid === options.commitOid)?.files[path] ?? null,
    commitFiles: async (input: {
      message: string;
      changes: { path: string; content: string }[];
      parent: string | null;
      author?: { name: string; email: string };
    }) => {
      if (input.parent !== repo.latest().oid) {
        repo.refusals += 1;
        throw new Error(
          `repo /repos/config: the commit was refused: main is at ${repo.latest().oid}, not at the parent it names (${input.parent})`,
        );
      }
      const next = { ...repo.latest().files };
      for (const change of input.changes) next[change.path] = change.content;
      commits.push({
        oid: oid(commits.length),
        files: next,
        message: input.message,
        author: input.author,
      });
      return {
        commitOid: repo.latest().oid,
        changedPaths: input.changes.map((change) => change.path),
      };
    },
    commitElsewhere: (path: string, content: string) =>
      commits.push({
        oid: oid(commits.length),
        files: { ...repo.latest().files, [path]: content },
        message: "elsewhere",
      }),
    deleteElsewhere: (path: string) => {
      const { [path]: _deleted, ...rest } = repo.latest().files;
      commits.push({ oid: oid(commits.length), files: rest, message: "deleted elsewhere" });
    },
  };
  return repo;
}

/** The scope a processor's `getItx` hands out, with only the verbs the test gives it. The
 *  processors call nothing else, so the one cast stays here. */
function fakeItx(verbs: object) {
  return { ...verbs, [Symbol.dispose]: () => {} } as unknown as IterateContextApi & Disposable;
}

/** A doc processor for its reduce alone: the comments, with nothing to save. */
function bareDocProcessor() {
  return new DocProcessor({
    sql: nodeSqliteDurableObjectStorage().sql as unknown as SqlStorage,
    getItx: () => fakeItx({}),
    publishLiveState: () => {},
    autosave: { idleMs: 60_000, maxMs: 60_000 },
  });
}

function oid(n: number) {
  return n.toString(16).padStart(40, "0");
}

function quoteOf(text: string, part: string): Quote {
  const at = text.indexOf(part);
  return quoteAt(text, at, at + part.length);
}

function commitCompleted(path: string, commitOid: string, changedPaths: string[]) {
  return {
    type: "events.iterate.com/repo/commit-completed",
    payload: { path, commitOid, message: "m", changedPaths },
  };
}

/** The npm packages the module graph from `entry` (a path in the default config) imports, as the
 *  loader walks it: relative imports of code are followed, a page, a style sheet or a folder of
 *  files is text and imports nothing, and a commented-out line is no import. */
function packagesReachedFrom(entry: string) {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const code = readFileSync(new URL(`../../configs/default/${path}`, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const [, specifier] of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      // a package's name: its first segment, or its first two when it is scoped (`@scope/name`)
      if (!specifier!.startsWith("."))
        packages.add(
          specifier!
            .split("/")
            .slice(0, specifier!.startsWith("@") ? 2 : 1)
            .join("/"),
        );
      else if (/\.(ts|js)$/.test(specifier!)) queue.push(joinPath(path, specifier!));
    }
  }
  return [...packages].sort();
}

function joinPath(from: string, specifier: string) {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}
