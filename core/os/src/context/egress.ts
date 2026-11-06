// context/egress.ts — EGRESS, `itx.fetch`: a project's way to the internet, the same from every one
// of its contexts, and so from the stateless entrypoint as from a context's Durable Object
// (itx-expression-rewriting.ts `PORTABLE_ROOTS`).
import { ITERATE_CAUSE_HEADER, resolveContextPath } from "iterate/lib";
import { parseCause, causeHeader, refuseActPastLimit, type Cause } from "../cause.ts";
import { traceModelCall, traceResponsesSocket } from "../agent-spans.ts";
import { secretPathsReferenced } from "../secrets.ts";
import { FETCH_UPGRADE_RESUMABLE_HEADER } from "./fetch-upgrade.ts";
import { stampCallerHeaders } from "./rpc-stubs.ts";
import { resourceScope } from "./paths.ts";

/** EGRESS: a request that names a secret — `getSecret("/secrets/NAME")` in its URL or headers — is
 *  FORWARDED to the context at that path under the RESOURCE OWNER's root (`resourceScope`: a
 *  project's `/secrets/NAME`, a user's `/users/<id>/secrets/NAME` — so a user's placeholder reaches
 *  the user's own secret, never a shared one), and there to its `secret` facet
 *  (secret/durable-object.ts), which substitutes, pins, dispatches, and refreshes on a 401
 *  (`useSecret`, secrets.ts `SECRET_USE_HEADER`: that context hands it to the facet, never to its own
 *  egress, so all of this runs once, here); one request, one secret (a second name is a 502 — no
 *  cross-secret chaining). A
 *  request naming none goes straight to the terminal fetch. Either way the platform's own headers
 *  never leave: the principal stamp (actor + email) and the expression would ride whatever an app
 *  forwards outbound. OUR MARK goes instead (cause.ts), and past the loop limit nothing is sent.
 *  WS-safe: only the headers are rewritten, and every hop is a fetch channel — the other context's
 *  `fetch`, then `ctx.facets.get(name).fetch` — so a 101 flows straight back either way (measured:
 *  test/vitest/os-workers/facets.test.ts). */
export function egress(
  request: Request,
  from: {
    projectId: string;
    path: string;
    /** Why it is sent (the caller's). */
    cause: Cause | undefined;
    /** The secret's `secret` facet's fetch, where the value is. */
    useSecret: (secretPath: string, outbound: Request) => Promise<Response>;
  },
): Promise<Response> {
  // why it is sent: the caller's, or the mark a platform sender stamped on the request
  const cause = from.cause || parseCause(request.headers.get(ITERATE_CAUSE_HEADER));
  refuseActPastLimit(cause, `egress to ${new URL(request.url).host}`);
  const headers = new Headers(request.headers);
  stampCallerHeaders(headers, null);
  if (cause) headers.set(ITERATE_CAUSE_HEADER, causeHeader(cause));
  headers.delete(FETCH_UPGRADE_RESUMABLE_HEADER); // the edge's ask of a lent stub, never an origin's
  // A lend's headers are platform-to-platform (secrets.ts `LEND_USE_HEADER`): never a caller's.
  for (const name of [...headers.keys()]) if (name.startsWith("x-itx-lend")) headers.delete(name);
  // A browser cannot set User-Agent on a Request it builds (Chromium drops it), and GitHub's API
  // refuses a request without one: a caller that names none is sent as `iterate`.
  if (!headers.has("user-agent")) headers.set("user-agent", "iterate");
  const outbound = new Request(request, { headers });
  const paths = secretPathsReferenced(outbound);
  if (paths.length > 1)
    return Promise.resolve(
      new Response(
        `itx.fetch: one request, one secret — this one names ${paths.map((path) => JSON.stringify(path)).join(", ")}\n`,
        { status: 502 },
      ),
    );
  const { projectId, path } = from;
  const secretPath =
    paths[0] && resolveContextPath(resourceScope(projectId, path).rootPath, `.${paths[0]}`);
  const send = () => (secretPath ? from.useSecret(secretPath, outbound) : fetch(outbound));
  // a model call with a project's own key gets the spans Cloudflare's Agents view reads
  // (agent-spans.ts): an HTTP call's answer is read through, and a Responses WebSocket is relayed
  const model = modelCallAt(outbound, { projectId, path });
  if (model?.kind === "socket")
    return send().then((upgrade) => traceResponsesSocket(upgrade, model.call));
  if (model?.kind === "http") return traceModelCall(model.call, send);
  return send();
}

/** Whether `outbound` is a model call these spans trace, and as whose. */
export function modelCallAt(
  outbound: Pick<Request, "url" | "method" | "headers">,
  at: { projectId: string; path: string },
):
  | { kind: "socket" | "http"; call: { projectId: string; path: string; provider: string } }
  | undefined {
  if (outbound.url !== "https://api.openai.com/v1/responses") return;
  const call = { projectId: at.projectId, path: at.path, provider: "openai" };
  if (outbound.headers.get("upgrade")?.toLowerCase() === "websocket")
    return { kind: "socket", call };
  return outbound.method === "POST" ? { kind: "http", call } : undefined;
}
