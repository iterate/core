// alchemy/engine.test.ts — A RELEASE STAGED (engine.ts `stageRelease`) over node's file system.
// Each attempt stages into the same directory (../src/deployment/run.ts), since Alchemy's state
// keeps a D1's `migrations` path and another path plans an update; so what a dead attempt left
// there must go first. stack.test.ts compiles the stack over the rest of engine.ts; a run in
// workerd is the live proofs' (deployments.e2e.test.ts loads the engine, but its run is refused).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempDisposableSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { type ZipFile, zipFiles } from "alchemy/Util/zip";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { stageRelease } from "./engine.ts";

/** A file in a directory, and one at the top. */
const release = [
  { path: "bundle/index.js", content: "export default {};" },
  { path: "VERSION", content: "0.1.0" },
];

test.for([
  {
    name: "a release replaces what a dead attempt left in its directory, which its scope removes",
    release,
    expected: {
      files: 2,
      bytes: 23,
      landed: ["VERSION", "bundle", "bundle/index.js"],
      kept: false,
    },
  },
  {
    name: "a directory entry, which `zip -r` and a Finder zip write, is no file and refuses nothing",
    release: [{ path: "bundle/", content: "" }, ...release],
    expected: {
      files: 2,
      bytes: 23,
      landed: ["VERSION", "bundle", "bundle/index.js"],
      kept: false,
    },
  },
  {
    name: "refuses a release whose SHA-256 is not the one asked",
    release,
    sha256: "0".repeat(64),
    expected: {
      refused: expect.stringMatching(/^the release's SHA-256 is [0-9a-f]{64}, not 0{64}$/),
    },
  },
  {
    name: 'refuses a release with an entry whose ".." climbs out of its directory',
    release: [...release, { path: "bundle/../../escape.js", content: "x" }],
    expected: { refused: 'the release holds "bundle/../../escape.js", outside its directory' },
  },
  {
    name: "refuses a release with an absolute entry",
    release: [...release, { path: "/etc/escape", content: "x" }],
    expected: { refused: 'the release holds "/etc/escape", outside its directory' },
  },
])("$name", async ({ release, sha256, expected }) => {
  // exact: the directory holds the release and nothing else
  expect(await stage(release, sha256)).toEqual(expected);
});

/** `release`, zipped as Alchemy zips, staged under one scope into a directory that a dead attempt
 *  left a file in, with its own SHA-256 unless `sha256` names another. Answers what it counted,
 *  the paths in the directory inside the scope, and whether the directory outlived the scope; or
 *  why the release was refused. */
async function stage(release: ZipFile[], sha256?: string) {
  using scratch = mkdtempDisposableSync(path.join(tmpdir(), "engine-test-"));
  const directory = path.join(scratch.path, "release", "acme-os");
  mkdirSync(path.join(directory, "bundle"), { recursive: true });
  writeFileSync(path.join(directory, "bundle/stale.js"), "from an attempt that died");
  return await Effect.runPromise(
    Effect.gen(function* () {
      const archive = yield* zipFiles(release);
      const asked = sha256 || createHash("sha256").update(archive).digest("hex");
      const { files, bytes } = yield* stageRelease(archive, asked, directory);
      return { files, bytes, landed: readdirSync(directory, { recursive: true }).toSorted() };
    }).pipe(
      Effect.scoped,
      Effect.map((staged) => ({ ...staged, kept: existsSync(directory) })),
      Effect.catchTag("ReleaseRefused", ({ message }) => Effect.succeed({ refused: message })),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}
