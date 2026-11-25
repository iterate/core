// workers-mcp-call.test.ts — `mcpCall` of a loaded worker (iterate/sdk
// `IterateConfigEntrypoint.mcpCall`) names the client and the person who asks in its arguments.
// So only the platform's own MCP server reaches it (`Caller.mcpServer`): a member's script, a
// page's session and loaded code are refused before any code loads.
import type { InvokeHandle } from "iterate/expression";
import { expect, test } from "vitest";
import type { Caller } from "../caller.ts";
import { workersRoot } from "./built-ins.ts";

test("mcpCall of a loaded worker is refused to every caller but the platform's MCP server", async () => {
  const member = { actor: "user_owner", email: "owner@example.com" };
  const callers: Caller[] = [
    { principal: member },
    { principal: member, via: { appPage: "dash.example.com" } },
    { principal: null, app: true },
    { principal: null, app: true, config: true },
    { principal: null, platform: true },
    { principal: member, runsRow: true },
  ];
  for (const caller of callers)
    await expect(mcpCallAs(caller), JSON.stringify(caller)).rejects.toThrow(
      "only the platform's MCP server calls it",
    );
  // the platform's MCP server gets past the refusal: it fails later, where this test has no
  // worker loader, with another error
  await expect(mcpCallAs({ principal: member, mcpServer: true })).rejects.not.toThrow(
    "only the platform's MCP server calls it",
  );
});

/** One `workers.get(spec).mcpCall(...)` as `caller`, with a client of the caller's own making. */
async function mcpCallAs(caller: Caller) {
  const workers = workersRoot({
    path: "/",
    iterateContextName: "root",
    itxEntrypoint: () => {
      throw new Error("no code is loaded in this test");
    },
    invoke: () => Promise.reject(new Error("no call is made in this test")),
    caller: () => caller,
    delivery: () => undefined,
    cause: () => undefined,
    namedWorker: () => Promise.reject(new Error("no worker is named in this test")),
  });
  const handle = workers.get({
    source: { "worker.js": "export default {}" },
  }) as unknown as InvokeHandle;
  return handle.invoke([
    [
      "mcpCall",
      "mcp",
      [{ person: { userId: "user_victim", email: "victim@example.com" } }],
      "tools",
      [],
    ],
  ]);
}
