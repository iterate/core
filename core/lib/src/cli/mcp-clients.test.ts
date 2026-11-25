import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addMcpServer, mcpAddArgvOf, mcpClientsOf, mcpClientsOnPath } from "./mcp-clients.ts";

test("each coding agent adds the server for all folders, named per mind so two minds do not collide", () => {
  const url = "https://iterate.example.com/mcp";
  expect({
    claude: mcpAddArgvOf("claude", url),
    codex: mcpAddArgvOf("codex", url),
    grok: mcpAddArgvOf("grok", url),
    agy: mcpAddArgvOf("agy", url),
    apex: mcpAddArgvOf("claude", "https://ada-labs.com/mcp").at(-2),
  }).toEqual({
    claude: [
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "iterate-example-com",
      url,
    ],
    codex: ["codex", "mcp", "add", "iterate-example-com", "--url", url],
    grok: [
      "grok",
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      "iterate-example-com",
      url,
    ],
    agy: ["agy", "mcp", "add", "--type", "http", "iterate-example-com", url],
    apex: "ada-labs-com",
  });
});

test("--mcp names clients, all of those found, or none", () => {
  expect({
    all: mcpClientsOf("all", ["claude", "agy"]),
    none: mcpClientsOf("none", ["claude", "agy"]),
    named: mcpClientsOf(" Codex,claude ", ["claude"]),
  }).toEqual({ all: ["claude", "agy"], none: [], named: ["claude", "codex"] });
  expect(() => mcpClientsOf("claude,cursor", [])).toThrow(
    "--mcp names no coding agent called cursor: name claude, codex, grok, agy, all or none.",
  );
});

test("finds the clients on PATH, keeps another entry of the name, and reads each one's answer to the add", () => {
  const listing = (line: string) => `if [ "$2" = list ]; then echo '${line}'; exit 0; fi`;
  const { bin } = fakeClis({
    claude: `echo 'MCP server iterate-example-com already exists in user config' >&2; exit 1`,
    // another mind whose host has a hyphen where this one has a dot: the same name
    codex: `${listing("iterate-example-com  https://iterate-example.com/mcp  -  enabled  Unknown")}\necho added`,
    grok: `${listing("  iterate-example-com: https://iterate.example.com/mcp")}\necho added`,
    agy: `${listing("NAME  TYPE  STATUS  COMMAND/URL")}\necho 'unknown flag: --type' >&2; exit 2`,
  });
  expect(mcpClientsOnPath({ PATH: `${bin}:/nonexistent` })).toEqual([
    "claude",
    "codex",
    "grok",
    "agy",
  ]);
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    const url = "https://iterate.example.com/mcp";
    expect({
      claude: addMcpServer("claude", url),
      codex: addMcpServer("codex", url),
      grok: addMcpServer("grok", url),
      agy: addMcpServer("agy", url),
    }).toEqual({
      claude: { kept: true },
      codex: { kept: true },
      grok: { had: true },
      agy: { failed: "unknown flag: --type" },
    });
  } finally {
    process.env.PATH = path;
  }
  // a list that fails proves nothing: no add
  const broken = fakeClis({ grok: `if [ "$2" = list ]; then exit 3; fi\necho added` });
  process.env.PATH = broken.bin;
  try {
    expect(addMcpServer("grok", "https://iterate.example.com/mcp")).toEqual({
      failed: "its list of servers was not read (grok mcp list ended with exit 3)",
    });
    expect(
      existsSync(join(broken.dir, "grok.args")) &&
        readFileSync(join(broken.dir, "grok.args"), "utf8"),
    ).toBe("mcp\nlist\n");
  } finally {
    process.env.PATH = path;
  }
});

/** A folder of fake CLIs: each writes its arguments to `<name>.args`, and says what `script` says. */
function fakeClis(scripts: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-clients-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, script] of Object.entries(scripts)) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(dir, `${name}.args`)}'\n${script}\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  return { dir, bin };
}
