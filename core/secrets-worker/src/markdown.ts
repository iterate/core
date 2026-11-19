// markdown.ts — THE MARKDOWN OF A SECRET'S DESCRIPTION, as its collection page shows it: paragraphs,
// line breaks, **bold**, *italic*, `code` and [links](https://…). No `_` italics: a name like
// OPENAI_API_KEY stays as written. Every piece of text is escaped, so no HTML that an agent wrote
// ever reaches the page: what is not one of these marks is text, and nothing makes an image. A
// link is `https:` alone, with no user name or password (else it stays text), opens in a new tab
// with no opener and no referrer, and says its host when its words are not its address (`link`).
// Direction controls are dropped first (`BIDI_CONTROLS`).
import { escaped } from "./callback-page.ts";

const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\((https:\/\/[^\s()]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;

function inline(text: string): string {
  let html = "";
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    html += escaped(text.slice(at, match.index));
    at = match.index + match[0].length;
    const [, code, label, href, bold, italic] = match;
    // each mark's text is one character or more, so an empty one is a mark that did not match
    if (code) html += `<code>${escaped(code)}</code>`;
    else if (label && href) html += link(label, href);
    else if (bold) html += `<strong>${escaped(bold)}</strong>`;
    else html += `<em>${escaped(italic || "")}</em>`;
  }
  return html + escaped(text.slice(at));
}

/** A link whose words are not its own address says the host it goes to, after its words: an
 *  agent's words are no proof of where a link leads, on a page where a person types a secret. The
 *  host is as the URL parser gives it, so a lookalike name shows as its `xn--` form. */
function link(label: string, href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return escaped(`[${label}](${href})`);
  }
  // a user name or a password before the host reads as the host: `https://good.com@evil.com`
  if (url.username || url.password) return escaped(`[${label}](${href})`);
  const own = sameAddress(label, url);
  return `<a href="${escaped(url.href)}" target="_blank" rel="noopener noreferrer">${escaped(label)}</a>${own ? "" : ` <span class="muted">(${escaped(url.host)})</span>`}`;
}

/** Whether a link's words, read as an address, are the address it goes to: then they say its
 *  host already. Words that start with a host and go on are not. */
function sameAddress(label: string, url: URL): boolean {
  try {
    const read = new URL(/^https:\/\//i.test(label) ? label : `https://${label}`);
    return !read.username && !read.password && read.href === url.href;
  } catch {
    return false;
  }
}

/** Characters that turn the direction of the text after them: with one, words can read as an
 *  address they are not, and a link's host note reads reversed. A description has no use for
 *  them. */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export const markdownHtml = (markdown: string): string =>
  markdown
    .replace(BIDI_CONTROLS, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.split("\n").map(inline).join("<br>")}</p>`)
    .join("");
