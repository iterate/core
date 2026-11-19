import { expect, test } from "vitest";
import { markdownHtml } from "./markdown.ts";

test("a description's paragraphs, bold, italic, code and https links become HTML", () => {
  expect(
    markdownHtml(
      "Make a key at [the dashboard](https://platform.example.com/keys?a=1&b=2).\nIt starts with `sk-`.\n\n**Never** share it, *never*.",
    ),
  ).toBe(
    '<p>Make a key at <a href="https://platform.example.com/keys?a=1&#38;b=2" target="_blank" rel="noopener noreferrer">the dashboard</a> <span class="muted">(platform.example.com)</span>.<br>It starts with <code>sk-</code>.</p><p><strong>Never</strong> share it, <em>never</em>.</p>',
  );
});

test("no HTML an agent writes reaches the page, and a link that is not https stays text", () => {
  const html = markdownHtml(
    [
      '<script>alert(1)</script><img src=x onerror="alert(1)">',
      "[click](javascript:alert(1)) [data](data:text/html,<b>x</b>) [plain](http://example.com)",
      '[quote](https://example.com/"onmouseover="alert(1)) `<b>code</b>` **<i>bold</i>**',
    ].join("\n\n"),
  );
  expect(html).not.toMatch(/<(script|img|i|b)[\s>]/);
  expect(html).not.toMatch(/href="(javascript|data|http):/);
  expect(html).not.toContain('"onmouseover');
  expect(html).toContain("&#60;script&#62;alert(1)&#60;/script&#62;");
  expect(html).toContain("[click](javascript:alert(1))");
  expect(html).toContain("<code>&#60;b&#62;code&#60;/b&#62;</code>");
  expect(html).toContain("<strong>&#60;i&#62;bold&#60;/i&#62;</strong>");
});

test("a link says the host it goes to unless its words are that address, so an agent's words cannot pass for another site", () => {
  const hostOf = (markdown: string) =>
    /<span class="muted">\(([^)]*)\)<\/span>/.exec(markdownHtml(markdown))?.[1];
  // words that are the address, or its host and a path: nothing to add
  expect(hostOf("[platform.openai.com](https://platform.openai.com)")).toBeUndefined();
  expect(
    hostOf("[platform.openai.com/api-keys](https://platform.openai.com/api-keys)"),
  ).toBeUndefined();
  expect(
    hostOf("[https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)"),
  ).toBeUndefined();
  // words that name another site, or start with the host and go on past it: the real host
  expect(hostOf("[platform.openai.com](https://openai.evil.example/login)")).toBe(
    "openai.evil.example",
  );
  expect(hostOf("[ev.il.openai.com/keys](https://ev.il/keys)")).toBe("ev.il");
  expect(hostOf("[ev.il/ → platform.openai.com/api-keys](https://ev.il/x)")).toBe("ev.il");
  expect(hostOf("[platform.openai.com/api-keys](https://platform.openai.com/login)")).toBe(
    "platform.openai.com",
  );
  expect(hostOf("[the keys page](https://platform.openai.com/api-keys)")).toBe(
    "platform.openai.com",
  );
  // a lookalike name (a Cyrillic "o") is shown as the parser reads it
  expect(hostOf("[openai.com](https://\u043epenai.com/)")).toBe("xn--penai-iye.com");
});

test("nothing in a description makes an image", () => {
  const html = markdownHtml(
    "![logo](https://cdn.example.com/x.png) <img src=https://cdn.example.com/x.png>",
  );
  expect(html).not.toContain("<img");
  expect(html).toContain('<span class="muted">(cdn.example.com)</span>');
});

test("a description's direction controls are dropped, so words cannot read as an address they are not", () => {
  const html = markdownHtml(
    "[\u202Emoc.ianepo//:sptth](https://evil.example) \u2066x\u2069 \u200Fy",
  );
  expect(html).not.toMatch(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
  expect(html).toContain('<span class="muted">(evil.example)</span>');
});

test("an underscore is a letter of a name, not italics", () => {
  expect(markdownHtml("Set OPENAI_API_KEY and _not_ this")).toBe(
    "<p>Set OPENAI_API_KEY and _not_ this</p>",
  );
});

test("a link with a user name or a password before its host is no link: its words stay as written", () => {
  for (const markdown of [
    "[platform.openai.com:443@evil.com](https://platform.openai.com:443@evil.com)",
    "[the keys page](https://user@evil.com/keys)",
    "[openai.com](https://user:pass@evil.com)",
  ]) {
    const html = markdownHtml(markdown);
    expect(html).not.toContain("<a ");
    expect(html).toBe(`<p>${markdown}</p>`);
  }
  // words with a user name before a host are not the address of a link to that host
  expect(markdownHtml("[openai.com@evil.com](https://evil.com)")).toContain(
    '<span class="muted">(evil.com)</span>',
  );
});
