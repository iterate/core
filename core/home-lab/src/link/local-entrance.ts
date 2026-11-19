import { withoutOutsidePlaceholders } from "iterate/secret-placeholder";
import { ITERATE_STATEMENT_HEADER } from "iterate/signed";

/** A request on the local port as it goes in to the mind, at `url`. Only the boundary may stamp a
 *  caller, and only it reads a mind's signed statement: every `x-itx-*` header and the statement
 *  go. No placeholder from outside reaches the mind's code, as at the boundary's ingress: a page in
 *  the owner's browser can send this port a header of its choice. The filter's own Request goes
 *  on, since it holds the body. */
export function localEntranceRequest(request: Request, url: URL): Request {
  const filtered = withoutOutsidePlaceholders(request);
  const headers = new Headers(
    [...filtered.headers].filter(
      ([name]) => !name.startsWith("x-itx-") && name !== ITERATE_STATEMENT_HEADER,
    ),
  );
  return new Request(url, new Request(filtered, { headers }));
}
