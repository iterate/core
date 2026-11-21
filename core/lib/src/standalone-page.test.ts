// standalone-page.test.ts — the plain pages' stylesheet module is what its script writes from the
// token files today, and the title is text. What a page does with it is app-server.test.ts's.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { plainPageCssModule, plainPageCssModulePath } from "../scripts/plain-page-css.ts";
import { factsTable, standalonePage } from "./standalone-page.ts";

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

test("a facts table escapes each label and help, puts the help behind a ? beside the name it explains, and draws no help for a row without it", () => {
  expect(
    factsTable([
      {
        label: 'Who <b>asks</b> "now"',
        value: "<strong>the laptop</strong>",
        help: "It is <i>its</i> own claim.",
      },
      { label: "Code", value: "<strong>WDJB-MJHT</strong>" },
    ]),
  ).toBe(
    '<dl class="facts">' +
      // the value is the caller's HTML, as it was given
      '<div><dt>Who &#60;b&#62;asks&#60;/b&#62; &#34;now&#34; <details class="help"><summary aria-label="About Who &#60;b&#62;asks&#60;/b&#62; &#34;now&#34;">?</summary><p>It is &#60;i&#62;its&#60;/i&#62; own claim.</p></details></dt><dd><strong>the laptop</strong></dd></div>' +
      "<div><dt>Code</dt><dd><strong>WDJB-MJHT</strong></dd></div>" +
      "</dl>",
  );
});
