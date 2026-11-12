// The rule by which a newer template reaches a config repo that exists (template-update.ts): what
// the platform may write, and what it must leave alone.
import { expect, test } from "vitest";
import { importsOf, packagesOf, seedOf, templateChanges, writtenWith } from "./template-update.ts";

test("a repo untouched since its seed gets the whole newer template: new files added, the platform's own files replaced", () => {
  const current = { "worker.ts": "old worker\n", "AGENTS.md": "old guide\n" };
  expect(
    templateChanges({ template: newer(), current, ...platformWrote(current, current) }),
  ).toEqual({
    changes: newer(),
    added: ["apps/onboarding/app.ts"],
    replaced: ["worker.ts", "AGENTS.md"],
    platforms: ["worker.ts", "AGENTS.md", "apps/onboarding/app.ts"],
    leftAlone: [],
    putBack: [],
    appsLeftOld: [],
    heldBack: [],
  });
});

test("a file somebody changed is never written: it is named, with the template's lines it lacks", () => {
  const seed = { "worker.ts": "old worker\n", "AGENTS.md": "old guide\n" };
  const current = { ...seed, "worker.ts": "old worker\nmy own line\n" };
  const { changes, added, replaced, platforms, leftAlone } = templateChanges({
    template: newer(),
    current,
    ...platformWrote(seed, current),
  });
  expect(changes.map((change) => change.path)).toEqual(["AGENTS.md", "apps/onboarding/app.ts"]);
  expect({ added, replaced, platforms }).toEqual({
    added: ["apps/onboarding/app.ts"],
    replaced: ["AGENTS.md"],
    platforms: ["AGENTS.md", "apps/onboarding/app.ts"],
  });
  expect(leftAlone).toEqual([
    {
      path: "worker.ts",
      lacks: ["import { onboardingApp } from './apps/onboarding/app.ts';", "new worker"],
    },
  ]);
});

test("a file left alone once is left alone at the next update too: it is in the repo's tree, and still not the platform's", () => {
  // the first update left the owner's worker.ts alone and wrote the rest: the record keeps what
  // the platform wrote there at the seed, which the owner's file is not
  const seed = { "worker.ts": "old worker\n", "AGENTS.md": "old guide\n" };
  const afterFirst = {
    "worker.ts": "old worker\nmy own line\n",
    "AGENTS.md": "new guide\n",
    "apps/onboarding/app.ts": "the app\n",
  };
  const next = [
    { path: "worker.ts", content: "newest worker\n" },
    { path: "AGENTS.md", content: "newest guide\n" },
    { path: "apps/onboarding/app.ts", content: "the app\n" },
  ];
  const wrote = { ...seed, "AGENTS.md": "new guide\n", "apps/onboarding/app.ts": "the app\n" };
  const { changes, leftAlone } = templateChanges({
    template: next,
    current: afterFirst,
    ...platformWrote(wrote, afterFirst),
  });
  expect(changes).toEqual([{ path: "AGENTS.md", content: "newest guide\n" }]);
  expect(leftAlone.map((file) => file.path)).toEqual(["worker.ts"]);
});

test("with no record of the platform's, a file the repo has is somebody's: only what it lacks is added", () => {
  const current = { "worker.ts": "theirs\n", "AGENTS.md": "new guide\n" };
  const { changes, platforms, leftAlone } = templateChanges({
    template: newer(),
    current,
    ...platformWrote({}, current),
  });
  expect(changes.map((change) => change.path)).toEqual(["apps/onboarding/app.ts"]);
  // a file that is the template's bytes already is the platform's from now on
  expect(platforms).toEqual(["AGENTS.md", "apps/onboarding/app.ts"]);
  expect(leftAlone.map((file) => file.path)).toEqual(["worker.ts"]);
});

test("a file the platform wrote and somebody deleted is not put back", () => {
  const seed = { "worker.ts": "old worker\n", "AGENTS.md": "old guide\n" };
  const current = { "worker.ts": "old worker\n" };
  const { changes, added, leftAlone } = templateChanges({
    template: newer(),
    current,
    ...platformWrote(seed, current),
  });
  expect(changes.map((change) => change.path)).toEqual(["worker.ts", "apps/onboarding/app.ts"]);
  expect(added).toEqual(["apps/onboarding/app.ts"]);
  expect(leftAlone).toEqual([{ path: "AGENTS.md", lacks: [] }]);
});

