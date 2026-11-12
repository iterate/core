// The rule by which a newer template reaches a config repo that exists (template-update.ts): what
// the platform may write, and what it must leave alone.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import {
  brokenByUpdate,
  importsOf,
  packagesOf,
  seedOf,
  templateChanges,
  writtenWith,
} from "./template-update.ts";

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
    refused: [],
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
      importedBy: [],
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
  expect(heldBack).toEqual([
    { path: "worker.ts", imports: ["apps/docs/processors/doc.ts"], importedBy: [] },
  ]);
  expect(appsLeftOld).toEqual([
    {
      app: "docs",
      yours: ["apps/docs/public/app.js"],
      lacksPackages: [],
      imports: [],
      importedBy: [],
      notWritten: ["apps/docs/app.ts", "apps/docs/processors/doc.ts"],
    },
    {
      app: "dash",
      yours: [],
      lacksPackages: [],
      imports: ["apps/docs/app.ts"],
      importedBy: [],
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

test("a file that the platform holds back keeps back what it imports: a shared file's newer version is not written under an app left old", () => {
  const seed = {
    "apps/open-files.ts": "export const openFile = 1;\n",
    "apps/live-reload/client.js": "old reload\n",
    "apps/docs/app.ts": 'import { openFile } from "../open-files.ts";\nimport "../live-reload/";\n',
    "apps/docs/page.js": "old page\n",
    "apps/dash/app.ts": 'import { openFile } from "../open-files.ts";\nold dash\n',
  };
  const template = [
    // the shared file renames its export, and every app's newer app.ts asks for the new name
    { path: "apps/open-files.ts", content: "export const openFileV2 = 1;\n" },
    { path: "apps/live-reload/client.js", content: "new reload\n" },
    {
      path: "apps/docs/app.ts",
      content: 'import { openFileV2 } from "../open-files.ts";\nimport "../live-reload/";\n',
    },
    { path: "apps/docs/page.js", content: "new page\n" },
    {
      path: "apps/dash/app.ts",
      content: 'import { openFileV2 } from "../open-files.ts";\nnew dash\n',
    },
  ];
  const current = { ...seed, "apps/docs/page.js": "my own page\n" };
  const { changes, heldBack, appsLeftOld } = templateChanges({
    template,
    current,
    ...platformWrote(seed, current),
  });
  // the older docs/app.ts stays, so what it imports stays; the newer dash/app.ts would then ask
  // the older shared file for a name it does not export, so the Dash stays too
  expect(changes).toEqual([]);
  expect(heldBack).toEqual([
    { path: "apps/open-files.ts", imports: [], importedBy: ["apps/docs/app.ts"] },
  ]);
  expect(appsLeftOld).toMatchObject([
    { app: "docs", yours: ["apps/docs/page.js"], notWritten: ["apps/docs/app.ts"] },
    { app: "live-reload", importedBy: ["apps/docs/app.ts"] },
    { app: "dash", imports: ["apps/open-files.ts"] },
  ]);
});

test("a file deleted in an app left old is not put back by a file of that app which holds the template's bytes", () => {
  const seed = {
    "apps/docs/a.js": 'import "./b.js";\nthe same a\n',
    "apps/docs/b.js": "old b\n",
    "apps/docs/page.js": "old page\n",
    "apps/docs/app.ts": "old app\n",
  };
  const template = [
    { path: "apps/docs/a.js", content: 'import "./b.js";\nthe same a\n' },
    { path: "apps/docs/b.js", content: "new b\n" },
    { path: "apps/docs/page.js", content: "new page\n" },
    { path: "apps/docs/app.ts", content: "new app\n" },
  ];
  const current = {
    "apps/docs/a.js": seed["apps/docs/a.js"],
    "apps/docs/page.js": "my own page\n",
    "apps/docs/app.ts": "old app\n",
  };
  expect(templateChanges({ template, current, ...platformWrote(seed, current) })).toMatchObject({
    changes: [],
    putBack: [],
    appsLeftOld: [{ app: "docs", yours: ["apps/docs/b.js", "apps/docs/page.js"] }],
  });
});

test("a deleted file is not put back when its newer version imports a file held back", () => {
  const seed = {
    "worker.ts": 'import "./lib.ts";\nthe same worker\n',
    "lib.ts": "old lib\n",
    "helper.ts": 'import "./apps/docs/app.ts";\nexport const helper = 1;\n',
    "apps/docs/app.ts": "old app\n",
    "apps/docs/page.js": "old page\n",
  };
  const template = [
    { path: "worker.ts", content: 'import "./lib.ts";\nthe same worker\n' },
    { path: "lib.ts", content: 'import { helperV2 } from "./helper.ts";\n' },
    { path: "helper.ts", content: 'import "./apps/docs/app.ts";\nexport const helperV2 = 1;\n' },
    { path: "apps/docs/app.ts", content: "new app\n" },
    { path: "apps/docs/page.js", content: "new page\n" },
  ];
  const { "lib.ts": gone, ...kept } = seed;
  const current = { ...kept, "apps/docs/page.js": "my own page\n" };
  expect(gone).toBe("old lib\n");
  expect(templateChanges({ template, current, ...platformWrote(seed, current) })).toMatchObject({
    changes: [],
    putBack: [],
    heldBack: [{ path: "helper.ts", imports: ["apps/docs/app.ts"] }],
  });
});

test("a deleted file that is not put back holds back the newer file that imports it: the commit names no file it does not bring", () => {
  const seed = {
    "worker.ts": "old worker\n",
    "lib.ts": "old lib\n",
    "helper.ts": 'import "./apps/docs/app.ts";\nexport const helper = 1;\n',
    "apps/docs/app.ts": "old app\n",
    "apps/docs/page.js": "old page\n",
  };
  const template = [
    // the newer worker imports lib.ts, whose newer text imports a file that is held back
    { path: "worker.ts", content: 'import "./lib.ts";\nnew worker\n' },
    { path: "lib.ts", content: 'import { helperV2 } from "./helper.ts";\n' },
    { path: "helper.ts", content: 'import "./apps/docs/app.ts";\nexport const helperV2 = 1;\n' },
    { path: "apps/docs/app.ts", content: "new app\n" },
    { path: "apps/docs/page.js", content: "new page\n" },
  ];
  const current = {
    "worker.ts": "old worker\n",
    "helper.ts": seed["helper.ts"],
    "apps/docs/app.ts": "old app\n",
    "apps/docs/page.js": "my own page\n",
  };
  expect(templateChanges({ template, current, ...platformWrote(seed, current) })).toMatchObject({
    changes: [],
    putBack: [],
    refused: [],
    heldBack: [
      { path: "helper.ts", imports: ["apps/docs/app.ts"] },
      { path: "worker.ts", imports: ["lib.ts"] },
    ],
  });
});

test("a deleted shared file is not put back newer while a file held at its older version imports it", () => {
  const seed = {
    "apps/open-files.ts": "export const openFile = 1;\n",
    "apps/docs/app.ts": 'import { openFile } from "../open-files.ts";\nold docs\n',
    "apps/docs/page.js": "old page\n",
    "apps/dash/app.ts": 'import { openFileV2 } from "../open-files.ts";\nthe same dash\n',
  };
  const template = [
    { path: "apps/open-files.ts", content: "export const openFileV2 = 1;\n" },
    {
      path: "apps/docs/app.ts",
      content: 'import { openFileV2 } from "../open-files.ts";\nnew docs\n',
    },
    { path: "apps/docs/page.js", content: "new page\n" },
    // the Dash holds the template's bytes already, and imports the deleted shared file
    { path: "apps/dash/app.ts", content: seed["apps/dash/app.ts"] },
  ];
  const current = {
    "apps/docs/app.ts": seed["apps/docs/app.ts"],
    "apps/docs/page.js": "my own page\n",
    "apps/dash/app.ts": seed["apps/dash/app.ts"],
  };
  expect(templateChanges({ template, current, ...platformWrote(seed, current) })).toMatchObject({
    changes: [],
    putBack: [],
    refused: [],
  });
});

// THE LAST LOOK. Each case is what an update decided before the rule that now prevents it: the
// guard is fed that decision as it was, and names what it would break.
const OLD_DOCS = {
  "apps/docs/app.ts": 'import { openFile } from "../open-files.ts";\nold docs\n',
  "apps/docs/page.js": "my own page\n",
  "apps/open-files.ts": "export const openFile = 1;\n",
  "worker.ts": "old worker\n",
  "helper.ts": 'import "./apps/docs/app.ts";\n',
};
test.for([
  {
    fault: "a newer worker imports a file that the newer app adds, and the app was left old",
    changes: [{ path: "worker.ts", content: 'import "./apps/docs/processors/doc.ts";\n' }],
    says: "worker.ts imports apps/docs/processors/doc.ts, which is not in the repo after this update",
  },
  {
    fault: "a newer importer had a file deleted in an app left old put back",
    changes: [
      { path: "worker.ts", content: 'import "./apps/docs/extra.ts";\n' },
      { path: "apps/docs/extra.ts", content: "new extra\n" },
    ],
    says: "apps/docs/extra.ts is a file of apps/docs, which stays at its version",
  },
  {
    fault: "a shared file's newer version was written under an app left old",
    changes: [{ path: "apps/open-files.ts", content: "export const openFileV2 = 1;\n" }],
    says: "apps/open-files.ts is imported by apps/docs/app.ts, which stays at its older version",
  },
  {
    fault: "a file of the app that holds the template's bytes had a deleted file put back newer",
    changes: [{ path: "apps/docs/b.js", content: "new b\n" }],
    says: "apps/docs/b.js is a file of apps/docs, which stays at its version",
  },
  {
    fault: "a file was put back newer beside a file held at its older version",
    changes: [{ path: "lib.ts", content: 'import { helperV2 } from "./helper.ts";\n' }],
    says: "lib.ts imports helper.ts, which stays at its older version",
  },
  {
    fault: "a deleted file was not put back, and the newer file that imports it was written",
    changes: [{ path: "worker.ts", content: 'import "./lib.ts";\nnew worker\n' }],
    says: "worker.ts imports lib.ts, which is not in the repo after this update",
  },
  {
    fault: "a deleted shared file was put back newer while an older held file imports it",
    current: (({ "apps/open-files.ts": gone, ...rest }) => rest)(OLD_DOCS),
    changes: [{ path: "apps/open-files.ts", content: "export const openFileV2 = 1;\n" }],
    says: "apps/open-files.ts is imported by apps/docs/app.ts, which stays at its older version",
  },
])("the last look refuses an update in which $fault", ({ changes, says, current }) => {
  const broken = brokenByUpdate({
    current: current || OLD_DOCS,
    changes,
    held: ["apps/docs/app.ts", "helper.ts"],
    appsLeftOld: ["docs"],
  });
  expect(broken.map(({ path, why }) => `${path} ${why}`)).toContain(says);
});

test("the default template itself passes the last look: a new mind gets every file of it", () => {
  // The guard reads a file's text for imports as `importsOf` does, so a line of the template that
  // only looks like an import (in a string, in a block comment) would name a file that is not
  // there, and every mind's update would then write nothing. Such a line fails here instead.
  const folder = join(import.meta.dirname, "../../../configs/default");
  const template = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.includes("node_modules"))
    .map((entry) => {
      const path = relative(folder, join(entry.parentPath, entry.name));
      return { path, content: readFileSync(join(folder, path), "utf8") };
    });
  const { refused, changes } = templateChanges({
    template,
    current: {},
    written: new Set(),
    untouched: new Set(),
  });
  expect({ refused, written: changes.length }).toEqual({ refused: [], written: template.length });
  expect(template.length).toBeGreaterThan(40);
});

test("the last look passes an update that brings what it names", () => {
  expect(
    brokenByUpdate({
      current: { "worker.ts": "old\n" },
      changes: [
        { path: "worker.ts", content: 'import "./apps/notes/";\n' },
        { path: "apps/notes/app.ts", content: "the app\n" },
      ],
      held: [],
      appsLeftOld: [],
    }),
  ).toEqual([]);
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
