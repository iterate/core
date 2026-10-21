// standalone-page.test.ts — the plain pages' stylesheet module is what its script writes from the
// token files today, and the title is text. What a page does with it is app-server.test.ts's.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { plainPageCssModule, plainPageCssModulePath } from "../scripts/plain-page-css.ts";
import { standalonePage } from "./standalone-page.ts";

test("theme/plain-page-css.gen.ts is up to date with tokens.css and plain-page.css", () => {
  expect(
    readFileSync(plainPageCssModulePath, "utf8"),
    "stale: run `node core/lib/scripts/plain-page-css.ts`",
  ).toBe(plainPageCssModule());
});

test("the title is text: markup in it is escaped", () => {
  expect(standalonePage({ title: `Backup · <b>"a&b"</b>`, head: "", body: "" })).toContain(
    "<title>Backup · &#60;b&#62;&#34;a&#38;b&#34;&#60;/b&#62;</title>",
  );
});