test("a deleted file is put back when a file the platform writes in the same update imports it", () => {
  // the exception of template-update.ts's header: a deleted folder, and a newer template whose
  // app.ts imports it
  const wrote = {
    "apps/docs/app.ts": "the docs app\n",
    "apps/live-reload/live-reload.js": "reload\n",
    "AGENTS.md": "a guide\n",
  };
  const current = { "apps/docs/app.ts": "the docs app\n" };
  const template = [
    {
      path: "apps/docs/app.ts",
      content: 'import liveReload from "../live-reload/";\nthe docs app\n',
    },
    { path: "apps/live-reload/live-reload.js", content: "reload\n" },
    { path: "AGENTS.md", content: "a guide\n" },
  ];
  const { changes, replaced, platforms, leftAlone, putBack } = templateChanges({
    template,
    current,
    ...platformWrote(wrote, current),
  });
  expect(putBack).toEqual([
    { path: "apps/live-reload/live-reload.js", importedBy: "apps/docs/app.ts" },
  ]);
  expect(changes.map((change) => change.path)).toEqual([
    "apps/docs/app.ts",
    "apps/live-reload/live-reload.js",
  ]);
  expect(replaced).toEqual(["apps/docs/app.ts"]);
  expect(platforms).toEqual(["apps/docs/app.ts", "apps/live-reload/live-reload.js"]);
  // the guide that nothing imports stays deleted
  expect(leftAlone).toEqual([{ path: "AGENTS.md", lacks: [] }]);
});

test("a deleted file that an unchanged file of the platform's imports is put back too, and what it imports with it", () => {
  const wrote = {
    "worker.ts": 'import { app } from "./apps/docs/app.ts";\n',
    "apps/docs/app.ts": 'import index from "./index.html";\nimport files from "./public/";\n',
    "apps/docs/index.html": "<p>docs</p>\n",
    "apps/docs/public/app.js": "page\n",
    "apps/docs/public/app.css": "style\n",
  };
  const template = Object.entries(wrote).map(([path, content]) => ({ path, content }));
  // the whole app deleted, and the worker that mounts it left as the platform wrote it
  const current = { "worker.ts": wrote["worker.ts"] };
  const { changes, putBack, leftAlone } = templateChanges({
    template,
    current,
    ...platformWrote(wrote, current),
  });
  expect(putBack).toEqual([
    { path: "apps/docs/app.ts", importedBy: "worker.ts" },
    { path: "apps/docs/index.html", importedBy: "apps/docs/app.ts" },
    { path: "apps/docs/public/app.js", importedBy: "apps/docs/app.ts" },
    { path: "apps/docs/public/app.css", importedBy: "apps/docs/app.ts" },
  ]);
  expect(changes.map((change) => change.path)).toEqual(putBack.map((file) => file.path));
  expect(leftAlone).toEqual([]);
});

test("a deleted file stays deleted when its importer is somebody's, or when its folder still has a file", () => {
  const wrote = {
    "worker.ts": 'import { app } from "./apps/docs/app.ts";\n',
    "apps/docs/app.ts": 'import files from "./public/";\n',
    "apps/docs/public/app.js": "page\n",
    "apps/docs/public/home.js": "home\n",
  };
  const template = Object.entries(wrote).map(([path, content]) => ({ path, content }));
  // one file of a folder deleted: the folder's import still answers
  const oneGone = { ...wrote } as Record<string, string>;
  delete oneGone["apps/docs/public/home.js"];
  expect(
    templateChanges({ template, current: oneGone, ...platformWrote(wrote, oneGone) }),
  ).toMatchObject({
    changes: [],
    putBack: [],
    leftAlone: [{ path: "apps/docs/public/home.js", lacks: [] }],
  });
  // the app deleted and its mount taken out of worker.ts: the owner's worker imports nothing
  const unmounted = { "worker.ts": "// no docs app here\n" };
  expect(
    templateChanges({ template, current: unmounted, ...platformWrote(wrote, unmounted) }),
  ).toMatchObject({ changes: [], putBack: [] });
});

