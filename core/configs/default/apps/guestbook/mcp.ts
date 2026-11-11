// mcp.ts — THE GUESTBOOK'S OWN MCP SERVER, at /mcp on the app's host, for other agents. It speaks
// MCP's streamable HTTP with no session: each POST is one JSON-RPC message, answered as JSON.
//
// How an agent signs in: its first call has no token, and gets a 401 that names the document at
// /.well-known/oauth-protected-resource/mcp (RFC 9728). That names the mind's sign-in
// (https://iterate.<domain>) as the authorization server. The client registers there, its person
// signs in and consents, and the token it gets is good for this host alone. The platform checks
// the token on the way in and hands this code the person (`host.auth.person`), never the token.
import type { Person } from "iterate/principal";
import type { Guestbook } from "./app.ts";

const METADATA_PATH = "/.well-known/oauth-protected-resource";

/** RFC 9728's document, for `/mcp` and for the host. The resource is the host's origin: a token is
 *  for a whole host. */
export function protectedResourceResponse(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== METADATA_PATH && url.pathname !== `${METADATA_PATH}/mcp`) return null;
  const mind = url.hostname.split(".").slice(1).join(".");
  return Response.json({
    resource: url.origin,
    authorization_servers: [`https://iterate.${mind}`],
    scopes_supported: ["identity"],
    bearer_methods_supported: ["header"],
  });
}

const TOOLS = [
  {
    name: "list_entries",
    description:
      "List the guestbook's entries: the approved ones, and your own that wait for a member's approval. A reply names the entry it answers in `replyTo`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_entry",
    description:
      "Write an entry in the guestbook as the signed-in person. It waits until a member of the mind approves it.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The entry, 1000 characters at most." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "reply_to_entry",
    description:
      "Answer an approved entry, by its `id` from list_entries. The reply waits for a member's approval like any entry.",
    inputSchema: {
      type: "object",
      properties: { entry: { type: "integer" }, text: { type: "string" } },
      required: ["entry", "text"],
      additionalProperties: false,
    },
  },
];

type Call = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };

export async function mcpResponse(
  request: Request,
  {
    person,
    viewer,
    book,
  }: { person: Person | null; viewer: { person: Person | null; member: boolean }; book: Guestbook },
): Promise<Response> {
  const url = new URL(request.url);
  if (!person)
    return new Response("Sign in\n", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${url.origin}${METADATA_PATH}/mcp", scope="identity"`,
      },
    });
  // no stream from the server, and no session to end
  if (request.method !== "POST")
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "POST" } });
  const call = (await request.json().catch(() => null)) as Call | null;
  if (!call?.method)
    return rpc(null, { error: { code: -32600, message: "Send one JSON-RPC request." } });
  // a notification gets no answer
  if (call.id === undefined) return new Response(null, { status: 202 });
  switch (call.method) {
    case "initialize":
      return rpc(call.id, {
        result: {
          protocolVersion: String(call.params?.protocolVersion || "2025-06-18"),
          capabilities: { tools: {} },
          serverInfo: { name: `guestbook at ${url.hostname}`, version: "1" },
          instructions: `The guestbook of ${url.hostname}. You are signed in as ${person.email}.`,
        },
      });
    case "ping":
      return rpc(call.id, { result: {} });
    case "tools/list":
      return rpc(call.id, { result: { tools: TOOLS } });
    case "tools/call": {
      const input = (call.params?.arguments || {}) as Record<string, unknown>;
      const said = (value: unknown, isError = false) =>
        rpc(call.id, {
          result: { content: [{ type: "text", text: JSON.stringify(value) }], isError },
        });
      if (call.params?.name === "list_entries") return said(await book.view(viewer));
      if (call.params?.name === "add_entry" || call.params?.name === "reply_to_entry") {
        const reply = call.params.name === "reply_to_entry";
        if (reply && typeof input.entry !== "number")
          return said({ refused: "Name the entry you answer." }, true);
        const written = await book.write(person, {
          text: input.text,
          replyTo: reply ? input.entry : undefined,
        });
        return said(written, "refused" in written);
      }
      return rpc(call.id, {
        error: { code: -32602, message: `No tool named ${String(call.params?.name)}.` },
      });
    }
    default:
      return rpc(call.id, { error: { code: -32601, message: `No method ${call.method}.` } });
  }
}

const rpc = (id: unknown, body: Record<string, unknown>) =>
  Response.json({ jsonrpc: "2.0", id, ...body });
