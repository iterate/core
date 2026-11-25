// mind-ingress.ts — THE HEADERS THAT A HOST OF THE MIND AND THE PLATFORM PASS EACH OTHER
// (`iterate/mind-ingress`). Every hostname of a mind's zones but its control-plane hostname reaches the
// config worker's `fetch`, which routes on `new URL(request.url).hostname` in plain code.

/** THE MIND'S CONTROL-PLANE HOSTNAME, on every request that the mind Worker hands to the mind's own
 *  code: where the mind's sign-in, its keys and its approvals pages are. The mind's code and its
 *  apps read it here (iterate/sdk `auth.controlPlaneHostname`) and never work it out from the hostname
 *  a request came in on, which may be in another zone. The mind Worker says it from its own
 *  config, as the kernel's host (core/mind-worker/src/itx-host.ts `loadedCodeRequestHeaders`), and
 *  the kernel sets it over whatever a request carried each time it hands one to loaded code: in
 *  every context, and whoever made the request. */
export const ITERATE_CONTROL_PLANE_HOSTNAME_HEADER = "x-iterate-control-plane-hostname";

/** WHAT A CONFIG WORKER'S ANSWER ASKS THE PLATFORM TO SERVE IN ITS PLACE, on a mind host:
 *  `itx` is the member's own itx over a WebSocket (iterate/sdk `auth.itx`), and `person-itx` a
 *  signed-in person's narrow view of one context (iterate/sdk `auth.personItx`), the context that
 *  `ITERATE_SERVE_CONTEXT_HEADER` names; and `mcp-run` one call of the MCP tool `run`, the
 *  JSON-RPC message that is the answer's body (iterate/sdk `auth.mcpRun`); and `mcp-server` a
 *  whole MCP server, whose class the answer's body names (iterate/sdk `auth.mcpServer`). An answer, never a call: the platform serves it for the
 *  caller the boundary stamped on the request it still holds, so the config worker names no
 *  caller. The platform drops both headers from every answer it does not honour, so they never
 *  reach a browser. */
export const ITERATE_SERVE_HEADER = "x-iterate-serve";

/** The context path a `person-itx` answer names: the one context the person's socket reaches. */
export const ITERATE_SERVE_CONTEXT_HEADER = "x-iterate-serve-context";

/** The facet of that context a `person-itx` answer names, if any: the platform asks its person
 *  method `admits()` whether a person who is no member still reaches the context (iterate/sdk
 *  `auth.personItx`, `admits`). */
export const ITERATE_SERVE_ADMITS_HEADER = "x-iterate-serve-admits";

/** THE BASE PATH an app is served under, when what serves it strips a prefix from the URL the app
 *  sees: an app composes the paths the browser addresses with it (packages/ui
 *  `src/apps/base-path.ts`). Absent on a mind's own hostnames, where each app owns its origin. */
export const ITERATE_BASE_PATH_HEADER = "x-iterate-base-path";