test("an app is written whole or not at all: one file of it that somebody changed keeps the whole app at its version", () => {
  const seed = {
    "worker.ts": "old worker\n",
    "apps/docs/app.ts": "old app\n",
    "apps/docs/public/app.js": "old page\n",
    "apps/dash/app.ts": "old dash\n",
  };
  const current = { ...seed, "apps/docs/public/app.js": "my own page\n" };
  const { changes, leftAlone, appsLeftOld } = templateChanges({
    template: withDocs(),
    current,
    ...platformWrote(seed, current),
  });
  // the other app and the root's file move on; nothing under apps/docs is written
  expect(changes.map((change) => change.path)).toEqual(["worker.ts", "apps/dash/app.ts"]);
  expect(leftAlone.map((file) => file.path)).toEqual(["apps/docs/public/app.js"]);
  expect(appsLeftOld).toEqual([
    {
      app: "docs",
      yours: ["apps/docs/public/app.js"],
      lacksPackages: [],
      imports: [],
      notWritten: ["apps/docs/app.ts", "apps/docs/processors/doc.ts"],
    },
  ]);
});

test("an app whose new files import a package that somebody's package.json does not list stays at its version, and follows once it is listed", () => {
  const seed = {
    "package.json": '{"dependencies":{}}',
    "worker.ts": "new worker\n",
    "apps/docs/app.ts": "old app\n",
    "apps/docs/public/app.js": "old page\n",
    "apps/dash/app.ts": "new dash\n",
  };
  const template = [
    ...withDocs(),
    { path: "package.json", content: '{"dependencies":{"yjs":"13.6.33","diff":"8.0.4"}}' },
  ];
  const theirs = { ...seed, "package.json": '{"name":"mine","dependencies":{"diff":"8.0.4"}}' };
  expect(
    templateChanges({ template, current: theirs, ...platformWrote(seed, theirs) }),
  ).toMatchObject({
    changes: [],
    appsLeftOld: [
      {
        app: "docs",
        yours: [],
        lacksPackages: ["yjs"],
        notWritten: ["apps/docs/app.ts", "apps/docs/public/app.js", "apps/docs/processors/doc.ts"],
      },
    ],
  });
  const listed = { ...seed, "package.json": '{"name":"mine","dependencies":{"yjs":"13.6.33"}}' };
  expect(
    templateChanges({ template, current: listed, ...platformWrote(seed, listed) }),
  ).toMatchObject({
    added: ["apps/docs/processors/doc.ts"],
    replaced: ["apps/docs/app.ts", "apps/docs/public/app.js"],
    appsLeftOld: [],
  });
});

test("a file of the platform's that imports a file of an app left old is held back with it: the commit never names a file it does not bring", () => {
  const seed = {
    "worker.ts": "old worker\n",
    "AGENTS.md": "old guide\n",
    "apps/docs/app.ts": "old app\n",
    "apps/docs/public/app.js": "old page\n",
    "apps/dash/app.ts": "old dash\n",
  };
  const template = [
    // the newer worker imports a file that the newer Docs app adds
    {
      path: "worker.ts",
      content: 'import { doc } from "./apps/docs/processors/doc.ts";\nnew worker\n',
    },
    { path: "AGENTS.md", content: "new guide\n" },
    { path: "apps/docs/app.ts", content: "new app\n" },
    { path: "apps/docs/public/app.js", content: "new page\n" },
    { path: "apps/docs/processors/doc.ts", content: "export const doc = 1;\n" },
    // and the newer Dash imports the newer Docs app's own module
    { path: "apps/dash/app.ts", content: 'import "../docs/app.ts";\nnew dash\n' },
  ];
  const current = { ...seed, "apps/docs/public/app.js": "my own page\n" };
  const { changes, heldBack, appsLeftOld } = templateChanges({
    template,
    current,
    ...platformWrote(seed, current),
  });
  expect(changes.map((change) => change.path)).toEqual(["AGENTS.md"]);
  expect(heldBack).toEqual([{ path: "worker.ts", imports: ["apps/docs/processors/doc.ts"] }]);
  expect(appsLeftOld).toEqual([
    {
      app: "docs",
      yours: ["apps/docs/public/app.js"],
      lacksPackages: [],
      imports: [],
      notWritten: ["apps/docs/app.ts", "apps/docs/processors/doc.ts"],
    },
    {
      app: "dash",
      yours: [],
      lacksPackages: [],
      imports: ["apps/docs/app.ts"],
      notWritten: ["apps/dash/app.ts"],
    },
  ]);
});

