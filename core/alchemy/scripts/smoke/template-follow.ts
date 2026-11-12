// WHAT A TEMPLATE UPDATE LEFT BEHIND, read off the mind's config repo itself. The smoke runs from
// the checkout that was deployed, so it lays the repo's files beside that checkout's template
// (core/configs/default) and names each app that is not the template's. The mind's own fact
// (`mind/template-applied`) only says why, and a fact can be an older deploy's. So THE FACT IS
// TRUSTED NOWHERE WITHOUT THE REPO AGREEING: an owner's file explains only while it still differs,
// a missing package only while the repo's package.json still lacks it, and a file held back for
// another file only while that other file still differs. What the fact alone says (how many lines
// a file lacks) is counted from the two texts instead.

/** A file's text in the template and in the mind's repo (undefined: the repo has no such file). */
export type Compared = { path: string; template: string; repo: string | undefined };

/** What the smoke reads of the newest `mind/template-applied`. `imports` and `importedBy` are the
 *  files held back that an app's files import or are imported by: the mind left that app old for
 *  them, with no file of the owner's in it. */
export type TemplateFact = {
  appsLeftOld: {
    app: string;
    yours: string[];
    lacksPackages: string[];
    imports?: string[];
    importedBy?: string[];
    notWritten?: string[];
  }[];
  leftAlone: { path: string; lacks: string[] }[];
  heldBack?: { path: string; imports: string[]; importedBy?: string[] }[];
};

/** Why the mind held a file or an app back for another file's sake, in words; "" when it did not,
 *  or when none of those other files still differs (`behind`): the fact is then an older one's. */
function heldFor(
  held: { imports?: string[]; importedBy?: string[] } | undefined,
  behind: ReadonlySet<string>,
): string {
  const imports = held?.imports?.filter((path) => behind.has(path)) || [];
  const importedBy = held?.importedBy?.filter((path) => behind.has(path)) || [];
  return [
    imports.length && `imports ${imports.join(", ")}, which was not written`,
    importedBy.length &&
      `is imported by ${importedBy.join(", ")}, which stays at its older version`,
  ]
    .filter(Boolean)
    .join(" and ");
}

/** The app a repo path is a file of: `apps/<name>/…`, else none (""). */
const appOf = (path: string) => /^apps\/([^/]+)\//.exec(path)?.[1] || "";

/**
 * What the check says. `settled` is false while an app differs from the template and nothing
 * says why: the mind compares its repo at its root's first wake after a deploy, so the check asks
 * again until this is settled or its time is over.
 */
export function templateFollowed(
  files: readonly Compared[],
  fact: TemplateFact | undefined,
  /** The names in the dependencies of the repo's own package.json, when it could be read. */
  repoPackages?: ReadonlySet<string>,
) {
  const behind = files.filter((file) => file.repo !== file.template);
  const stillBehind = new Set(behind.map((file) => file.path));
  const yours = new Set([
    ...(fact?.leftAlone.map((file) => file.path) || []),
    ...(fact?.appsLeftOld.flatMap((app) => app.yours) || []),
  ]);
  const apps = [...new Set(behind.map((file) => appOf(file.path)).filter(Boolean))].map((app) => {
    const paths = behind.filter((file) => appOf(file.path) === app).map((file) => file.path);
    const named = fact?.appsLeftOld.find((one) => one.app === app);
    const owners = paths.filter((path) => yours.has(path));
    // the fact explains the app only through what still holds: a file of the owner's that still
    // differs, a package still named, or a file it was held back for that is still not written
    const notWritten = paths.filter((path) => !yours.has(path));
    const forAnother =
      named?.notWritten?.some((path) => paths.includes(path)) && heldFor(named, stillBehind)
        ? `its newer files ${heldFor(named, stillBehind)
            .replace(/^imports /, "import ")
            .replace(/^is imported by /, "are imported by ")}`
        : "";
    // a package counts only while the repo's own package.json still lacks it
    const lacks =
      (repoPackages && named?.lacksPackages.filter((name) => !repoPackages.has(name))) || [];
    const reasons = [
      owners.length && `the owner's: ${owners.join(", ")}`,
      lacks.length && `package.json lacks ${lacks.join(", ")}`,
      forAnother,
    ].filter(Boolean);
    const why =
      named && reasons.length > 0
        ? `left at the version it has (${reasons.join("; ")})${notWritten.length && !forAnother ? `; not written: ${notWritten.join(", ")}` : ""}`
        : owners.length === paths.length
          ? `the template's but for the owner's ${owners.join(", ")}`
          : "";
    return { app, paths, why };
  });
  const unexplained = apps.filter((app) => !app.why);
  // A file outside the apps that differs. It is the owner's only when the fact says so: a mind
  // with a worker.ts of its own gets no new line of the template's worker (an app's `open` before
  // the guard, a new app's mount). Held back, the mind kept it for a file that was not written.
  // With neither, the mind has not compared yet: right after a deploy the repo still holds the
  // platform's older file.
  const others = behind
    .filter((file) => !appOf(file.path) && file.repo)
    .map(({ path, template, repo }) => {
      const left = fact?.leftAlone.some((one) => one.path === path);
      const held = heldFor(
        fact?.heldBack?.find((one) => one.path === path),
        stillBehind,
      );
      // counted from the two texts, as the mind counts them: the fact's own count may be older
      const theirs = new Set((repo || "").split("\n").map((line) => line.trim()));
      const lacks = template.split("\n").filter((line) => line.trim() && !theirs.has(line.trim()));
      return {
        path,
        owners: left
          ? `${path}${lacks.length ? ` (lacks ${lacks.length} of the template's lines; the mind's fact lists them)` : ""}`
          : "",
        held: !left && held ? `${path}: held back (it ${held})` : "",
      };
    });
  const lacking = others.filter((file) => file.owners).map((file) => file.owners);
  const waiting = others.filter((file) => !file.owners && !file.held);
  const said = [
    apps.length === 0 && "every app is the template's",
    ...apps.filter((app) => app.why).map((app) => `apps/${app.app}: ${app.why}`),
    ...unexplained.map(
      (app) =>
        `apps/${app.app} differs from this checkout's template in ${app.paths.join(", ")} and the mind's newest template fact does not say why: not compared yet, or another version is deployed`,
    ),
    ...others.filter((file) => file.held).map((file) => file.held),
    ...waiting.map(
      (file) =>
        `${file.path} differs from this checkout's template and the mind's newest template fact does not say why: not compared yet, or another version is deployed`,
    ),
    lacking.length > 0 && `the owner's own, not the template's: ${lacking.join(", ")}`,
    apps.some((app) => app.why.startsWith("left")) &&
      "to follow again: commit the template's file over each of the owner's",
  ].filter(Boolean);
  return { settled: unexplained.length === 0 && waiting.length === 0, detail: said.join(". ") };
}
