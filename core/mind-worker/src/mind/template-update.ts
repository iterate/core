// A NEWER TEMPLATE REACHES A MIND THAT ALREADY EXISTS. A config repo is seeded once, so new code
// compares it with the template it bundles (processor.ts, once per incarnation) and commits what
// that template adds. The rule is per file, and exact: the platform writes a file the repo lacks,
// and replaces one that is still byte for byte what the platform itself wrote there before. A file
// somebody changed is never written, and a file somebody deleted is not put back: each is named,
// with the template's lines it lacks. Nothing is deleted, so a module an older template had (and
// code made from it) stays.
//
// AN APP IS ONE UNIT (`apps/<name>/`). Its files are written all together or not at all: when
// somebody changed or deleted one of them, the app stays at the version it has (`appsLeftOld`).
// Half of a newer app beside half of an older one loads, and does not work. A file of the
// platform's that
// imports a file not written for that reason is not written either (`heldBack`, or its own app
// in `appsLeftOld`): the commit never names a file it does not bring. And what a file held back
// imports is held back with it, so that an older file never meets a newer one it was not
// written for. One shared file that moves can so keep several apps at their version.
// A package that newer files import is added to a package.json that is somebody's
// (`packagesAdded`): the one thing the platform writes into a file that is not its own. A package
// listed there at an older version than the template's is left, and named (`packagesOlder`).
//
// THE WAY BACK to the platform's file is to commit it: a file that is the template's bytes, or
// any bytes the platform wrote there before (`TemplateKept.written` keeps the last few), is the
// platform's again, and the next comparison writes over it.
//
// ONE EXCEPTION, so that the platform's own commit can always publish: a file somebody deleted IS
// put back when one of the platform's own files imports it (`putBack`). Otherwise a newer
// template that gives a file of the platform's an import of a deleted file or folder writes the
// import and leaves its target out, and the config repo no longer loads.
//
// What the platform wrote is its own record, by path (`TemplateKept.written`), and never read off
// a later commit's tree: that tree also holds the files it left alone. A mind older than the
// record starts it from its seed, the one commit whose whole tree is the platform's.

import { z } from "zod";

/** A repo's files as its facet answers them (`files()`): text, or base64 for a file that is not. */
export type RepoFiles = Record<string, string | { base64: string }>;

/** What the mind's facet keeps between updates, in its own storage. */
export type TemplateKept = {
  /** The bundled templates the repo was last compared with: one set is compared once. */
  hash: string;
  /** The template the repo follows. */
  template?: string;
  /** The SHA-256 of what the platform wrote, by path: the newest last, at most `WRITTEN_KEPT` of
   *  them. One hash alone is a record from before the list. */
  written?: Record<string, string | string[]>;
  /** The repo's tip at a comparison that left an app old: a later tip is compared again, with the
   *  same templates, so that the app follows once its files are the platform's again. */
  leftOldAt?: string;
  /** The platform's last commit of a template. When its publication is refused, that is said as a
   *  fact of its own (`mind/template-not-published`). */
  commit?: string;
};

/** How many versions of a file the record keeps: the facet's storage holds one value of 128 KiB. */
const WRITTEN_KEPT = 4;

/** The versions that the record keeps for one path, the newest last. */
export const versionsWritten = (record: string | string[] | undefined): string[] =>
  typeof record === "string" ? [record] : record || [];

/** The record after the platform wrote `hash` at a path whose record was `before`. */
export function writtenWith(before: string | string[] | undefined, hash: string): string[] {
  return [...versionsWritten(before).filter((one) => one !== hash), hash].slice(-WRITTEN_KEPT);
}

/** The message of the commit that applies a template. */
export const templateCommitMessage = (template: string) => `template: core/configs/${template}`;

/** The repo's seed, if `log` (newest first, main's first parents) reaches it: the commit with no
 *  parent that the platform authored as `seed: core/configs/<template>`. Only on an unborn main
 *  does the platform commit a template whole, so every file of that commit is the platform's. */
export function seedOf(
  log: readonly { oid: string; message: string; author: { email: string }; parents: string[] }[],
  platformEmail: string,
): { oid: string; template: string } | undefined {
  const root = log.find((entry) => entry.parents.length === 0);
  const template =
    root?.author.email === platformEmail &&
    /^seed: core\/configs\/([\w-]+)/.exec(root.message)?.[1];
  return root && template ? { oid: root.oid, template } : undefined;
}

