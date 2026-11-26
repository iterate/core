// The connection that `itx.connectToMcp` answers (mcp.ts), against a fake MCP App server served by
// the SDK's own handler: the MCP Apps extension in `initialize`, a tool's `title` and `_meta`, a
// tool's whole result, and `resources/read`.
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { expect, test } from "vitest";
import { z } from "zod";
import type { LibraryItx } from "core-itx";
import { connectToMcp, MCP_RESOURCE_MAX_CHARS } from "./mcp.ts";

const VIEW = "ui://petshop/board.html";
const HTML = "<!doctype html><html><body>the board</body></html>";

test("the client declares the MCP Apps extension, and a tool keeps its title and _meta", async () => {
  const { itx, sent } = itxOfFake();
  const mcp = await connectToMcp(itx, "https://petshop.test/mcp", {}, noWebhook);
  // 2026-07-28 says the client's capabilities in each request's `_meta`; older ones, in `initialize`
  type Sent = {
    method?: string;
    params?: { capabilities?: unknown; _meta?: Record<string, unknown> };
  };
  const declared = (sent as Sent[]).map(
    ({ method, params }) =>
      (method === "initialize" ? params?.capabilities : undefined) ??
      params?._meta?.["io.modelcontextprotocol/clientCapabilities"],
  );
  expect(declared.length).toBeGreaterThan(0);
  for (const capabilities of declared)
    expect(capabilities).toEqual({
      extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
    });
  expect(await mcp.listTools()).toContainEqual(
    expect.objectContaining({
      name: "show_board",
      title: "Show the board",
      _meta: { ui: { resourceUri: VIEW } },
    }),
  );
  await mcp.close();
});

test("callToolResult answers the whole result, and an isError result does not throw", async () => {
  const { itx } = itxOfFake();
  const mcp = await connectToMcp(itx, "https://petshop.test/mcp", {}, noWebhook);
  expect(await mcp.callToolResult("show_board", { id: "b1" })).toMatchObject({
    content: [{ type: "text", text: "board b1" }],
    structuredContent: { id: "b1", pets: 3 },
  });
  expect(await mcp.callToolResult("refuse")).toMatchObject({
    content: [{ type: "text", text: "no pets today" }],
    isError: true,
  });
  // callTool keeps its meaning: the structured content, and a throw on isError
  expect(await mcp.callTool("show_board", { id: "b2" })).toEqual({ id: "b2", pets: 3 });
  await expect(mcp.callTool("refuse")).rejects.toThrow("MCP tool refuse failed: no pets today");
  await mcp.close();
});

test("readResource answers the view's document and its _meta, and refuses one past the bound", async () => {
  const { itx } = itxOfFake();
  const mcp = await connectToMcp(itx, "https://petshop.test/mcp", {}, noWebhook);
  expect(await mcp.readResource(VIEW)).toEqual({
    contents: [
      {
        uri: VIEW,
        mimeType: "text/html;profile=mcp-app",
        text: HTML,
        _meta: { ui: { csp: { connectDomains: ["wss://petshop.iterate.com"] } } },
      },
    ],
  });
  await expect(mcp.readResource("ui://petshop/huge.html")).rejects.toThrow(
    `has more than ${String(MCP_RESOURCE_MAX_CHARS)} characters`,
  );
  await mcp.close();
});

test("listTools follows nextCursor to the last page (the SDK does), and refuses a listing that never ends", async () => {
  const pages = (count: number) => () => {
    const server = new McpServer({ name: "paged", version: "1" });
    server.registerTool("unused", {}, () => ({ content: [] }));
    // the SDK's own listing is one page: this one answers `count` pages of two tools each
    server.server.setRequestHandler("tools/list", (request) => {
      const page = Number(request.params?.cursor || 0);
      return {
        tools: [0, 1].map((n) => ({
          name: `tool_${String(page)}_${String(n)}`,
          inputSchema: { type: "object" as const },
        })),
        ...(page + 1 < count && { nextCursor: String(page + 1) }),
      };
    });
    return server;
  };
  const itxOf = (count: number) =>
    ({ fetch: createMcpHandler(pages(count)).fetch }) as unknown as LibraryItx;
  const three = await connectToMcp(itxOf(3), "https://paged.test/mcp", {}, noWebhook);
  expect((await three.listTools()).map((tool) => tool.name)).toEqual([
    "tool_0_0",
    "tool_0_1",
    "tool_1_0",
    "tool_1_1",
    "tool_2_0",
    "tool_2_1",
  ]);
  await three.close();
  // the connection lists its tools to name its methods: an endless listing fails at connect
  await expect(connectToMcp(itxOf(1000), "https://paged.test/mcp", {}, noWebhook)).rejects.toThrow(
    "exceeded listMaxPages (64)",
  );
});

function petshop() {
  const server = new McpServer({ name: "petshop", version: "1" });
  server.registerTool(
    "show_board",
    {
      title: "Show the board",
      inputSchema: z.object({ id: z.string() }),
      _meta: { ui: { resourceUri: VIEW } },
    },
    ({ id }) => ({
      content: [{ type: "text", text: `board ${id}` }],
      structuredContent: { id, pets: 3 },
    }),
  );
  server.registerTool("refuse", { _meta: { ui: { visibility: ["app"] } } }, () => ({
    content: [{ type: "text", text: "no pets today" }],
    isError: true,
  }));
  server.registerResource(
    "board",
    VIEW,
    { mimeType: "text/html;profile=mcp-app" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: HTML,
          _meta: { ui: { csp: { connectDomains: ["wss://petshop.iterate.com"] } } },
        },
      ],
    }),
  );
  server.registerResource("huge", "ui://petshop/huge.html", {}, async (uri) => ({
    contents: [{ uri: uri.href, text: "x".repeat(MCP_RESOURCE_MAX_CHARS + 1) }],
  }));
  return server;
}

/** A context's itx whose `fetch` reaches the fake server, and the bodies it was sent. */
function itxOfFake() {
  const handler = createMcpHandler(petshop);
  const sent: unknown[] = [];
  const itx = {
    fetch: async (request: Request) => {
      if (request.method === "POST") sent.push(await request.clone().json());
      return await handler.fetch(request);
    },
  } as unknown as LibraryItx;
  return { itx, sent };
}

const noWebhook = () => Promise.reject(new Error("no webhook in this test"));
