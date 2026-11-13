// cloudflare.ts — THE MIND'S CLOUDFLARE CONNECTION (AGENTS.md, "Cloudflare"): Cloudflare's own MCP
// server, called with the API token of the mind's own account. A stack whose config says
// `cloudflareToken: true` keeps that token in the vault at `/secrets/cloudflare`. With it the
// mind's agents debug, profile and configure what the account runs (core/alchemy README, "The
// mind's Cloudflare token", says what it may do).
//
// Two things here: the call an agent makes (`cloudflareForAgent`, `itx.config.cloudflare`), and
// the connection's card on the Dash's Integrations page (`cloudflareConnectionEvent`, which
// worker.ts calls for every event). The card is made true at each publish of this repo
// (`mind/worker-updated`) and when the secret is set or deleted: with the secret, the mind
// connects to the MCP server and asks `whoami`, so "Connected" is what the server answered at
// that time, and the row says when; without it, the card says how to get one.
import { jsonEqual } from "iterate/lib";
import { z } from "zod";

const CLOUDFLARE_TOKEN_SECRET = "/secrets/cloudflare";
const CLOUDFLARE_MCP_SERVER = "https://mcp.cloudflare.com/mcp";
/** The token goes as a placeholder, which the vault fills in on the way out. */
const AUTHORIZATION = `Bearer getSecret("${CLOUDFLARE_TOKEN_SECRET}", { field: "token" })`;
/** The paths of Cloudflare's API that make a lasting export of the account's data to an address:
 *  an observability destination, a notification webhook, a Logpush job. This call refuses code
 *  that names one. It reads the code's text, so a path built from pieces passes: it slows an agent
 *  and stops no one. The token itself, through `itx.fetch`, is not guarded at all. */
const EXPORTS = /observability\/destinations|alerting\/v3\/destinations|logpush\/jobs/;

/** What `cloudflareForAgent` needs of the mind's root. */
type CloudflareCallItx = {
  secrets: { describe(path: string): Promise<{ set: boolean }> };
  connectToMcp(
    url: string,
    options: { headers: Record<string, string> },
  ): Promise<{ callTool(name: string, args?: Record<string, unknown>): Promise<unknown> }>;
};

/** `itx.config.cloudflare(tool, args)`: one tool of Cloudflare's MCP server (`execute`, `search`,
 *  `docs`, `whoami`). */
export async function cloudflareForAgent(
  itx: CloudflareCallItx,
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
  const cloudflare = await itx.connectToMcp(CLOUDFLARE_MCP_SERVER, {
    headers: { authorization: AUTHORIZATION },
  });
  return await cloudflare.callTool(tool, args);
}

/** The card's name in the registry, and its one row's. */
const CARD = "cloudflare";
const ROW = "account";
/** The longest wait for the server at a check: a publish's hooks wait for it. */
const CHECK_MS = 20_000;

const DESCRIPTION =
  "Cloudflare's MCP server, with an API token of this mind's own account: agents read logs and traces, profile Workers, and change Workers, their storage, DNS records, routes and settings. An agent calls itx.config.cloudflare(tool, args).";

/** `whoami` of Cloudflare's MCP server, for an account token: `{ id: "account:<id>", name }`. */
const WhoAmI = z.object({ id: z.string().min(1), name: z.string().min(1) });

/** The registry's state, as far as this file reads it (iterate/integrations). */
const Registry = z.object({
  integrations: z.record(z.string(), z.unknown()).default({}),
  connections: z.record(z.string(), z.unknown()).default({}),
});

export type CloudflareConnectionEvent = { type: string; path: string; payload?: unknown };

/** A publish of this repo, or the root's fact that `/secrets/cloudflare` was set or deleted, makes
 *  the card true; any other event does nothing. */
export async function cloudflareConnectionEvent(
  itx: CloudflareItx,
  event: CloudflareConnectionEvent,
): Promise<void> {
  if (event.path !== "/") return;
  const published = event.type === "events.iterate.com/mind/worker-updated";
  const secretChanged =
    (event.type === "events.iterate.com/secret/set" ||
      event.type === "events.iterate.com/secret/deleted") &&
    z.object({ path: z.string() }).safeParse(event.payload).data?.path === CLOUDFLARE_TOKEN_SECRET;
  if (published || secretChanged) await keepCard(itx);
}

