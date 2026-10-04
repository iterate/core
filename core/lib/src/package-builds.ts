// package-builds.ts — this repository's package builds as a config repo's package.json lists them, and
// how everything that writes one pins it. Main's builds are on npm, as versions that name their
// commit under the `main` dist-tag (scripts/ci/npm-publish.ts); a pull request's are on pkg.pr.new
// (`https://pkg.pr.new/<owner>/<repo>/<package>@<ref>`). A template lists
// `main` (npm's dist-tag) or a pkg.pr.new branch, which move, so a writer resolves one once, as it
// writes, the way npm's lockfile holds a git dependency at its commit
// (https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json#packages); the loader refuses a
// pkg.pr.new ref that moves (core/os/src/context/module-resolution.ts says why). The writers: the
// platform's seed of a config repo from a template (core/os/src/project/processor.ts), Docs' Install
// Docs, the apps that upgrade voice to main's newest build (`buildStanding`), and the e2e rows.
import { z } from "zod";
import { fetchRetryingPlatformFailures, UPSTREAM_ONCE } from "./platform-retry.ts";

/** A pkg.pr.new build as its URL names it, in parts, or undefined for any other version and for a
 *  pkg.pr.new URL of another shape. A package.json may list it under another name: an alias, as npm
 *  installs a tarball URL under the name it is listed by. */
export function pkgPrNewBuildOf(version: string) {
  if (!version.startsWith("https://pkg.pr.new/")) return undefined;
  const [owner, repo, ...rest] = new URL(version).pathname.slice(1).split("/");
  const listed = rest.join("/");
  // the `@` before the ref, after a scope's own
  const at = listed.indexOf("@", 1);
  if (!owner || !repo || at < 0 || at === listed.length - 1) return undefined;
  return { owner, repo, name: listed.slice(0, at), ref: listed.slice(at + 1) };
}

/** A pkg.pr.new version of package `name`, in parts, or undefined for any other version: an npm
 *  range, an exact version or a dist-tag, and a pkg.pr.new URL of another shape or package. */
export function pkgPrNewVersionOf(name: string, version: string) {
  const build = pkgPrNewBuildOf(version);
  return build?.name === name ? build : undefined;
}

/** Whether a pkg.pr.new ref names one build: all 40 hex digits of a commit. A branch or a PR number
 *  names whatever was published for it last. A short sha is refused too: it reads like a branch
 *  name, and pkg.pr.new's `x-commit-key` echoes it rather than naming the commit. */
export const isPkgPrNewCommit = (ref: string) => /^[0-9a-f]{40}$/.test(ref);

/** The repository whose pkg.pr.new workflow (.github/workflows/pkg-pr-new.yml) publishes this
 *  repository's packages, as pkg.pr.new's URLs name it. */
export const pkgPrNewRepository = "iterate/private";

/** A build of one of this repository's packages (`iterate`, `@iterate-com/voice`, …): the
 *  pkg.pr.new workflow publishes every package together, for every main commit and for the head of
 *  a PR that changes one. */
export const pkgPrNewVersion = (name: string, ref: string) =>
  `https://pkg.pr.new/${pkgPrNewRepository}/${name}@${ref}`;

/** The npm dist-tag main's CI publishes this repository's packages under: as a version, main's
 *  newest build, which a writer pins (`pinVersion`). */
export const NPM_MAIN = "main";

/** One of main's npm builds (`<version>-main.<committer date>-<commit>`, such as
 *  `0.1.0-main.20261002T164000Z-3202ce3`; scripts/ci/npm-publish.ts), in parts, or undefined for
 *  any other version. `commit` is the first seven digits of its sha. The first versions published
 *  hold all forty, and milliseconds in their date: compare commits with `sameCommit`. */
