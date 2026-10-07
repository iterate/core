// callback-page.ts — the page a provider's callback shows the person when it does not send them on
// (secret-oauth-callback.ts, integrations/github.ts, integrations/connections.ts): one line that
// says what happened, dressed in the issuer's stylesheet like the SDK's gate pages. A failure is
// marked the way the platform's other pages mark theirs (`role="alert"`, `data-type="error"`), so a
// browser spec's failure report quotes it (middlewright's ui-error-reporter, test/playwright/AGENTS.md).

/** The page for a callback's answer: `text`, escaped, marked as an error when `status` is 4xx or
 *  5xx. No script, never cached, never framed. */
export function callbackPage(status: number, text: string): Response {
  const escaped = text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
  const message =
    status >= 400 ? `<p role="alert" data-type="error">${escaped}</p>` : `<p>${escaped}</p>`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>iterate</title><link rel="stylesheet" href="/issuer.css"></head><body><main class="issuer-card"><img class="issuer-mark" src="/iterate-logo.svg" alt="" width="56" height="56">${message}</main></body></html>\n`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
      },
    },
  );
}
