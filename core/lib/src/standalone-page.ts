// standalone-page.ts — a page served as plain HTML, outside any app's build: the browser-auth
// gate's own pages (app-server.ts), the platform's callback pages (core/os callback-page.ts) and
// the CLI's sign-in page (cli/oauth.ts). Its one stylesheet is inline (theme/plain-page.css over
// theme/tokens.css), so the page loads nothing to look like the issuer's pages, and a CSP allows
// that stylesheet by its hash, `plainPageCssHash`.
import { plainPageCss } from "./theme/plain-page-css.gen.ts";

export { plainPageCssHash } from "./theme/plain-page-css.gen.ts";

/** The whole document. `title` is text, escaped here; `head` and `body` are HTML, so a caller
 *  escapes what it did not write in them. `head` is what the head carries beyond the title and the
 *  stylesheet; `body` goes inside `main`, the page's one column. In it, a `button` is the main
 *  action, `button.link` an action that reads as a link, `.actions` a row of them, `.stack` a
 *  column of a form's parts and `.muted` a quieter line; headings, lists, fieldsets, labels and
 *  `pre` have plain rules of their own. */
export function standalonePage(input: { title: string; head: string; body: string }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${input.title.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`)}</title><style>${plainPageCss}</style>${input.head}</head><body><main>${input.body}</main></body></html>`;
}