export function npmMainBuildOf(version: string) {
  const match =
    /^\d+\.\d+\.\d+-main\.(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(?:\d{3})?Z-([0-9a-f]{7}|[0-9a-f]{40})$/.exec(
      version,
    );
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  return {
    commit: match[7]!,
    committedAt: Date.UTC(year!, month! - 1, day!, hour!, minute!, second!),
  };
}

/** Whether two commits are one, each named by its whole sha (a pkg.pr.new URL's) or by its first
 *  seven digits (an npm version's). */
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** The version of this repository's package `name` that a deployment's writers write for `ref`, its
 *  packages' build: production's is `main`, main's newest on npm (`NPM_MAIN`); a preview's is a
 *  commit, whose build only pkg.pr.new has. */
export const buildVersion = (name: string, ref: string) =>
  ref === NPM_MAIN ? NPM_MAIN : pkgPrNewVersion(name, ref);

/** `version` of package `name` as a writer writes it: `main` of one of this repository's packages
 *  at the npm version the dist-tag names now (`npmMainVersion`), a pkg.pr.new branch or PR at its
 *  commit (`pinPkgPrNewVersion`), and any other version as it is. One it cannot pin throws. */
export async function pinVersion(
  name: string,
  version: string,
  fetchFn: typeof fetch = globalThis.fetch,
) {
  if (version === NPM_MAIN && isOurs(name)) return (await npmMainVersion(name, fetchFn)).version;
  return pinPkgPrNewVersion(name, version, fetchFn);
}

/** Whether `name` is one of the packages main publishes to npm. */
const isOurs = (name: string) => name === "iterate" || name.startsWith("@iterate-com/");

/**
 * `version` of package `name` as a writer writes it: a pkg.pr.new branch or PR at the commit
 * pkg.pr.new serves for it now, and any other version as it is. The commit is the HEAD's
 * `x-commit-key` (`<owner>:<repo>:<commit>`), trusted only as 40 hex digits: a 404 echoes there the
 * ref it was asked for. The HEAD is sent once more a second later when pkg.pr.new fails it
 * (UPSTREAM_ONCE), each attempt within 10 s. A ref it cannot pin throws, so nothing is written with
 * a ref that moves.
 */
export async function pinPkgPrNewVersion(
  name: string,
  version: string,
  fetchFn: typeof fetch = globalThis.fetch,
) {
  const parts = pkgPrNewVersionOf(name, version);
  if (!parts || isPkgPrNewCommit(parts.ref)) return version;
  const served = await servedBuild(version, fetchFn);
  if (!served.commit)
    throw new Error(
      `${version} answered ${served.status} without naming the commit it serves, so it cannot be pinned`,
    );
  return `https://pkg.pr.new/${parts.owner}/${parts.repo}/${name}@${served.commit}`;
}

/** Where a project's installed build of one of this repository's packages stands against the newest
 *  build main has published on npm, by commit (`buildStanding`). Each commit is as its version
 *  names it: seven digits from an npm version, the whole sha from a pkg.pr.new URL. */
export type BuildStanding =
  /** `installed`, the version as its package.json pins it, is not this repository's build at a
   *  commit (another npm version, a fork's build, a build of the iterate/iterate archive): the
   *  project's own, which it upgrades itself */
  | { kind: "own"; installed: string }
  /** the installed build is main's newest */
  | { kind: "newest"; installed: string }
  /** main's newest is of a later commit than `installed`, or pkg.pr.new no longer serves
   *  `installed`: an upgrade, to `version` (`newest`'s npm version) */
  | { kind: "behind"; installed: string; newest: string; version: string }
  /** `installed` is pkg.pr.new's build of a pull request, published after main's newest commit */
  | { kind: "ahead"; installed: string; newest: string };

/**
 * WHETHER MAIN HAS A NEWER BUILD of package `name` than `installed`, the version a project's source
 * pins: main's newest is the npm version its `main` dist-tag names now (`npmMainVersion`). An npm
 * build of main is behind when its commit is older, by the committer date its version holds. A
 * pkg.pr.new build at a commit (a pull request's, or main's from before npm) is ahead when
 * pkg.pr.new published it after main's newest commit (`last-modified`), and behind otherwise, or
 * once pkg.pr.new no longer serves it. The two requests go at once, each bounded as
 * `pinPkgPrNewVersion` says. An answer without what it needs throws, so a standing is never guessed.
 * An app's Worker asks (a server function), as Docs' install does.
 */
export async function buildStanding(
  name: string,
  installed: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<BuildStanding> {
  const npmBuild = npmMainBuildOf(installed);
  const pkgPrNewCommit = pkgPrNewVersionOf(name, installed)?.ref || "";
  const pkgPrNew =
    isPkgPrNewCommit(pkgPrNewCommit) && installed === pkgPrNewVersion(name, pkgPrNewCommit);
  if (!npmBuild && !pkgPrNew) return { kind: "own", installed };
  const [newest, served] = await Promise.all([
    npmMainVersion(name, fetchFn),
    npmBuild ? undefined : servedBuild(installed, fetchFn),
  ]);
  const commit = npmBuild?.commit || pkgPrNewCommit;
  if (sameCommit(newest.commit, commit)) return { kind: "newest", installed: commit };
  // a build pkg.pr.new answers 404 for is older than every one it serves
  if (served && served.status !== 404 && !served.publishedAt)
    throw new Error(`${installed} answered ${served.status} without saying when it was published`);
  const installedAt = npmBuild?.committedAt || served?.publishedAt;
  if (installedAt && installedAt > newest.committedAt)
    return { kind: "ahead", installed: commit, newest: newest.commit };
  return { kind: "behind", installed: commit, newest: newest.commit, version: newest.version };
}

/**
 * A source's files with every package.json's `dependencies` pinned (`pinVersion`), one request per
 * distinct version: what the platform commits when it seeds a config repo from a template, whose
 * `main` (or pkg.pr.new `…@main`) means main's newest build. A manifest with nothing to
 * pin keeps its bytes; one that changes is written back as JSON with two-space indents, its keys in
 * their order. `devDependencies` stay as written: the loader never reads them, and the tooling that
 * does (`npm install` for `tsc`) locks them itself, so a template's types can follow main.
 */
export async function pinDependencies(
  files: { path: string; content: string }[],
  fetchFn: typeof fetch = globalThis.fetch,
) {
  const pins = new Map<string, Promise<string>>();
  const pin = (name: string, version: string) => {
    const key = `${name} ${version}`;
    if (!pins.has(key)) pins.set(key, pinVersion(name, version, fetchFn));
    return pins.get(key)!;
  };
  return Promise.all(
    files.map(async (file) => {
      if (file.path !== "package.json" && !file.path.endsWith("/package.json")) return file;
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.content);
      } catch {
        // a broken manifest is the loader's to refuse, by name, once the seed is committed
        return file;
      }
      const manifest = z.record(z.string(), z.unknown()).safeParse(parsed);
      const dependencies = z.record(z.string(), z.string()).safeParse(manifest.data?.dependencies);
      if (!manifest.success || !dependencies.success) return file;
      const pinned = Object.fromEntries(
        await Promise.all(
          Object.entries(dependencies.data).map(async ([name, version]) => [
            name,
            await pin(name, version),
          ]),
        ),
      );
      if (Object.entries(pinned).every(([name, version]) => dependencies.data[name] === version))
        return file;
      const content = `${JSON.stringify({ ...manifest.data, dependencies: pinned }, null, 2)}\n`;
      return { ...file, content };
    }),
  );
}