test("two files outside apps that import each other, one of which imports an app left old, are both held back, and the comparison ends", () => {
  const seed = {
    "worker.ts": "old worker\n",
    "routes.ts": "old routes\n",
    "apps/docs/app.ts": "old app\n",
    "apps/docs/public/app.js": "old page\n",
  };
  const template = [
    { path: "worker.ts", content: 'import "./routes.ts";\nnew worker\n' },
    { path: "routes.ts", content: 'import "./worker.ts";\nimport "./apps/docs/app.ts";\n' },
    { path: "apps/docs/app.ts", content: "new app\n" },
    { path: "apps/docs/public/app.js", content: "new page\n" },
  ];
  const current = { ...seed, "apps/docs/public/app.js": "my own page\n" };
  expect(templateChanges({ template, current, ...platformWrote(seed, current) })).toMatchObject({
    changes: [],
    heldBack: [
      { path: "routes.ts", imports: ["apps/docs/app.ts"] },
      { path: "worker.ts", imports: ["routes.ts"] },
    ],
  });
});

test("a file somebody deleted in an app left old is not put back by a newer importer: the importer is held back", () => {
  const seed = {
    "worker.ts": "old worker\n",
    "apps/docs/app.ts": "old app\n",
    "apps/docs/extra.ts": "old extra\n",
  };
  const template = [
    { path: "worker.ts", content: 'import "./apps/docs/extra.ts";\nnew worker\n' },
    { path: "apps/docs/app.ts", content: "new app\n" },
    { path: "apps/docs/extra.ts", content: "new extra\n" },
  ];
  const current = { "worker.ts": "old worker\n", "apps/docs/app.ts": "old app\n" };
  expect(templateChanges({ template, current, ...platformWrote(seed, current) })).toMatchObject({
    changes: [],
    putBack: [],
    heldBack: [{ path: "worker.ts", imports: ["apps/docs/extra.ts"] }],
    appsLeftOld: [{ app: "docs", yours: ["apps/docs/extra.ts"], notWritten: ["apps/docs/app.ts"] }],
  });
});

test("an app that is all new, and the worker that imports it, are written: nothing of it is anybody's", () => {
  const seed = { "worker.ts": "old worker\n" };
  const template = [
    { path: "worker.ts", content: 'import { app } from "./apps/notes/app.ts";\nnew worker\n' },
    { path: "apps/notes/app.ts", content: 'import "./public/";\nexport const app = 1;\n' },
    { path: "apps/notes/public/app.js", content: "the page\n" },
  ];
  expect(templateChanges({ template, current: seed, ...platformWrote(seed, seed) })).toMatchObject({
    added: ["apps/notes/app.ts", "apps/notes/public/app.js"],
    replaced: ["worker.ts"],
    heldBack: [],
    appsLeftOld: [],
  });
});

test("the record keeps the last four versions the platform wrote at a path, each once", () => {
  // a record from before the list is one hash
  expect(writtenWith("a", "b")).toEqual(["a", "b"]);
  expect(writtenWith(["a", "b"], "a")).toEqual(["b", "a"]);
  expect(writtenWith(["a", "b", "c", "d"], "e")).toEqual(["b", "c", "d", "e"]);
  expect(writtenWith(undefined, "a")).toEqual(["a"]);
});