/** What the template changes at the repo's tip. `current` is the tip's files. `written` are the
 *  paths the platform wrote before, and `untouched` those of them whose file is still byte for byte
 *  what it wrote. `platforms` are the paths that hold the template's own bytes afterwards.
 *  `putBack` are the deleted files that the platform's own files import, each with one file that
 *  imports it: they are written again, and are not in `leftAlone`. */
export function templateChanges(input: {
  template: readonly { path: string; content: string }[];
  current: RepoFiles;
  written: ReadonlySet<string>;
  untouched: ReadonlySet<string>;
}) {
  const writes: { path: string; content: string; kind: "added" | "replaced" }[] = [];
  const same: string[] = [];
  let leftAlone: { path: string; lacks: string[] }[] = [];
  /** The template's files that the platform wrote and somebody deleted. */
  const deleted = new Set<string>();
  for (const { path, content } of input.template) {
    if (!Object.hasOwn(input.current, path)) {
      // the platform wrote it and it is gone: somebody deleted it
      if (input.written.has(path)) {
        deleted.add(path);
        leftAlone.push({ path, lacks: [] });
      } else writes.push({ path, content, kind: "added" });
      continue;
    }
    const now = input.current[path];
    if (now === content) {
      same.push(path);
      continue;
    }
    if (input.untouched.has(path)) {
      writes.push({ path, content, kind: "replaced" });
      continue;
    }
    // somebody changed it: the lines of the template's file that theirs has not, to add by hand
    const theirs =
      typeof now === "string" ? new Set(now.split("\n").map((line) => line.trim())) : null;
    const lacks = theirs
      ? content.split("\n").filter((line) => line.trim() && !theirs.has(line.trim()))
      : [];
    leftAlone.push({ path, lacks: lacks.slice(0, 40) });
  }
  // AN APP IS WRITTEN WHOLE OR NOT AT ALL. The packages count only when package.json stays
  // somebody's: the platform's own lists what its apps import.
  const manifest = "package.json";
  const lacked = leftAlone.some((file) => file.path === manifest)
    ? packagesLacked(
        input.template.find((file) => file.path === manifest)?.content,
        input.current[manifest],
      )
    : [];
  // THE PACKAGES THAT THE NEWER FILES IMPORT ARE ADDED to a package.json that is somebody's: each
  // one the file does not list, at the template's version, and nothing else of the file changes.
  // So no app stays old for a package, unless the file cannot be read as JSON. Which packages
  // are added is decided at the end, from the files that are written after all.
  const templateManifest = input.template.find((file) => file.path === manifest)?.content;
  const listable = manifestWith(input.current[manifest], templateManifest, lacked) !== null;
  const lacking = listable ? [] : lacked;
  const appsLeftOld = [...new Set(writes.map((write) => appOf(write.path)))]
    .filter(Boolean)
    .map((app) => ({
      app,
      yours: leftAlone.filter((file) => appOf(file.path) === app).map((file) => file.path),
      lacksPackages: lacking.filter((name) =>
        input.template.some(
          (file) => appOf(file.path) === app && packagesOf(file.path, file.content).includes(name),
        ),
      ),
      // Filled below, for an app that stays old only because of another one. The casts: an empty
      // list has no element type of its own, and these two hold paths.
      imports: [] as string[],
      importedBy: [] as string[],
      notWritten: writes.filter((write) => appOf(write.path) === app).map((write) => write.path),
    }))
    .filter((app) => app.yours.length > 0 || app.lacksPackages.length > 0);
  // WHAT IS NOT WRITTEN KEEPS BACK WHAT IMPORTS IT AND WHAT IT IMPORTS, until nothing moves.
  // The things the update may write are its writes and the files somebody deleted (written again
  // only when a file of the platform's imports them, `putBack` below). One of them is kept back:
  //  - when its newer text imports a path that is kept back: it would name a file the commit does
  //    not bring, or ask a file left at its older version for what only the newer one exports;
  //  - when a file of the platform's that stays at its older version imports it, read from the
  //    repo's own text of that file: a shared file such as `apps/open-files.ts`, whose newer
  //    version may no longer export what the older file asks for.
  // A write under `apps/` takes its whole app with it; any other write is held back alone
  // (`heldBack`); a deleted file is only not put back. A file that is somebody's keeps nothing
  // back: it was never the platform's to keep in step. A file deleted in an app left old is kept
  // back from the start.
  const items: { path: string; content: string; kind: "added" | "replaced" | "deleted" }[] = [
    ...writes,
    ...input.template
      .filter((file) => deleted.has(file.path))
      .map((file) => ({ ...file, kind: "deleted" as const })),
  ];
  const withheld = new Set(
    appsLeftOld.flatMap((app) => [
      ...app.notWritten,
      ...app.yours.filter((path) => deleted.has(path)),
    ]),
  );
  const heldBack: { path: string; imports: string[]; importedBy: string[] }[] = [];
  for (let moved = true; moved;) {
    moved = false;
    for (const item of items) {
      if (withheld.has(item.path)) continue;
      const imports = [...withheld].filter((path) =>
        names(importsOf(item.path, item.content), path),
      );
      const importedBy = olderImportersOf(item.path, items, withheld, input.current);
      if (imports.length === 0 && importedBy.length === 0) continue;
      moved = true;
      const app = item.kind === "deleted" ? "" : appOf(item.path);
      const notWritten = app
        ? writes.filter((one) => appOf(one.path) === app).map((one) => one.path)
        : [item.path];
      for (const path of notWritten) withheld.add(path);
      // a deleted file of that app is not put back either
      if (app) for (const gone of deleted) if (appOf(gone) === app) withheld.add(gone);
      if (app)
        appsLeftOld.push({ app, yours: [], lacksPackages: [], imports, importedBy, notWritten });
      else if (item.kind !== "deleted") heldBack.push({ path: item.path, imports, importedBy });
    }
  }
  const written = writes.filter((write) => !withheld.has(write.path));
  let changes = written.map(({ path, content }) => ({ path, content }));
  let added = written.filter((write) => write.kind === "added").map((write) => write.path);
  let replaced = written.filter((write) => write.kind === "replaced").map((write) => write.path);
  // in the template's order, as a reader of the fact expects
  const holds = new Set([...same, ...written.map((write) => write.path)]);
  let platforms = input.template.map((file) => file.path).filter((path) => holds.has(path));
  // WHAT THE PLATFORM'S OWN FILES IMPORT MUST BE THERE. Each file that holds the template's bytes
  // after this update is read once, a file put back too (it can import another deleted one). A
  // deleted file that is kept back (above) is not put back.
  const contents = new Map(input.template.map((file) => [file.path, file.content]));
  const there = new Set([...Object.keys(input.current), ...changes.map((change) => change.path)]);
  let putBack: { path: string; importedBy: string }[] = [];
  for (let next = 0; next < platforms.length; next += 1) {
    const importer = platforms[next]!;
    for (const target of importsOf(importer, contents.get(importer)!)) {
      // a folder is every file under it: its import fails only when no file is there
      const isFolder = target.endsWith("/");
      if (isFolder ? [...there].some((path) => path.startsWith(target)) : there.has(target))
        continue;
      for (const path of [...deleted].filter(
        (gone) => (isFolder ? gone.startsWith(target) : gone === target) && !withheld.has(gone),
      )) {
        deleted.delete(path);
        there.add(path);
        changes.push({ path, content: contents.get(path)! });
        platforms.push(path);
        putBack.push({ path, importedBy: importer });
      }
    }
  }
  // THE LAST LOOK, WHICH NO RULE ABOVE STANDS IN FOR: the tree that this update would leave is
  // read once more (`brokenByUpdate`). When anything in it is broken, the update writes NOTHING,
  // and the fact says what (`refused`). A commit that does not load keeps every later commit of
  // the mind's from being published, which is worse than a mind that waits one deploy.
  // Only a package that a file written after all imports is added: a file kept back brings none.
  const listed = manifestWith(
    input.current[manifest],
    templateManifest,
    lacked.filter((name) =>
      changes.some((file) => packagesOf(file.path, file.content).includes(name)),
    ),
  );
  let packagesAdded = listed ? listed.added : [];
  // A package that somebody lists at an older version than the template's stays as it is: no
  // line of theirs is changed. It is named, when a file written here imports it.
  let packagesOlder = olderPins(input.current[manifest], templateManifest).filter(({ name }) =>
    changes.some((file) => packagesOf(file.path, file.content).includes(name)),
  );
  const refused = brokenByUpdate({
    current: input.current,
    changes,
    held: items
      .filter((item) => item.kind === "replaced" && withheld.has(item.path))
      .map((item) => item.path),
    appsLeftOld: appsLeftOld.map((app) => app.app),
    packages: { lacked, added: packagesAdded.map((one) => one.name) },
  });
  if (refused.length > 0) {
    changes = [];
    added = [];
    replaced = [];
    putBack = [];
    packagesAdded = [];
    packagesOlder = [];
    platforms = input.template.map((file) => file.path).filter((path) => same.includes(path));
  }
  if (listed && packagesAdded.length > 0) changes.push({ path: manifest, content: listed.content });
  if (putBack.length) {
    const back = new Set(putBack.map((file) => file.path));
    leftAlone = leftAlone.filter((file) => !back.has(file.path));
  }
  return {
    changes,
    added,
    replaced,
    platforms,
    leftAlone,
    putBack,
    appsLeftOld,
    heldBack,
    refused,
    packagesAdded,
    packagesOlder,
  };
}

