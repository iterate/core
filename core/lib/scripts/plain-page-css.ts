// `node core/lib/scripts/plain-page-css.ts` — writes src/theme/plain-page-css.gen.ts: tokens.css
// and plain-page.css as one stylesheet, the `<style>` a plain page inlines (src/standalone-page.ts),
// and the CSP source that allows exactly that text. A Worker has no file system and the CLI's page
// none of the repository, so the text is a module. Run it after editing either stylesheet;
// src/standalone-page.test.ts fails until then.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const theme = new URL("../src/theme/", import.meta.url);

/** Where the module goes. */
export const plainPageCssModulePath = new URL("plain-page-css.gen.ts", theme);

/** The module's text: the two stylesheets with their comments and indentation dropped (they are
 *  the repository's notes, not the page's), and the SHA-256 of that text for `style-src`
 *  (https://www.w3.org/TR/CSP3/#grammardef-hash-source). */
export function plainPageCssModule() {
  const css = ["tokens.css", "plain-page.css"]
    .map((file) => readFileSync(new URL(file, theme), "utf8"))
    .join("\n")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  const hash = createHash("sha256").update(css).digest("base64");
  const literal = css.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  return `// Written by \`node core/lib/scripts/plain-page-css.ts\` from tokens.css and plain-page.css.
// Edit those, then run it.

/** tokens.css and plain-page.css: the text of a plain page's one \`<style>\`. */
export const plainPageCss = \`${literal}\`;

/** The CSP source that allows that \`<style>\` and no other: its SHA-256. */
// allow-high-entropy-next-line: a hash of the public stylesheet above, not a secret
export const plainPageCssHash = "'sha256-${hash}'";
`;
}

if (import.meta.main) writeFileSync(plainPageCssModulePath, plainPageCssModule());
