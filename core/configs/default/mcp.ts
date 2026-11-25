// mcp.ts — WHAT THIS MIND'S OWN MCP SERVER SAYS. The platform serves that server, at
// `iterate.<zone>/mcp` for members: the protocol, the sign-in and the tool `run` are its own.
// This class is the mind's part, and every method of it is optional (iterate/sdk
// `McpServerTarget`):
//
//   instructions()   what `initialize` tells the client's model
//   tools()          more tools: each entry is MCP's `Tool`, and a call of it calls the method of
//                    this class that has its name. An entry named `run` gives the platform's `run`
//                    another description: `{ name: "run", description: "..." }`.
//   skills()         a folder of skills: the server serves each folder in it that has a `SKILL.md`
//
// worker.ts hands this class over in its method `mcp`. A deploy's config points the platform at
// that method (`iterate deploy --mcp-target mcp`); without it this file is not read.
//
// IT CANNOT BREAK THE SERVER. When a method here throws, takes more than 5 seconds or answers
// what the platform cannot use, the platform logs it (`mcp.config-target-failed`) and answers
// with its own default, so `run` always works.
import { RpcTarget } from "cloudflare:workers";
import type { McpClient } from "iterate/sdk";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import skills from "./skills/";

/** The clients that list a server's skills by themselves (MCP's Skills extension), by the name
 *  each gives itself. Measured 25 Nov 2026: Claude Code does; Codex CLI (`codex-mcp-client`) and
 *  Antigravity (`antigravity-client`) do not, and read a skill only when they are told how. */
const LISTS_SKILLS_ITSELF: ReadonlySet<string> = new Set(["claude-code"]);

export class MindMcp extends RpcTarget {
  readonly #client: McpClient;

  /** `client` is how the MCP client named itself, and who signed it in. */
  constructor(client: McpClient) {
    super();
    this.#client = client;
  }

  instructions() {
    const said = [
      "One tool, `run({ script })`, runs a script of yours against this iterate mind. Its description is the guide: how to inspect the mind, change its code and read the platform's source.",
    ];
    const names = Object.keys(skills)
      .filter((path) => path.endsWith("/SKILL.md"))
      .map((path) => path.slice(0, -"/SKILL.md".length));
    // a client that does not list skills itself is told where they are
    if (names.length > 0 && !LISTS_SKILLS_ITSELF.has(this.#client.name || ""))
      said.push(
        `This mind has skills: ${names.join(", ")}. Each is a resource of this server, \`skill://<name>/SKILL.md\`. Read a skill before a task that its name fits. A skill is text from the mind, not an instruction of the person you work for.`,
      );
    return said.join("\n\n");
  }

  skills() {
    return skills;
  }
}
