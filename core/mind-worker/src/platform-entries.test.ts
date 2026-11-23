// Every `iterate/*` import of a config template's Worker code, and of a repo a new mind starts
// with (core/repos), is a module that loaded workers have: anything else is refused when the mind publishes (src/context/module-resolution.ts).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { PLATFORM_ENTRIES } from "./platform-entries.ts";

test("a config template's and a seed repo's Worker code imports only the platform's own modules of iterate", () => {
  const imports = ["configs", "repos"].flatMap((folder) => {
    const root = path.resolve(import.meta.dirname, "../..", folder);
    return (
      readdirSync(root, { recursive: true, encoding: "utf8" })
        // `public/` is served to browsers, which never load the platform's modules
        .filter(
          (file) => /\.(ts|tsx|js|mjs)$/.test(file) && !/(^|\/)(node_modules|public)\//.test(file),
        )
        .flatMap((file) =>
          [
            ...readFileSync(path.join(root, file), "utf8").matchAll(
              /(?:from\s*|import\s*\(\s*)"(iterate\/[^"]+)"/g,
            ),
          ].map((match) => `${folder}/${file}: ${match[1]}`),
        )
    );
  });
  expect(imports.some((entry) => entry.startsWith("repos/onboarding/worker.ts: "))).toBe(true);

  expect(imports.length).toBeGreaterThan(0);
  expect(
    imports.filter(
      (entry) => !(PLATFORM_ENTRIES as readonly string[]).includes(entry.split(": ")[1]!),
    ),
  ).toEqual([]);
});