/** Whether one of an import's `targets` names `path`: the file itself, or a folder it is under. */
const names = (targets: string[], path: string) =>
  targets.some((target) => (target.endsWith("/") ? path.startsWith(target) : path === target));

/** The files of the platform's that stay at their older version (a replacement that is kept back)
 *  and import `path`, by the repo's own text of each. */
function olderImportersOf(
  path: string,
  items: readonly { path: string; kind: string }[],
  withheld: ReadonlySet<string>,
  current: RepoFiles,
): string[] {
  return items
    .filter((held) => {
      const older = current[held.path];
      return (
        held.kind === "replaced" &&
        withheld.has(held.path) &&
        typeof older === "string" &&
        names(importsOf(held.path, older), path)
      );
    })
    .map((held) => held.path);
}

/**
 * WHAT AN UPDATE WOULD BREAK, read off the tree it would leave: the repo's files and `changes`.
 * `held` are the files of the platform's that stay at their older version, `appsLeftOld` the apps
 * that stay whole. It asks four things of every file the update writes, and answers each that
 * fails:
 *  - each of its relative imports is a file of the tree (a folder: some file under it);
 *  - none of them is a file that stays at its older version;
 *  - no file that stays at its older version imports it (by the repo's text of that file);
 *  - it is not a file of an app that stays whole;
 *  - each package it imports that the repo's package.json lacked is one this update adds.
 * And of each package the update adds: a file it writes imports it.
 * It does not depend on how the set to write was reached, so a rule that the comparison lacks
 * shows here as a refusal and not as a config repo that no longer loads.
 */
