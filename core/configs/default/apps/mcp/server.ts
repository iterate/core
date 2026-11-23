// server.ts — THE MIND'S OWN MCP SERVER, at /mcp on mcp.<domain>, for members (app.ts mounts it).
// It speaks MCP's streamable HTTP with no session: each POST is one JSON-RPC message.
//
// WHAT THIS FILE OWNS is every word a client's model reads: the instructions of `initialize`, the
// tool list and the description of `run`. Their texts are handed in as `guidance`: this file adds
// no word to them.
//
// WHAT IT DOES NOT OWN is who asks and what a script may do. The platform checks the token on the
// way in (issuer: the mind's control-plane hostname; audience: this host) and stamps the member on
// the request. This code never sees a token of the platform's. A `run` goes to `runAsMember`,
// which must execute it as that member, never with this worker's own reach (app.ts says how).
import { z } from "zod";

export type McpRunMessage = {
  jsonrpc: "2.0";
  id: string | number;
  method: "tools/call";
  params: { name: "run"; arguments: { script: string }; _meta?: Record<string, unknown> };
};

const METADATA_PATH = "/.well-known/oauth-protected-resource";
const MCP_PATH = "/mcp";

/** RFC 9728's document. The resource is this server's own URL; the issuer keeps a token for it
 *  to this host (core/auth-worker/src/oauth.ts `knownResourceOf`), and the host serves nothing
 *  but this server. */
const protectedResource = (origin: string, controlPlaneHostname: string) => ({
  resource: `${origin}${MCP_PATH}`,
  authorization_servers: [`https://${controlPlaneHostname}`],
  scopes_supported: ["identity"],
  bearer_methods_supported: ["header"],
});

const runTool = (description: string) => ({
  name: "run",
  title: "Run a script",
  description,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["script"],
    properties: {
      script: {
        type: "string",
        minLength: 1,
        description:
          "The text of an async function of one parameter, `itx`: `async (itx) => { const n = Number(await itx.kv.get('n')) || 0; await itx.kv.put('n', String(n + 1)); return n + 1; }`. It bakes in its own values (there are no arguments — write the whole script). Return a JSON-serializable value (undefined, functions and live handles do not cross the boundary).",
      },
    },
  },
});

const JSONRpcId = z.union([z.string(), z.number()]);

