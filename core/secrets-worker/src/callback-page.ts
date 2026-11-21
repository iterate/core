import type { SecretBodyField, SecretOperation } from "iterate/api";
import { ITX_PERSON_HEADER, stampedCallerOf, type Person } from "iterate/principal";
import { PLAIN_PAGE_ICON_SRC, plainPageCssHash, standalonePage } from "iterate/standalone-page";

// Safe inside HTML text and a double-quoted attribute only.
export const escaped = (text: string) =>
  text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);

// `body` is HTML the caller escaped. The page names its mind by `mind`, or else by the request's
// hostname: the control plane's, the one host where the vault's pages answer.
export function plainPage(
  request: Request,
  status: number,
  body: string,
  {
    formAction = "'none'",
    scriptNonce,
    // a page a person works in (the approvals), where the others are the narrow card of one question
    wide = false,
    // what the browser's tab says: a page a person keeps open names itself
    title = "iterate",
    // a page whose script fetches from its own origin (the approvals); no other page may fetch
    connects = false,
    mind = new URL(request.url).hostname,
  }: {
    formAction?: string;
    scriptNonce?: string;
    wide?: boolean;
    title?: string;
    connects?: boolean;
    mind?: string;
  } = {},
): Response {
  const script = scriptNonce
    ? `script-src 'nonce-${scriptNonce}'; ${connects ? "connect-src 'self'; " : ""}`
    : "";
  return new Response(
    standalonePage({
      title,
      head: "",
      body,
      wide,
      mind,
    }),
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; ${script}style-src ${plainPageCssHash}; img-src 'self' ${PLAIN_PAGE_ICON_SRC}; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`,
        "x-frame-options": "DENY",
        // Not `no-referrer`: under it a form's POST sends `Origin: null`, and the boundary counts a
        // member's cookie on a write only from this origin, so the member would arrive signed out.
        "referrer-policy": "same-origin",
      },
    },
  );
}

// Browser specs' failure reports quote an element marked `role="alert"` and `data-type="error"`.
export function callbackPage(request: Request, status: number, text: string): Response {
  return plainPage(
    request,
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
    return callbackPage(
      request,
      403,
      `You are signed in as ${by.email}, who is not a member of this mind.`,
    );
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
    statementPaths?: readonly string[];
    bodyFields?: readonly SecretBodyField[];
  },
  anyoneWithLink: boolean,
): string {
  return [
    use.placement === "url" ? "<p>It may be placed in a URL.</p>" : "",
    // one sentence for each body field, for a person: where the value goes, and what that costs
    ...(use.bodyFields?.length
      ? [
          "<p>It may also be sent inside the body of a request. A secret that is sent in a body is not kept from this mind's own code if that service shows it back. So give it only the reach that you would give the mind itself.</p>",
          ...use.bodyFields.map(
            ({ method, url, field }) =>
              `<p>It may be sent inside the body, in the field ${escaped(field)}, of a ${escaped(method)} to ${escaped(url)}.</p>`,
          ),
        ]
      : []),
    use.operations.length
      ? `<p>The mind may sign and verify with it: ${use.operations.join(", ")}.</p>`
      : "",
    // oxlint-disable-next-line iterate/simple-truthiness-check -- null is every path; an empty list is no path
    use.lendTo === null
      ? "<p>The refresh of any secret of this mind may borrow it.</p>"
      : use.lendTo.length
        ? `<p>The refresh of these secrets may borrow it: ${use.lendTo.map(escaped).join(", ")}.</p>`
        : "",
    use.statementPaths
      ? `<p>A statement it signs may name these paths alone: ${use.statementPaths.map(escaped).join(", ")}.</p>`
      : "",
    anyoneWithLink ? "<p>Anyone with this link can use this page, signed in or not.</p>" : "",
  ].join("");
}