test("a module's packages are the names it imports that are no path: a scope keeps its second part", () => {
  expect(
    packagesOf(
      "apps/docs/processors/doc.ts",
      [
        'import * as Y from "yjs";',
        'import { diffLines } from "diff/lib/index.js";',
        'const merge = await import("@scope/name/deep");',
        'import { local } from "./local.ts";',
        '// import "commented";',
      ].join("\n"),
    ),
  ).toEqual(["yjs", "diff", "@scope/name"]);
  expect(packagesOf("README.md", 'import "yjs";')).toEqual([]);
});

test("a module's imports are its relative ones, resolved from its folder; a comment's import is none", () => {
  expect(
    importsOf(
      "apps/agents/app.ts",
      [
        'import { serveFiles } from "iterate/sdk";',
        'import theme from "../theme.css";',
        "import index from './index.html';",
        'import files from "./public/";',
        '// import { guestbookApp } from "../guestbook/app.ts";',
        ' * import "./in-a-block-comment.ts";',
        'const kind = () => import("../../agent-kinds/iterate.ts");',
        'import "./side-effect.js";',
      ].join("\n"),
    ),
  ).toEqual([
    "apps/theme.css",
    "apps/agents/index.html",
    "apps/agents/public/",
    "agent-kinds/iterate.ts",
    "apps/agents/side-effect.js",
  ]);
  // a page is not code: its script addresses are the host's, not the repo's
  expect(
    importsOf("apps/agents/index.html", '<script type="module" src="/app.js"></script>'),
  ).toEqual([]);
});

test("a repo that is the template already changes nothing, and nothing is ever deleted", () => {
  const template = Object.fromEntries(newer().map((file) => [file.path, file.content]));
  const current = {
    ...template,
    "agents.ts": "a module an older template had\n",
    "logo.png": { base64: "iVBORw0KGgo=" },
  };
  const { changes, leftAlone } = templateChanges({
    template: newer(),
    current,
    ...platformWrote(template, current),
  });
  expect({ changes, leftAlone }).toEqual({ changes: [], leftAlone: [] });
});

test("the seed is the commit with no parent that the platform authored as a seed, and no other", () => {
  const platform = { email: "config@iterate.com" };
  const seed = { oid: "c1", message: "seed: core/configs/default", author: platform, parents: [] };
  const later = [
    { oid: "c3", message: "my change", author: { email: "ada@example.com" }, parents: ["c2"] },
    // on a born main the platform authors a member's commit that names no author, whatever it
    // says: a tree with somebody's files in it
    { oid: "c2", message: "seed: core/configs/default", author: platform, parents: ["c1"] },
  ];
  expect(seedOf([...later, seed], platform.email)).toEqual({ oid: "c1", template: "default" });
  // out of the log's reach
  expect(seedOf(later, platform.email)).toBeUndefined();
  // a first commit somebody else made, or one that is no seed
  expect(
    seedOf([{ ...seed, author: { email: "ada@example.com" } }], platform.email),
  ).toBeUndefined();
  expect(seedOf([{ ...seed, message: "first" }], platform.email)).toBeUndefined();
});

function newer() {
  return [
    {
      path: "worker.ts",
      content: "import { onboardingApp } from './apps/onboarding/app.ts';\nnew worker\n",
    },
    { path: "AGENTS.md", content: "new guide\n" },
    { path: "apps/onboarding/app.ts", content: "the app\n" },
  ];
}

/** A template whose Docs app is newer in every file, and has a file more that imports a package. */
function withDocs() {
  return [
    { path: "worker.ts", content: "new worker\n" },
    { path: "apps/docs/app.ts", content: "new app\n" },
    { path: "apps/docs/public/app.js", content: "new page\n" },
    { path: "apps/docs/processors/doc.ts", content: 'import * as Y from "yjs";\n' },
    { path: "apps/dash/app.ts", content: "new dash\n" },
  ];
}

/** The platform's record as the processor hands it over: the paths it `wrote`, and those of them
 *  that `current` still has byte for byte. */
function platformWrote(wrote: Record<string, string>, current: Record<string, unknown>) {
  return {
    written: new Set(Object.keys(wrote)),
    untouched: new Set(Object.keys(wrote).filter((path) => current[path] === wrote[path])),
  };
}
