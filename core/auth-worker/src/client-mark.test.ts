// Which built-in mark a client gets, and the tile a page draws for it.
import { expect, test } from "vitest";
import { clientTile, knownMarkOf } from "./client-mark.ts";

const loopback = { redirectUri: "http://127.0.0.1:1455/callback", redirectHost: "127.0.0.1:1455" };

test.for([
  // by its verified domain: Codex's client ID is a document on chatgpt.com
  { mark: "openai", name: "An app", clientDomain: "chatgpt.com", ...loopback },
  { mark: "openai", name: "An app", clientDomain: "platform.openai.com", ...loopback },
  { mark: "claude", name: "An app", clientDomain: "claude.ai", ...loopback },
  // by where its access goes
  {
    mark: "openai",
    name: "An app",
    redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    redirectHost: "chatgpt.com",
  },
  {
    mark: "claude",
    name: "An app",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    redirectHost: "claude.ai",
  },
  { mark: "cursor", name: "An app", redirectUri: "cursor://x/callback", redirectHost: "" },
  { mark: "zed", name: "An app", redirectUri: "zed://oauth/callback", redirectHost: "" },
  { mark: "windsurf", name: "An app", redirectUri: "windsurf://x/callback", redirectHost: "" },
  // by the name it gives, as a device does
  { mark: "openai", name: "Codex", ...loopback },
  { mark: "openai", name: "codex-mcp-client", ...loopback },
  { mark: "openai", name: "ChatGPT", ...loopback },
  { mark: "openai", name: "OpenAI Codex", ...loopback },
  { mark: "claude", name: "Claude Code", ...loopback },
  { mark: "cursor", name: "Cursor", ...loopback },
  { mark: "zed", name: "Zed", ...loopback },
  { mark: "windsurf", name: "Windsurf", ...loopback },
  { mark: "gemini", name: "Gemini CLI MCP Client", ...loopback },
  { mark: "gemini", name: "Google Gemini", ...loopback },
  { mark: "opencode", name: "opencode", ...loopback },
  // a fact outweighs a name: a client of chatgpt.com that calls itself Claude is OpenAI's
  { mark: "openai", name: "Claude Code", clientDomain: "chatgpt.com", ...loopback },
  // a name counts at its start, as a whole word
  { mark: null, name: "Not Codex", ...loopback },
  { mark: null, name: "My ChatGPT helper", ...loopback },
  { mark: null, name: "Codexa", ...loopback },
  { mark: null, name: "Zedd", ...loopback },
  // a host that only ends like a known one is another host
  {
    mark: null,
    name: "An app",
    redirectUri: "https://notchatgpt.com/x",
    redirectHost: "notchatgpt.com",
  },
  { mark: null, name: "An app", clientDomain: "chatgpt.com.example.org", ...loopback },
  // no free mark: its initials
  {
    mark: null,
    name: "Visual Studio Code",
    redirectUri: "https://vscode.dev/redirect",
    redirectHost: "vscode.dev",
  },
] as const)("the mark of $name ($clientDomain, $redirectHost) is $mark", ({ mark, ...client }) => {
  expect(knownMarkOf(client)).toBe(mark);
});

test("a tile is the mark in one svg, small for a row of a list, and never an outside image for a known client", () => {
  const codex = {
    name: "Codex",
    clientDomain: "chatgpt.com",
    logoUri: "https://chatgpt.com/logo.png",
    ...loopback,
  };
  const tile = clientTile(codex);
  expect(tile).toMatch(
    /^<div class="tile" data-client-mark="known" data-client="openai"><svg viewBox="[0-9. ]+" xmlns="http:\/\/www.w3.org\/2000\/svg" fill="currentColor"><path d="M[^"<>]+"\/><\/svg><\/div>$/,
  );
  expect(tile).not.toContain("<img");
  expect(clientTile(codex, { small: true })).toBe(
    tile.replace(`class="tile"`, `class="tile small"`),
  );
  expect(clientTile({ name: "Notes", ...loopback }, { small: true })).toBe(
    `<div class="tile small" data-client-mark="initials">NO</div>`,
  );
});
