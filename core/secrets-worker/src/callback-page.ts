import type { SecretOperation } from "iterate/api";
import { ITX_PERSON_HEADER, stampedCallerOf, type Person } from "iterate/principal";
import { plainPageCssHash, standalonePage } from "iterate/standalone-page";

// Safe inside HTML text and a double-quoted attribute only.
export const escaped = (text: string) =>
  text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);

// `body` is HTML the caller escaped.
export function plainPage(
  status: number,
  body: string,
  formAction = "'none'",
  scriptNonce?: string,
): Response {
  const script = scriptNonce ? `script-src 'nonce-${scriptNonce}'; connect-src 'self'; ` : "";
  return new Response(
    standalonePage({
      title: "iterate",
      head: `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
      body,
    }),
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; ${script}style-src ${plainPageCssHash}; img-src 'self'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`,
        "x-frame-options": "DENY",
        // Not `no-referrer`: under it a form's POST sends `Origin: null`, and the boundary counts a
        // member's cookie on a write only from this origin, so the member would arrive signed out.
        "referrer-policy": "same-origin",
      },
    },
  );
}

// Browser specs' failure reports quote an element marked `role="alert"` and `data-type="error"`.
export function callbackPage(status: number, text: string): Response {
  return plainPage(
    status,
    status >= 400
      ? `<p role="alert" data-type="error">${escaped(text)}</p>`
      : `<p>${escaped(text)}</p>`,
  );
}

export type PageCaller = { userId: string; email: string; member: boolean } | null;

export function admitted(request: Request, anyoneWithLink: boolean): { by: PageCaller } | Response {
  const person = request.headers.get(ITX_PERSON_HEADER);
  const signedIn = person ? (JSON.parse(person) as Person) : null;
  const by = signedIn && {
    userId: signedIn.userId,
    email: signedIn.email,
    member: stampedCallerOf(request).principal !== null,
  };
  if (anyoneWithLink || by?.member) return { by };
  if (by)
    return callbackPage(403, `You are signed in as ${by.email}, who is not a member of this mind.`);
  const { pathname, search } = new URL(request.url);
  return new Response(null, {
    status: 303,
    headers: {
      location: `/sign-in?next=${encodeURIComponent(pathname + search)}`,
      "cache-control": "no-store",
    },
  });
}

export function useLines(
  use: {
    placement: "header" | "url";
    operations: readonly SecretOperation[];
    lendTo: readonly string[] | null;
  },
  anyoneWithLink: boolean,
): string {
  return [
    use.placement === "url" ? "<p>It may be placed in a URL.</p>" : "",
    use.operations.length
      ? `<p>The mind may sign and verify with it: ${use.operations.join(", ")}.</p>`
      : "",
    use.lendTo?.length
      ? `<p>The refresh of these secrets may borrow it: ${use.lendTo.map(escaped).join(", ")}.</p>`
      : "",
    anyoneWithLink ? "<p>Anyone with this link can use this page, signed in or not.</p>" : "",
  ].join("");
}
