// THE CODING AGENTS ON THIS COMPUTER THAT CAN KEEP A MIND'S MCP SERVER. Each one's own CLI adds the
// server for all of the person's folders, under the mind's name (iterate/mind-api `mindMcpNameOf`),
// so two minds do not collide. None of them gets a token from here: each signs in itself on its
// first use, at the issuer that the server's protected-resource metadata names, and a person who
// is signed in to the mind in that browser approves it with one button.
//
// The commands, as each CLI's `mcp add --help` gave them on 25 Nov 2026 (claude 2.1.332, codex
// 0.172.0, grok 1.0.92, agy 1.5.17). Claude Code refuses a name it has already; the others
// replace it, so for them the entry of that name is read first (`list`: each prints a server's
// name and URL on one line), and one at another URL is kept: two minds whose hosts differ by a dot
// against a hyphen share a name. `iterate mcp <client> --exec`, which a person runs by choice,
// replaces it.
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { mindMcpNameOf } from "../mind-api.ts";

type McpClientSpec = {
  /** The product's name, as the person knows it. */
  title: string;
  argv: (name: string, url: string) => string[];
  /** How the person signs the client in to the server, once, in a few words. */
  signIn: (name: string) => string;
  /** The command that lists its servers, for a CLI whose add replaces one of the same name. */
  list?: string[];
  /** The command that takes a server of that name away. */
  remove: (name: string) => string;
};

export const MCP_CLIENTS = {
  claude: {
    title: "Claude Code",
    argv: (name, url) => [
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      name,
      url,
    ],
    signIn: () => "/mcp",
    remove: (name) => `claude mcp remove --scope user ${name}`,
  },
  codex: {
    title: "Codex",
    argv: (name, url) => ["codex", "mcp", "add", name, "--url", url],
    signIn: (name) => `codex mcp login ${name}`,
    list: ["codex", "mcp", "list"],
    remove: (name) => `codex mcp remove ${name}`,
  },
  grok: {
    title: "Grok",
    argv: (name, url) => [
      "grok",
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      name,
      url,
    ],
    signIn: (name) => `/mcp, pick ${name}, press i`,
    list: ["grok", "mcp", "list"],
    remove: (name) => `grok mcp remove --scope user ${name}`,
  },
  agy: {
    title: "Antigravity",
    argv: (name, url) => ["agy", "mcp", "add", "--type", "http", name, url],
    signIn: () => "it asks at its first use",
    list: ["agy", "mcp", "list"],
    remove: (name) => `agy mcp remove ${name}`,
  },
} satisfies Record<string, McpClientSpec>;

export type McpClient = keyof typeof MCP_CLIENTS;

// Object.keys answers string[]; the keys of this literal object are exactly McpClient
const MCP_CLIENT_NAMES = Object.keys(MCP_CLIENTS) as McpClient[];

/** The command that adds the MCP server at `mcpUrl` to `client`, named after its host. */
export const mcpAddArgvOf = (client: McpClient, mcpUrl: string) =>
  MCP_CLIENTS[client].argv(mindMcpNameOf(new URL(mcpUrl).hostname), mcpUrl);

/** The clients whose command is on `PATH`, in the table's order. */
export function mcpClientsOnPath(env: Record<string, string | undefined> = process.env) {
  const dirs = (env.PATH || "").split(delimiter).filter(Boolean);
  const runnable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  return MCP_CLIENT_NAMES.filter((client) =>
    dirs.some((dir) => suffixes.some((suffix) => runnable(join(dir, client + suffix)))),
  );
}

/** The clients that `--mcp` names: `all` (each one found), `none`, or names with a comma between. */
export function mcpClientsOf(flag: string, found: McpClient[]): McpClient[] {
  const words = flag
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (words.includes("none")) return [];
  if (words.includes("all")) return found;
  const unknown = words.filter((word) => !(word in MCP_CLIENTS));
  if (unknown.length)
    throw new Error(
      `--mcp names no coding agent called ${unknown.join(", ")}: name ${MCP_CLIENT_NAMES.join(", ")}, all or none.`,
    );
  return MCP_CLIENT_NAMES.filter((client) => words.includes(client));
}

/** What `client`'s own list says of a server called `name`: `none`, `same` (one at `url`),
 *  `other` (one at another URL, or with none on its line), or `unread` with why the list failed,
 *  which proves nothing. A client whose add refuses a taken name has no list here: `none`. */
function existingMcpServerOf(
  client: McpClient,
  name: string,
  url: string,
): { none: true } | { same: true } | { other: true } | { unread: string } {
  const spec: McpClientSpec = MCP_CLIENTS[client];
  if (!spec.list) return { none: true };
  const [command, ...args] = spec.list;
  const run = spawnSync(command!, args, { encoding: "utf8", timeout: 60_000 });
  if (run.error) return { unread: run.error.message };
  if (run.status !== 0) return { unread: `${spec.list.join(" ")} ended with exit ${run.status}` };
  const line = `${run.stdout || ""}`
    .split("\n")
    .find((row) => row.trim().split(/\s+/)[0]?.replace(/:$/, "") === name);
  if (!line) return { none: true };
  return line.match(/https?:\/\/\S+/)?.[0] === url ? { same: true } : { other: true };
}

/** Add the MCP server at `mcpUrl` to `client`, by its own CLI: `added`; `had` (an entry of that
 *  name at this URL); `kept` (another entry of that name, which stays); or `failed` with the CLI's
 *  own words. A list that cannot be read adds nothing: the name may be taken. */
export function addMcpServer(
  client: McpClient,
  mcpUrl: string,
): { added: true } | { had: true } | { kept: true } | { failed: string } {
  const existing = existingMcpServerOf(client, mindMcpNameOf(new URL(mcpUrl).hostname), mcpUrl);
  if ("same" in existing) return { had: true };
  if ("other" in existing) return { kept: true };
  if ("unread" in existing)
    return { failed: `its list of servers was not read (${existing.unread})` };
  const [command, ...args] = mcpAddArgvOf(client, mcpUrl);
  const run = spawnSync(command!, args, { encoding: "utf8", timeout: 60_000 });
  if (run.error) return { failed: run.error.message };
  if (run.status === 0) return { added: true };
  const said = `${run.stdout || ""}${run.stderr || ""}`.trim();
  if (client === "claude" && /already exists/i.test(said)) return { kept: true };
  return { failed: said.split("\n").at(-1) || `exit ${run.status}` };
}