const JSONRpcCall = z.object({
  jsonrpc: z.string().optional(),
  id: JSONRpcId.optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const MetaRecord = z.record(z.string(), z.unknown());

const rpc = (id: string | number | null, body: Record<string, unknown>) =>
  Response.json({ jsonrpc: "2.0", id, ...body });

const text = (body: string, init?: ResponseInit) =>
  new Response(body, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });

/** Every request on the host.
 *  - `caller`: "member", "non-member" (signed in, no member) or "anonymous", as the platform's
 *    stamp says (app.ts reads it through `host.auth`).
 *  - `controlPlaneHostname`: the mind's, as the platform says it.
 *  - `guidance`: `{ instructions, runDescription }`, the two texts as the client gets them.
 *  - `runAsMember(message)`: answers one `tools/call` of `run` as the member who asks. */
export async function mcpAnswer(
  request: Request,
  {
    caller,
    controlPlaneHostname,
    guidance,
    runAsMember,
  }: {
    caller: "member" | "non-member" | "anonymous";
    controlPlaneHostname: () => string;
    guidance: { instructions: string; runDescription: string };
    runAsMember: (message: McpRunMessage) => Response | Promise<Response>;
  },
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === METADATA_PATH || url.pathname === `${METADATA_PATH}${MCP_PATH}`)
    return request.method === "GET"
      ? Response.json(protectedResource(url.origin, controlPlaneHostname()), {
          headers: { "cache-control": "no-store" },
        })
      : text("Method not allowed\n", { status: 405, headers: { allow: "GET" } });
  if (url.pathname !== MCP_PATH) return text("Not found\n", { status: 404 });

  // Read once, before any answer: a client of the 2026-07-28 era probes with `server/discover`.
  const parsed =
    request.method === "POST"
      ? JSONRpcCall.safeParse(await request.json().catch(() => null))
      : null;
  const call = parsed?.success ? parsed.data : null;

  if (caller === "non-member")
    // 403, not 401: a 401 would send the client to authorize again, for the same person.
    return text("This MCP server is for members of this mind.\n", { status: 403 });
  if (caller !== "member") {
    // A bearer that reaches this code did not verify for this host (one that did is stripped):
    // say so, and never read it.
    const invalid = request.headers.has("authorization") ? 'error="invalid_token", ' : "";
    return text(
      `This is this mind's MCP server. Sign in to use it.\n\nA standard MCP client signs in by itself from the WWW-Authenticate header. In Claude: Settings, Connectors, Add custom connector, ${url.origin}${MCP_PATH}. In Claude Code: claude mcp add --transport http ${url.hostname.replaceAll(".", "-")} ${url.origin}${MCP_PATH}\n`,
      {
        // a 401 at the probe ends a new client's connect with an error; a 400 makes it `initialize`
        status: call?.method === "server/discover" ? 400 : 401,
        headers: {
          "WWW-Authenticate": `Bearer ${invalid}resource_metadata="${url.origin}${METADATA_PATH}${MCP_PATH}", scope="identity"`,
        },
      },
    );
  }

  // no stream from the server, and no session to end
  if (request.method !== "POST")
    return text("Method not allowed\n", { status: 405, headers: { allow: "POST" } });
  if (!call) return rpc(null, { error: { code: -32600, message: "Send one JSON-RPC request." } });
  // a notification gets no answer
  if (call.id === undefined) return new Response(null, { status: 202 });
  switch (call.method) {
    case "initialize":
      return rpc(call.id, {
        result: {
          protocolVersion:
            typeof call.params?.protocolVersion === "string" && call.params.protocolVersion
              ? call.params.protocolVersion
              : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "iterate-mind", version: "1" },
          instructions: guidance.instructions,
        },
      });
    case "ping":
      return rpc(call.id, { result: {} });
    case "tools/list":
      return rpc(call.id, { result: { tools: [runTool(guidance.runDescription)] } });
    case "tools/call": {
      if (call.params?.name !== "run")
        return rpc(call.id, {
          error: { code: -32602, message: `No tool named ${String(call.params?.name)}.` },
        });
      const args = MetaRecord.safeParse(call.params.arguments);
      const script = args.success && typeof args.data.script === "string" ? args.data.script : "";
      if (!script)
        return rpc(call.id, {
          result: {
            content: [
              { type: "text", text: "Send `script`: the text of an async function of `itx`." },
            ],
            isError: true,
          },
        });
      // Only what `run` takes goes on: the id, the script, and the call's own envelope (`_meta`,
      // which MCP from 2026-07-28 on requires beside each request).
      const meta = MetaRecord.safeParse(call.params._meta);
      return runAsMember({
        jsonrpc: "2.0",
        id: call.id,
        method: "tools/call",
        params: {
          name: "run",
          arguments: { script },
          ...(meta.success && { _meta: meta.data }),
        },
      });
    }
    default:
      return rpc(call.id, { error: { code: -32601, message: `No method ${call.method}.` } });
  }
}

/** `runAsMember` while the platform has no way to run a script as the member from a host's own
 *  HTTP handler: it refuses, and names the endpoint that works. Never replace this with a run
 *  through the worker's own `itx`: that script would have the worker's reach and its name. */
export const runUnavailable =
  (controlPlaneHostname: () => string) => (message: Pick<McpRunMessage, "id">) =>
    rpc(message.id, {
      result: {
        content: [
          {
            type: "text",
            text: `This server cannot run a script as you yet. Use https://${controlPlaneHostname()}/mcp for \`run\`.`,
          },
        ],
        isError: true,
      },
    });
