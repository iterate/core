// loaded-code-format.test.ts — pins the code versioned by LOADED_CODE_FORMAT (worker-loader.ts
// says why). The pin hashes both source-to-modules files, without comments and blank lines, plus the
// versions of their two rewriting libraries; a change fails here until the pin is updated.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const PINNED = {
  format: 1,
  // allow-high-entropy-next-line: a SHA-256 of this repo's own source, not a secret
  code: "fbd9e853f12b74b7f62a962beb3a071a7aeb1ac161d25f4f47896b84bf736de6",
};

test("the code that turns a source into modules changes only with LOADED_CODE_FORMAT", () => {
  const loader = read("./worker-loader.ts");
  const code = createHash("sha256")
    .update(
      JSON.stringify([
        codeOf(loader),
        codeOf(read("./module-resolution.ts")),
        versionOf("sucrase"),
        versionOf("es-module-lexer"),
      ]),
    )
    .digest("hex");
  const format = Number(/const LOADED_CODE_FORMAT = (\d+);/.exec(loader)?.[1]);
  expect(
    { format, code },
    "worker-loader.ts, module-resolution.ts, sucrase or es-module-lexer changed: bump LOADED_CODE_FORMAT if the change can alter what a source produces, then update PINNED",
  ).toEqual(PINNED);
});

function read(file: string) {
  return readFileSync(path.resolve(import.meta.dirname, file), "utf8");
}

/** A file's code without its comment and blank lines: editing a comment needs no new format. */
function codeOf(text: string) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*\*|$)/.test(line))
    .join("\n");
}

/** The installed version of a library (neither exports its package.json). */
function versionOf(name: string) {
  const manifest = readFileSync(
    path.resolve(import.meta.dirname, `../../node_modules/${name}/package.json`),
    "utf8",
  );
  return String(JSON.parse(manifest).version);
}
