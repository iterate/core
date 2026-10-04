// library/mcp.ts — `itx.connectToMcp(url, { headers? })`: an MCP server through the official client
// (@modelcontextprotocol/client) over Streamable HTTP, every request through this context's
// `itx.fetch`. The client picks the protocol: `server/discover` on a 2026-07-28 server, else the
// `initialize` handshake and its session. Tool args are one object; a result's `structuredContent`
// wins, else its text, JSON-parsed when it parses. `subscribe` lands the server's events on this
// context through its MCP webhook (integrations/mcp.ts); a subscription lapses at the
// `refreshBefore` the server grants unless `subscribe` is called again.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import type { McpConnectionApi, McpConnectOptions, McpServerInfo } from "iterate/api";
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import type { LibraryItx } from "../library.ts";
import { subclassWithMethods } from "./connection.ts";

/** Where a server POSTs this context's events, and the secret it signs them with. */
export type McpWebhook = { url: string; secret: string };

/** A client and the transport it is connected over: one per connect, ended together. */
type McpLiveClient = { client: Client; transport: StreamableHTTPClientTransport };

/** Connect and list the tools, then hand back a connection whose prototype carries one method per
 *  tool (a tool named like one of the connection's own members — `callTool`, `close`, `then`… — is
 *  reachable through `callTool` only; connection.ts `subclassWithMethods`). `webhook` answers this
 *  context's webhook for the server at `url`. */
export async function connectToMcp(
  itx: LibraryItx,
  url: string,
  options: McpConnectOptions,
  webhook: () => Promise<McpWebhook>,
): Promise<McpConnectionRpcTarget> {
  /** A fresh client, connected. Every GET is answered 405, "no stream", here: the older protocol's
   *  standing stream for server-sent messages may be held open for good and so keep this context
   *  resident, and nothing here listens (nor resumes a broken response stream, which is a GET too).
   *  A response stream is read until the server ends it, as the spec says it does after the answer. */
  const connect = async (): Promise<McpLiveClient> => {
    const client = new Client(
      { name: "iterate-context", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: async (input, init) =>
        init?.method === "GET"
          ? new Response(null, { status: 405 })
          : itx.fetch(new Request(input, init)),
      requestInit: { headers: options.headers },
    });
    await client.connect(transport);
    return { client, transport };
  };
  const live = await connect();
  try {
    const { tools } = await live.client.listTools();
    const Connection = subclassWithMethods(
      McpConnectionRpcTarget,
      tools.map((tool) => tool.name),
      (self, name, args) => self.callTool(name, args as Record<string, unknown> | undefined),
    );
    return new Connection(live, connect, webhook);
  } catch (error) {
    await end(live);
    throw error;
  }
}

/** End a client: its session (a DELETE, to a server that gave one), then the client itself. */
async function end({ client, transport }: McpLiveClient) {
  await transport.terminateSession().catch(() => undefined);
  await client.close();
}

/** A connected MCP server. Held across calls it is an RpcTarget. Closing it ends its client (the
 *  library's release closes every connection), and its next call connects a new one: a held
 *  connection is never dead. */
export class McpConnectionRpcTarget extends RpcTarget implements McpConnectionApi {
  readonly #connect: () => Promise<McpLiveClient>;
  readonly #webhook: () => Promise<McpWebhook>;
  readonly #serverInfo: McpServerInfo;
  /** The client, connected or connecting; null once closed. */
  #live: Promise<McpLiveClient> | null;
  constructor(
    live: McpLiveClient,
    connect: () => Promise<McpLiveClient>,
    webhook: () => Promise<McpWebhook>,
  ) {
    super();
    this.#live = Promise.resolve(live);
    this.#connect = connect;
    this.#webhook = webhook;
    this.#serverInfo = {
      protocolVersion: live.client.getNegotiatedProtocolVersion(),
      capabilities: live.client.getServerCapabilities(),
      serverInfo: live.client.getServerVersion(),
    };
  }
  /** The live client, a new one connected first if this connection was closed; a connect that
   *  fails is tried again on the next call (unless a close or a newer connect replaced it). */
  async #client(): Promise<Client> {
    const live = (this.#live ??= this.#connect());
    try {
      return (await live).client;
    } catch (error) {
      if (this.#live === live) this.#live = null;
      throw error;
    }
  }
  serverInfo() {
    return this.#serverInfo;
  }
  async listTools() {
    return (await (await this.#client()).listTools()).tools;
  }
  async callTool(...[name, args]: Parameters<McpConnectionApi["callTool"]>) {
    const client = await this.#client();
    // a tool may run as long as a script may (the SDK's default would stop it at 60 s)
    const result = await client.callTool(
      { name, arguments: args || {} },
      { timeout: RUN_DEADLINE_MS },
    );
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    if (result.isError) throw new Error(`MCP tool ${name} failed: ${text || "no message"}`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (text === "") return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  async listEvents() {
    const client = await this.#client();
    return (await client.request({ method: "events/list", params: {} }, EventsList)).events;
  }
  async subscribe(...[name, args]: Parameters<McpConnectionApi["subscribe"]>) {
    const client = await this.#client();
    const { url, secret } = await this.#webhook();
    return await client.request(
      {
        method: "events/subscribe",
        params: { name, arguments: args || {}, delivery: { mode: "webhook", url, secret } },
      },
      Subscription,
    );
  }
  async unsubscribe(...[name, args]: Parameters<McpConnectionApi["unsubscribe"]>) {
    const client = await this.#client();
    const { url } = await this.#webhook();
    await client.request(
      { method: "events/unsubscribe", params: { name, arguments: args || {}, delivery: { url } } },
      z.looseObject({}),
    );
  }
  /** End the live client; a call that starts after this connects a new one. */
  async close() {
    const live = this.#live;
    this.#live = null;
    const ended = await live?.catch(() => null);
    if (ended) await end(ended);
  }
  [Symbol.dispose](): void {
    void this.close();
  }
}

// An MCP server's answers are untrusted network data: the extension's results are parsed here.

/** `events/list`: each event's name, description and delivery modes, and its schemas as given. */
const EventsList = z.object({
  events: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string().optional(),
      delivery: z.array(z.string()),
    }),
  ),
});

/** `events/subscribe`: the subscription's id and the time it lapses unless renewed (null: never). */
const Subscription = z.object({ id: z.string(), refreshBefore: z.string().nullable() });