export function brokenByUpdate(input: {
  current: RepoFiles;
  changes: readonly { path: string; content: string }[];
  held: readonly string[];
  appsLeftOld: readonly string[];
  /** The template's packages that the repo's package.json `lacked` before the update, and those
   *  of them that the update adds. */
  packages?: { lacked: readonly string[]; added: readonly string[] };
}): { path: string; why: string }[] {
  const tree = new Set([...Object.keys(input.current), ...input.changes.map((file) => file.path)]);
  const held = new Set(input.held);
  const broken: { path: string; why: string }[] = [];
  for (const { path, content } of input.changes) {
    if (input.appsLeftOld.includes(appOf(path)))
      broken.push({ path, why: `is a file of apps/${appOf(path)}, which stays at its version` });
    for (const target of importsOf(path, content)) {
      const found = [...tree].filter((one) => names([target], one));
      if (found.length === 0)
        broken.push({ path, why: `imports ${target}, which is not in the repo after this update` });
      for (const older of found.filter((one) => held.has(one)))
        broken.push({ path, why: `imports ${older}, which stays at its older version` });
    }
    for (const older of input.held) {
      const text = input.current[older];
      if (typeof text === "string" && names(importsOf(older, text), path))
        broken.push({ path, why: `is imported by ${older}, which stays at its older version` });
    }
  }
  const { lacked, added } = input.packages || { lacked: [], added: [] };
  for (const { path, content } of input.changes)
    for (const name of packagesOf(path, content))
      if (lacked.includes(name) && !added.includes(name))
        broken.push({ path, why: `imports the package ${name}, which package.json does not list` });
  for (const name of added)
    if (!input.changes.some((file) => packagesOf(file.path, file.content).includes(name)))
      broken.push({
        path: "package.json",
        why: `would list ${name}, which no file written in this update imports`,
      });
  return broken;
}

