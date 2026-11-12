// A NEWER TEMPLATE REACHES A MIND THAT ALREADY EXISTS. A config repo is seeded once, so new code
// compares it with the template it bundles (processor.ts, once per incarnation) and commits what
// that template adds. The rule is per file, and exact: the platform writes a file the repo lacks,
// and replaces one that is still byte for byte what the platform itself last wrote there. A file
// somebody changed is never written, and a file somebody deleted is not put back: each is named,
// with the template's lines it lacks. Nothing is deleted, so a module an older template had (and
// code made from it) stays.
//
// ONE EXCEPTION, so that the platform's own commit can always publish: a file somebody deleted IS
// put back when one of the platform's own files imports it (`putBack`). Otherwise a newer
// template that gives a file of the platform's an import of a deleted file or folder writes the
// import and leaves its target out, and the config repo no longer loads.
//
// What the platform wrote is its own record, by path (`TemplateKept.written`), and never read off
// a later commit's tree: that tree also holds the files it left alone. A mind older than the
// record starts it from its seed, the one commit whose whole tree is the platform's.

/** A repo's files as its facet answers them (`files()`): text, or base64 for a file that is not. */
export type RepoFiles = Record<string, string | { base64: string }>;

/** What the mind's facet keeps between updates, in its own storage. */
export type TemplateKept = {
  /** The bundled templates the repo was last compared with: one set is compared once. */
  hash: string;
  /** The template the repo follows. */
  template?: string;
  /** The SHA-256 of what the platform last wrote, by path. */
  written?: Record<string, string>;
  /** The platform's last commit of a template. When its publication is refused, that is said as a
   *  fact of its own (`mind/template-not-published`). */
  commit?: string;
};

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
  const changes: { path: string; content: string }[] = [];
  const added: string[] = [];
  const replaced: string[] = [];
  const platforms: string[] = [];
  let leftAlone: { path: string; lacks: string[] }[] = [];
  /** The template's files that the platform wrote and somebody deleted. */
  const deleted = new Set<string>();
  for (const { path, content } of input.template) {
    if (!Object.hasOwn(input.current, path)) {
      // the platform wrote it and it is gone: somebody deleted it
      if (input.written.has(path)) {
        deleted.add(path);
        leftAlone.push({ path, lacks: [] });
      } else {
        added.push(path);
        platforms.push(path);
        changes.push({ path, content });
      }
      continue;
    }
    const now = input.current[path];
    if (now === content) {
      platforms.push(path);
      continue;
    }
    if (input.untouched.has(path)) {
      replaced.push(path);
      platforms.push(path);
      changes.push({ path, content });
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
  // WHAT THE PLATFORM'S OWN FILES IMPORT MUST BE THERE. Each file that holds the template's bytes
  // after this update is read once, a file put back too (it can import another deleted one).
  const contents = new Map(input.template.map((file) => [file.path, file.content]));
  const there = new Set([...Object.keys(input.current), ...changes.map((change) => change.path)]);
  const putBack: { path: string; importedBy: string }[] = [];
  for (let next = 0; next < platforms.length; next += 1) {
    const importer = platforms[next]!;
    for (const target of importsOf(importer, contents.get(importer)!)) {
      // a folder is every file under it: its import fails only when no file is there
      const isFolder = target.endsWith("/");
      if (isFolder ? [...there].some((path) => path.startsWith(target)) : there.has(target))
        continue;
      for (const path of [...deleted].filter((gone) =>
        isFolder ? gone.startsWith(target) : gone === target,
      )) {
        deleted.delete(path);
        there.add(path);
        changes.push({ path, content: contents.get(path)! });
        platforms.push(path);
        putBack.push({ path, importedBy: importer });
      }
    }
  }
  if (putBack.length) {
    const back = new Set(putBack.map((file) => file.path));
    leftAlone = leftAlone.filter((file) => !back.has(file.path));
  }
  return { changes, added, replaced, platforms, leftAlone, putBack };
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
