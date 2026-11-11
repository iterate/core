import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import type { McpConnectionApi, McpConnectOptions, McpServerInfo } from "iterate/api";
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import type { LibraryItx } from "core-itx";
import { subclassWithMethods } from "./connection.ts";

type McpWebhook = { url: string; secret: string };

type McpLiveClient = { client: Client; transport: StreamableHTTPClientTransport };

/** A tool named like one of the connection's own members is reachable through `callTool` only. */
export async function connectToMcp(
  itx: LibraryItx,
  url: string,
  options: McpConnectOptions,
  webhook: () => Promise<McpWebhook>,
): Promise<McpConnectionRpcTarget> {
  /** Every GET is answered 405: the older protocol's standing stream may be held open for good and
   *  keep this context resident, and nothing here listens. */
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

async function end({ client, transport }: McpLiveClient) {
  await transport.terminateSession().catch(() => undefined);
  await client.close();
}

export class McpConnectionRpcTarget extends RpcTarget implements McpConnectionApi {
  readonly #connect: () => Promise<McpLiveClient>;
  readonly #webhook: () => Promise<McpWebhook>;
  readonly #serverInfo: McpServerInfo;
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
    // a tool may run as long as a script may (the SDK's default stops it at 60 s)
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

// An MCP server's answers are untrusted network data.

const EventsList = z.object({
  events: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string().optional(),
      delivery: z.array(z.string()),
    }),
  ),
});

/** `refreshBefore` null: never lapses. */
const Subscription = z.object({ id: z.string(), refreshBefore: z.string().nullable() });