/** The app a repo path is a file of: `apps/<name>/…`, else none (""). */
function appOf(path: string): string {
  return /^apps\/([^/]+)\//.exec(path)?.[1] || "";
}

/** The packages that the template's package.json lists and the repo's own does not. A manifest
 *  that is no JSON lacks none: the update does not judge it. */
function packagesLacked(template: string | undefined, current: RepoFiles[string] | undefined) {
  const listed = (text: unknown) => {
    try {
      return Manifest.parse(JSON.parse(String(text))).dependencies;
    } catch {
      return null;
    }
  };
  const [theirs, ours] = [listed(template), listed(current)];
  return theirs && ours ? Object.keys(theirs).filter((name) => !Object.hasOwn(ours, name)) : [];
}
const Manifest = z.object({ dependencies: z.record(z.string(), z.string()).default({}) });

/** Somebody's package.json with `names` added to its dependencies, at the template's versions:
 *  the file's own keys, order and indent stay. Null when either manifest is no JSON object, or
 *  no name is to add. */
function manifestWith(
  current: RepoFiles[string] | undefined,
  template: string | undefined,
  names: readonly string[],
): { content: string; added: { name: string; version: string }[] } | null {
  if (typeof current !== "string" || !template || names.length === 0) return null;
  try {
    const versions = Manifest.parse(JSON.parse(template)).dependencies;
    const ours = z.record(z.string(), z.unknown()).parse(JSON.parse(current));
    const added = names.map((name) => ({ name, version: versions[name]! }));
    const dependencies = {
      ...Manifest.parse(ours).dependencies,
      ...Object.fromEntries(added.map(({ name, version }) => [name, version])),
    };
    const indent = /^([ \t]+)"/m.exec(current)?.[1] || 2;
    const content = JSON.stringify({ ...ours, dependencies }, null, indent);
    return { content: current.endsWith("\n") ? `${content}\n` : content, added };
  } catch {
    return null;
  }
}

/** The packages that both manifests list, where somebody's version is older than the template's:
 *  each with both versions. Only versions that are three numbers (after a `^` or `~`) are
 *  compared; a link, a tag or a range is not judged. */
function olderPins(
  current: RepoFiles[string] | undefined,
  template: string | undefined,
): { name: string; yours: string; template: string }[] {
  const numbers = (version: string) =>
    /^[\^~]?(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  try {
    const theirs = Manifest.parse(JSON.parse(String(template))).dependencies;
    const ours = Manifest.parse(JSON.parse(String(current))).dependencies;
    return Object.keys(theirs)
      .filter((name) => Object.hasOwn(ours, name))
      .map((name) => ({ name, yours: ours[name]!, template: theirs[name]! }))
      .filter(({ yours, template: newer }) => {
        const [mine, platforms] = [numbers(yours), numbers(newer)];
        if (!mine || !platforms) return false;
        const differs = mine.findIndex((part, index) => part !== platforms[index]);
        return differs !== -1 && mine[differs]! < platforms[differs]!;
      });
  } catch {
    return [];
  }
}

/** The packages that a module imports by name: `from "yjs"`, `import "x/y"`, `import("@a/b/c")`
 *  are `yjs`, `x` and `@a/b`. Read as `importsOf` reads relative imports. */
export function packagesOf(path: string, content: string): string[] {
  if (!/\.(?:ts|tsx|js|jsx|mjs)$/.test(path)) return [];
  const names = new Set<string>();
  for (const line of content.split("\n")) {
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
    for (const [, , specifier] of line.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^."'/][^"']*)\1/g,
    )) {
      const [first, second] = specifier!.split("/");
      names.add(first!.startsWith("@") && second ? `${first}/${second}` : first!);
    }
  }
  return [...names];
}

/** The repo paths that a module's relative imports name: `from "./x.ts"`, `import "./x.css"`,
 *  `import("./x.ts")`, each resolved against the module's own folder. An import that ends in `/`
 *  names a folder (the loader hands over every file under it). Read from the text of a code file,
 *  line by line: an import in a comment is none, and a file that is not code imports nothing. */
export function importsOf(path: string, content: string): string[] {
  if (!/\.(?:ts|tsx|js|jsx|mjs)$/.test(path)) return [];
  const targets = new Set<string>();
  for (const line of content.split("\n")) {
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
    for (const [, , specifier] of line.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']*)\1/g,
    ))
      targets.add(new URL(specifier!, `file:///${path}`).pathname.slice(1));
  }
  return [...targets];
}
