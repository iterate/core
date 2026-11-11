// standalone-page.ts — a page served as plain HTML, outside any app's build: the browser-auth
// gate's own pages (app-server.ts), the platform's callback pages (core/secrets-worker/src/callback-page.ts) and
// the CLI's sign-in page (cli/oauth.ts). Its one stylesheet is inline (theme/plain-page.css over
// theme/tokens.css), so the page loads nothing to look like the issuer's pages, and a CSP allows
// that stylesheet by its hash, `plainPageCssHash`.
import { plainPageCss } from "./theme/plain-page-css.gen.ts";

export { plainPageCssHash } from "./theme/plain-page-css.gen.ts";

/** iterate's mark, at the head of every plain page: a rounded square in the text's colour with
 *  the glyph in the card's (plain-page.css `.mark`). The glyph is the logo's own (packages/ui's
 *  iterate-logo.svg), copied here because a plain page loads nothing: its policy allows no image. */
const MARK = `<div class="mark" aria-hidden="true"><svg viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg"><rect width="500" height="500"/><g transform="translate(20 20) scale(0.92)"><path d="M264.649 170.149H289.821L286.092 186.904L276.303 233.444L270.709 259.971L263.717 293.015L258.124 320.008L251.131 352.586L249.267 364.687V371.668L249.733 372.133H253.462L259.522 369.806L266.048 365.617L275.371 357.24L282.829 349.328L286.558 345.14L288.888 346.071L294.948 350.725L308 360.498L307.068 362.36L303.339 367.944L296.813 376.322L291.685 382.837L286.558 388.422L282.363 393.076L275.837 399.592L272.108 402.849L267.446 406.573L262.785 409.83L256.725 413.554L247.869 417.742L238.08 420.535L231.554 421H224.096L216.637 420.069L211.51 418.673L206.382 416.811L201.255 413.088L196.594 408.434L192.865 400.988L191.466 394.938L191 389.818V383.768L193.797 365.152L199.857 335.832L207.315 301.392L224.096 223.205L225.028 216.224V206.916L224.562 205.054L222.231 204.123L219.434 203.193L206.382 203.658L196.127 204.589H193.331V178.526L194.263 175.734L258.59 170.615L264.649 170.149Z"/><path d="M264.649 78H268.844L275.836 78.9308L282.362 80.7924L287.49 83.5848L292.151 87.7734L295.414 92.8928L297.278 96.616L299.143 105.924L299.609 113.836L299.143 118.49L298.677 122.213L296.812 128.729L293.549 134.779L290.286 138.502L286.091 141.76L282.362 143.621L278.167 145.018L274.438 145.948L267.912 146.414H260.92L254.394 145.483L249.267 144.087L244.139 141.294L239.944 138.037L236.681 133.383L233.884 127.332L232.486 121.282L232.02 117.559V108.716L232.952 101.735L234.816 95.6852L237.613 90.1004L240.41 86.3772L246.936 82.1886L252.529 79.8616L259.522 78.4654L264.649 78Z"/></g></svg></div>`;

/** The whole document. `title` is text, escaped here; `head` and `body` are HTML, so a caller
 *  escapes what it did not write in them. `head` is what the head carries beyond the title and the
 *  stylesheet; `body` goes inside `main`, the page's one card, under the mark. A card is narrow,
 *  for one question and one action (a sign-in, a consent); `wide` is for a page a person reads or
 *  works in (their keys, the members, the approvals). In the body, a `button` is the main action,
 *  `button.secondary` another way, `button.link` an action that reads as a link, `.actions` a row
 *  of them, `.stack` a column of a form's parts, `.or` the line between two ways and `.muted` a
 *  quieter line; headings, lists, fieldsets, labels and `pre` have plain rules of their own. */
export function standalonePage(input: {
  title: string;
  head: string;
  body: string;
  wide?: boolean;
}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${input.title.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`)}</title><style>${plainPageCss}</style>${input.head}</head><body><main${input.wide ? ' class="wide"' : ""}>${MARK}${input.body}</main></body></html>`;
}
