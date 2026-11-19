import { ITERATE_CAUSE_HEADER } from "iterate/lib";
import { parseCause, causeHeader, refuseActPastLimit, type Cause } from "../cause.ts";
import { itxHost } from "../host.ts";
import { FETCH_UPGRADE_RESUMABLE_HEADER } from "./fetch-upgrade.ts";
import { stampCallerHeaders } from "./rpc-stubs.ts";

// The platform's caller stamp must never leave, or it rides whatever an app forwards outbound.
// Only headers are rewritten, so a WebSocket 101 flows straight back.
export function egress(
  request: Request,
  from: {
    cause: Cause | undefined;
    path: string;
    /** The other mind that the host signs this request for (`ItxHost.egress`). */
    signFor?: string;
  },
): Promise<Response> {
  const cause = from.cause || parseCause(request.headers.get(ITERATE_CAUSE_HEADER));
  refuseActPastLimit(cause, `egress to ${new URL(request.url).host}`);
  const headers = new Headers(request.headers);
  stampCallerHeaders(headers, null);
  // what the host says to loaded code is for the mind's own code alone
  for (const name of Object.keys(itxHost().loadedCodeRequestHeaders?.() || {}))
    headers.delete(name);
  if (cause) headers.set(ITERATE_CAUSE_HEADER, causeHeader(cause, new URL(request.url).hostname));
  headers.delete(FETCH_UPGRADE_RESUMABLE_HEADER);
  // Chromium drops User-Agent on a Request it builds, and GitHub's API refuses a request without one.
  if (!headers.has("user-agent")) headers.set("user-agent", "iterate");
  const outbound = new Request(request, { headers });
  const door = itxHost().egress;
  if (from.signFor && !door) throw new Error("egress: this host signs no request for another mind");
  return door ? door(outbound, { path: from.path, signFor: from.signFor }) : fetch(outbound);
}
