// WHAT THE PLATFORM'S LOADER DOES FOR A CONFIG REPO'S FILES THAT ARE NOT CODE, for a test in Node.
// A config's own worker mounts its apps, and an app imports its page and a folder of files
// (core/configs/default/files.d.ts says what loaded code gets). Vite reads neither by itself, so
// core/lib's vitest config names this plugin. Loaded code is not changed for it.
//
// THE RULE IS THE LOADER'S: core/mind-worker/src/context/module-resolution.ts (`fileModule`,
// `loadFolder`). This copies it, for a file under a `configs/` folder alone:
//
//   a relative import of a file that is not code (.ts .mts .js .mjs are code) has one default
//   export: the file's text when it is text (valid UTF-8, no NUL byte), else its bytes
//
//   a relative import that ends in `/` has one default export: every file under that folder at
//   any depth, by its path from the folder with `/` between the parts, sorted, each as above.
//   Code under the folder is text too. A folder that is missing or empty is an error.
//
// src/config-default-mirror.test.ts fails when this and the loader part ways on the default
// config's own page and folder.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const FILE = "\0config-file:";
const FOLDER = "\0config-folder:";

/** A file as the loader hands it over, as the source of an expression. */
function valueOf(path: string): string {
  const bytes = readFileSync(path);
  if (!bytes.includes(0)) {
    try {
      return JSON.stringify(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      );
    } catch {
      // not UTF-8: bytes, below
    }
  }
  return `Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}), (c) => c.charCodeAt(0))`;
}

export function configFileImports() {
  return {
    name: "iterate-config-file-imports",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
      if (!importer || !source.startsWith(".")) return null;
      const target = resolve(dirname(importer), source);
      if (!target.includes(`${sep}configs${sep}`)) return null;
      if (source.endsWith("/")) return `${FOLDER}${target}`;
      return /\.(ts|mts|js|mjs)$/.test(source) ? null : `${FILE}${target}`;
    },
    load(id: string) {
      if (id.startsWith(FILE)) return `export default ${valueOf(id.slice(FILE.length))};`;
      if (!id.startsWith(FOLDER)) return null;
      const folder = id.slice(FOLDER.length);
      const files = readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => resolve(entry.parentPath, entry.name))
        .sort();
      if (!files.length)
        throw new Error(`a config imports ${folder}/, and there is no such folder`);
      const entries = files.map(
        (path) =>
          `${JSON.stringify(relative(folder, path).split(sep).join("/"))}: ${valueOf(path)}`,
      );
      return `export default { ${entries.join(", ")} };`;
    },
  };
}
