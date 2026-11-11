// A NEWER TEMPLATE REACHES A PROJECT THAT ALREADY EXISTS. A config repo is seeded once, so new code
// compares it with the template it bundles (processor.ts, once per incarnation) and commits what
// that template adds. The rule is per file, and exact: the platform writes a file the repo lacks,
// and replaces one that is still byte for byte what the platform itself last wrote there. A file
// somebody changed is never written, and a file somebody deleted is not put back: each is named,
// with the template's lines it lacks. Nothing is deleted, so a module an older template had (and
// code made from it) stays.
//
// What the platform wrote is its own record, by path (`TemplateKept.written`), and never read off
// a later commit's tree: that tree also holds the files it left alone. A project older than the
// record starts it from its seed, the one commit whose whole tree is the platform's.

/** A repo's files as its facet answers them (`files()`): text, or base64 for a file that is not. */
export type RepoFiles = Record<string, string | { base64: string }>;

/** What the project's facet keeps between updates, in its own storage. */
export type TemplateKept = {
  /** The bundled templates the repo was last compared with: one set is compared once. */
  hash: string;
  /** The template the repo follows. */
  template?: string;
  /** The SHA-256 of what the platform last wrote, by path. */
  written?: Record<string, string>;
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
 *  what it wrote. `platforms` are the paths that hold the template's own bytes afterwards. */
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
  const leftAlone: { path: string; lacks: string[] }[] = [];
  for (const { path, content } of input.template) {
    if (!Object.hasOwn(input.current, path)) {
      // the platform wrote it and it is gone: somebody deleted it
      if (input.written.has(path)) leftAlone.push({ path, lacks: [] });
      else {
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
  return { changes, added, replaced, platforms, leftAlone };
}