/** The card and its row, made true. Only what differs from the registry is appended. */
async function keepCard(itx: CloudflareItx): Promise<void> {
  const registry = itx.cd("/integrations");
  const { state } = await registry.facets
    .get<{ snapshot(): Promise<{ state: unknown }> }>("integration")
    .snapshot();
  const { integrations, connections } = Registry.parse(state);
  const held = (await itx.secrets.describe(CLOUDFLARE_TOKEN_SECRET)).set;
  const check = held ? await checkConnection(itx) : null;
  const icon = { routingSlug: "dash", path: "/brands/cloudflare.svg" };
  let card: Record<string, unknown>;
  let row: Record<string, unknown> | null = null;
  if (!check) {
    const cloud = await itx.secrets.cloud().catch(() => null);
    card = {
      title: "Cloudflare",
      description: DESCRIPTION,
      icon,
      status: {
        kind: "attention",
        text: cloud
          ? "Not connected. Run “Update iterate” on this deployment in iterate Cloud."
          : "Not connected. The stack's config must say cloudflareToken: true; deploy it again.",
      },
      actions: cloud ? [{ label: "Open iterate Cloud", url: `${cloud.origin}/deployments` }] : [],
    };
  } else {
    card = {
      title: "Cloudflare",
      description: DESCRIPTION,
      icon,
      status: check.account
        ? { kind: "ok", text: "Connected" }
        : { kind: "error", text: "The MCP server did not answer the last check" },
      actions: [{ label: "Manage", routingSlug: "dash", path: "/?page=secrets" }],
    };
    row = {
      account: check.account?.name.slice(0, 200) || "Cloudflare account",
      status: check.account ? { kind: "ok" } : { kind: "error", text: check.error.slice(0, 200) },
      details: {
        ...(check.account && { "Account id": check.account.id.slice(0, 200) }),
        Server: CLOUDFLARE_MCP_SERVER,
        Use: "itx.config.cloudflare(tool, args): tools execute, search, docs and whoami",
        Checked: `${check.at}: ${check.account ? "whoami answered" : "failed"}`,
        Secret: CLOUDFLARE_TOKEN_SECRET,
      },
      actions: [],
    };
  }
  // the card before its row: a row stands under a card that exists
  if (!jsonEqual(integrations[CARD], card))
    await registry.append({
      type: "events.iterate.com/integration/configured",
      payload: { integration: CARD, card },
    });
  const key = `${CARD}/${ROW}`;
  if (row ? !jsonEqual(connections[key], row) : key in connections)
    await registry.append({
      type: "events.iterate.com/integration/connection-configured",
      payload: { integration: CARD, connection: ROW, row },
    });
}

/** One check of the connection: the MCP server, called with the token, names the account. */
async function checkConnection(itx: CloudflareItx): Promise<
  | { at: string; account: z.infer<typeof WhoAmI>; error?: never }
  | {
      at: string;
      account?: never;
      error: string;
    }
> {
  const at = new Date().toISOString();
  let fail: (error: Error) => void = () => {};
  const late = new Promise<never>((_, reject) => (fail = reject));
  const timer = setTimeout(() => fail(new Error(`no answer in ${CHECK_MS / 1000} s`)), CHECK_MS);
  const ask = async () => {
    const server = await itx.connectToMcp(CLOUDFLARE_MCP_SERVER, {
      headers: { authorization: AUTHORIZATION },
    });
    try {
      return WhoAmI.parse(await server.callTool("whoami", {}));
    } finally {
      await server.close().catch(() => {});
    }
  };
  try {
    const account = await Promise.race([ask(), late]);
    return { at, account: { ...account, id: account.id.replace(/^account:/, "") } };
  } catch (error) {
    return {
      at,
      error: z.object({ message: z.string() }).safeParse(error).data?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** What the card needs of the mind's root. */
export type CloudflareItx = {
  secrets: {
    describe(path: string): Promise<{ set: boolean }>;
    cloud(): Promise<{ origin: string } | null>;
  };
  connectToMcp(
    url: string,
    options: { headers: Record<string, string> },
  ): Promise<{
    callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  }>;
  cd(path: string): {
    append(event: { type: string; payload: Record<string, unknown> }): Promise<unknown>;
    facets: { get<T>(name: string): T };
  };
};
