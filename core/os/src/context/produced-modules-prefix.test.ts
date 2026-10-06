// produced-modules-prefix.test.ts — pins the code versioned by the `produced-modules-N/` prefix of
// the producer cache in ITX_KV (worker-loader.ts `prepareConfinedWorker` says why). What a producer
// answers is decided by the code its expression reaches. The published config's producer reads the
// config repo through the repo facet, and so does any other producer that reads a repo: the facet
// turns git objects into a commit's files with its git codec, which inflates them with pako. Every
// other producer answers its caller's own data or code, under its caller's cacheKey. The pin hashes
// those two files, without comments and blank lines, plus pako's version; a change fails here until
// the prefix is decided. What the loader keeps of an answer is worker-loader.ts's own code, which
// loaded-code-format.test.ts pins.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const PINNED = {
  prefix: "produced-modules-2",
  // allow-high-entropy-next-line: a SHA-256 of this repo's own source, not a secret
  code: "c527427aea0f47504766edf199cf46a7859ae71dc41a1859e7ffde360490ba92",
};

test("the code that decides what a producer answers changes only with the produced-modules prefix", () => {
  const code = createHash("sha256")
    .update(
      JSON.stringify([
        codeOf(read("../repo/durable-object.ts")),
        codeOf(read("../repo/git-wire.ts")),
        versionOf("pako"),
      ]),
    )
    .digest("hex");
  const prefix = /`(produced-modules-\d+)\//.exec(read("./worker-loader.ts"))?.[1];
  expect(
    { prefix, code },
    "repo/durable-object.ts, repo/git-wire.ts or pako changed: bump produced-modules-N in worker-loader.ts if the change can alter what a repo answers for a commit (its files, their text), then update PINNED",
  ).toEqual(PINNED);
});

function read(file: string) {
  return readFileSync(path.resolve(import.meta.dirname, file), "utf8");
}

/** A file's code without its comment and blank lines: editing a comment needs no new prefix. */
function codeOf(text: string) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*\*|$)/.test(line))
    .join("\n");
}

/** The installed version of a library (it does not export its package.json). */
function versionOf(name: string) {
  const manifest = readFileSync(
    path.resolve(import.meta.dirname, `../../node_modules/${name}/package.json`),
    "utf8",
  );
  return String(JSON.parse(manifest).version);
}
