// The default config's Cloudflare connection (core/configs/default/cloudflare.ts): the call of
// Cloudflare's MCP server with the token that the stack keeps in the vault.
import { expect, test } from "vitest";
import { cloudflareForAgent } from "../../configs/default/cloudflare.ts";

test("a tool of Cloudflare's MCP server is called with the vault's token as a placeholder, never a value", async () => {
  const mind = mindWith({ set: true });

  expect(await cloudflareForAgent(mind.itx, "execute", { code: "async () => 1" })).toEqual({
    answered: "execute",
  });

  expect(mind).toMatchObject({
    dialed: [
      {
        url: "https://mcp.cloudflare.com/mcp",
        headers: {
          authorization: 'Bearer getSecret("/secrets/cloudflare", { field: "token" })',
        },
      },
    ],
    called: [["execute", { code: "async () => 1" }]],
  });
});

test("a mind with no token says so and how it gets one, and dials nothing", async () => {
  const mind = mindWith({ set: false });

  await expect(cloudflareForAgent(mind.itx, "whoami")).rejects.toThrow(
    "This mind has no Cloudflare connection: /secrets/cloudflare is not set.",
  );

  expect(mind).toMatchObject({ dialed: [], called: [] });
});

test("code that names a destination path is refused before anything is dialed: such a destination sends the account's data away for good", async () => {
  for (const code of [
    "async () => cloudflare.request({ method: 'POST', path: `/accounts/${accountId}/workers/observability/destinations`, body })",
    "async () => cloudflare.request({ method: 'POST', path: `/accounts/${accountId}/alerting/v3/destinations/webhooks` })",
    "async () => cloudflare.request({ method: 'POST', path: '/accounts/x/logpush/jobs' })",
  ]) {
    const mind = mindWith({ set: true });
    await expect(cloudflareForAgent(mind.itx, "execute", { code })).rejects.toThrow(
      "makes a lasting export",
    );
    expect(mind).toMatchObject({ dialed: [], called: [] });
  }
});

/** A mind whose vault holds `/secrets/cloudflare` or not, with what was dialed and called. */
function mindWith({ set }: { set: boolean }) {
  const dialed: { url: string; headers: Record<string, string> }[] = [];
  const called: [string, Record<string, unknown> | undefined][] = [];
  return {
    dialed,
    called,
    itx: {
      secrets: { describe: async (path: string) => ({ path, set }) },
      connectToMcp: async (url: string, options: { headers: Record<string, string> }) => {
        dialed.push({ url, headers: options.headers });
        return {
          callTool: async (name: string, args?: Record<string, unknown>) => {
            called.push([name, args]);
            return { answered: name };
          },
        };
      },
    },
  };
}
