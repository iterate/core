// cloudflare.ts — THE MIND'S CLOUDFLARE CONNECTION (AGENTS.md, "Cloudflare"): Cloudflare's own MCP
// server, called with the API token of the mind's own account. A stack whose config says
// `cloudflareToken: true` keeps that token in the vault at `/secrets/cloudflare`. It reads the
// account and deploys nothing.

const CLOUDFLARE_TOKEN_SECRET = "/secrets/cloudflare";
/** The paths of Cloudflare's API that make a lasting export of the account's data to an address:
 *  an observability destination, a notification webhook, a Logpush job. The token may make an
 *  observability destination (it needs that group to read logs), so this call refuses code that
 *  names one. It reads the code's text, so a path built from pieces passes: it slows an agent and
 *  stops no one. The token itself, through `itx.fetch`, is not guarded at all. */
const EXPORTS = /observability\/destinations|alerting\/v3\/destinations|logpush\/jobs/;

/** `itx.config.cloudflare(tool, args)`: one tool of Cloudflare's MCP server (`execute`, `search`,
 *  `docs`, `whoami`). The token goes as a placeholder, which the vault fills in on the way out. */
export async function cloudflareForAgent(
  itx: CloudflareItx,
  tool: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (!(await itx.secrets.describe(CLOUDFLARE_TOKEN_SECRET)).set)
    throw new Error(
      `This mind has no Cloudflare connection: ${CLOUDFLARE_TOKEN_SECRET} is not set. Its stack's config must say cloudflareToken: true, which an owner turns on in iterate Cloud.`,
    );
  if (EXPORTS.test(JSON.stringify(args || {})))
    throw new Error(
      "This call makes a lasting export of the account's data (an observability destination, a webhook, a Logpush job), which this connection does not make. Ask a member to set it up in Cloudflare's dashboard.",
    );
  const cloudflare = await itx.connectToMcp("https://mcp.cloudflare.com/mcp", {
    headers: {
      authorization: `Bearer getSecret("${CLOUDFLARE_TOKEN_SECRET}", { field: "token" })`,
    },
  });
  return await cloudflare.callTool(tool, args);
}

/** What the call needs of the mind's root. */
type CloudflareItx = {
  secrets: { describe(path: string): Promise<{ set: boolean }> };
  connectToMcp(
    url: string,
    options: { headers: Record<string, string> },
  ): Promise<{ callTool(name: string, args?: Record<string, unknown>): Promise<unknown> }>;
};
