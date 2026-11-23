// website.ts — THE PUBLIC WEBSITE'S FIXED ANSWERS, for anyone, on every hostname that is no app.
//
// worker.ts's `fetch` asks these in order, before the homepage (homepage.ts). Each is a partial
// fetcher: it answers a Response, or null for a request that is not its own, and the next one
// gets the request.
import type { IterateConfigEntrypoint } from "iterate/sdk";
import { CLIENT_DOCUMENT_PATH, cloudflareClientDocument } from "./cloudflare.ts";
import { serveProfile } from "./profile.ts";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import profileFiles from "./profile/";

/** `/me`: who the visitor is, for anyone signed in, member or not: the smallest page with end
 *  users. Signed out, the platform turns the answer into a sign-in and comes back here. Null for
 *  any other path. */
export function me(request: Request, host: Pick<IterateConfigEntrypoint, "auth">) {
  if (new URL(request.url).pathname !== "/me") return null;
  return host.auth.requirePerson(request) || Response.json(host.auth.person(request));
}

/** The mind's client at Cloudflare's MCP server, for anyone: the server fetches it at a connect
 *  (cloudflare.ts `cloudflareClientDocument`). Public, no secret in it. Null for any other
 *  request. */
export async function cloudflareClient(
  request: Request,
  host: Pick<IterateConfigEntrypoint, "getItx">,
): Promise<Response | null> {
  const { origin, pathname } = new URL(request.url);
  if (pathname !== CLIENT_DOCUMENT_PATH || request.method !== "GET") return null;
  using itx = host.getItx();
  return await cloudflareClientDocument(itx, origin);
}

/** What the mind says of itself, for anyone: its name, its description and its icon, as the
 *  owner wrote them in the folder profile/ (profile.ts). Null for any other request. */
export function publicProfile(request: Request) {
  return serveProfile(request, profileFiles);
}
