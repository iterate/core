// page-tag.ts — WHAT worker.ts's `fetch` CALLS OF THE PAGE TAG (page-events.ts, page-events.md).
//
// `fetch` is the one place where the page tag is added. First who gets the tag at all
// (`pageTagFor`: everyone, or members alone). Then what a page's tag asks of its own host: its
// script, and the route that takes what the page reports; both for anyone, before any guard, and
// the route only on a host that served a page with the tag (`pageEvents`). Then the app's own
// answer, and every HTML page among the answers gets the tag first in its `<head>`, in the form
// that the page's own content security policy allows (`addPageTag`): no app adds it, and no app
// can forget it. A page whose policy allows no form of it is counted here, from what its request
// says. With the switch of `pageTagFor` off for a request, each function here leaves the request
// and its answer as they are: anyone who is no member gets every answer as it was before the tag.
import type { IterateConfigEntrypoint } from "iterate/sdk";
import {
  documentRequest as untaggedDocumentRequest,
  droppedBatch,
  hostTagged,
  pageEventsRoute,
  pageRequested,
  pageTagFor,
  tagFormFor,
  withPageTag,
} from "./page-events.ts";

type Host = Pick<IterateConfigEntrypoint, "auth" | "getItx">;

/** The answer to what a page's tag sends to its own host (`pageEventsRoute`): its script, and the
 *  route that takes what the page reports. Null for any other request, and for every request
 *  that `pageTagFor` gives no tag. */
export async function pageEvents(request: Request, host: Host): Promise<Response | null> {
  if (!pageTagFor(host, request)) return null;
  // the route never throws; were it to, the send is dropped as the route drops one
  return pageEventsRoute(request, host).catch(droppedBatch);
}

/** The request that the app gets: page-events.ts's `documentRequest`, or the request itself for
 *  a request that `pageTagFor` gives no tag. */
export function documentRequest(request: Request, host: Pick<Host, "auth">): Request {
  return pageTagFor(host, request) ? untaggedDocumentRequest(request) : request;
}

/** The app's answer with the page tag, when it is an HTML page whose policy allows a form of it.
 *  `request` is the original request, before `documentRequest`. `keep` keeps work alive after
 *  the answer (the entrypoint's `ctx.waitUntil`). The answer itself for a request that
 *  `pageTagFor` gives no tag. */
export function addPageTag(
  request: Request,
  answer: Response,
  host: Host,
  keep: (work: Promise<unknown>) => void,
): Response {
  if (!pageTagFor(host, request)) return answer;
  const form = tagFormFor(request, answer);
  if (form) {
    // this host reports from now on: it served a page with the tag (page-events.ts `hostTagged`)
    const kept = hostTagged(host, request);
    if (kept) keep(kept);
    return withPageTag(answer, form);
  }
  const counted = pageRequested(request, answer, host);
  if (counted) keep(counted);
  return answer;
}