/** What pkg.pr.new serves at `version`, from one HEAD (`headPkgPrNew`): the answer's status, the
 *  commit it names in `x-commit-key` (`<owner>:<repo>:<commit>`, trusted only as 40 hex digits of a
 *  200: a 404 echoes there the ref it was asked for), and when that build was published
 *  (`last-modified`, epoch milliseconds). */
async function servedBuild(version: string, fetchFn: typeof fetch) {
  const answer = await headPkgPrNew(version, fetchFn);
  const key = answer.headers.get("x-commit-key")?.split(":").at(-1) ?? "";
  const publishedAt = Date.parse(answer.headers.get("last-modified") ?? "");
  return {
    status: answer.status,
    commit: answer.ok && isPkgPrNewCommit(key) ? key : undefined,
    publishedAt: answer.ok && Number.isFinite(publishedAt) ? publishedAt : undefined,
  };
}

/** The version npm's `main` dist-tag names for package `name` now, in parts (`npmMainBuildOf`),
 *  from the registry's dist-tags (`GET /-/package/<name>/dist-tags`, a few bytes where the whole
 *  packument lists every version), bounded as `pinPkgPrNewVersion` says. A package with no main
 *  build throws: npm answers 401 for a scoped package it doesn't have. */
async function npmMainVersion(name: string, fetchFn: typeof fetch) {
  const url = `https://registry.npmjs.org/-/package/${name}/dist-tags`;
  const answer = await fetchRetryingPlatformFailures(
    `GET ${url}`,
    (signal) => fetchFn(url, { signal }),
    { area: "npm", idempotent: true, schedule: UPSTREAM_ONCE, timeoutMs: 10_000 },
  );
  const version = answer.ok
    ? z.object({ [NPM_MAIN]: z.string() }).safeParse(await answer.json()).data?.[NPM_MAIN]
    : undefined;
  const build = version ? npmMainBuildOf(version) : undefined;
  if (!version || !build)
    throw new Error(
      `npm has no main build of ${name}: ${url} answered ${answer.status}${version ? ` naming ${version}` : ""}`,
    );
  return { version, ...build };
}

/** One HEAD of a pkg.pr.new version, bounded as `pinPkgPrNewVersion` says; a 404 is an answer. */
function headPkgPrNew(version: string, fetchFn: typeof fetch) {
  return fetchRetryingPlatformFailures(
    `HEAD ${version}`,
    (signal) => fetchFn(version, { method: "HEAD", signal }),
    { area: "pkg-pr-new", idempotent: true, schedule: UPSTREAM_ONCE, timeoutMs: 10_000 },
  );
}
