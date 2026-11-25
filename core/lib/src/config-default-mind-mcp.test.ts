// The default config's part of the mind's own MCP server (core/configs/default/mcp.ts), as the
// platform reaches it: through `mcpCall` of the config's class (./sdk/mcp.ts).
import { RpcTarget } from "cloudflare:workers";
import { expect, test } from "vitest";
import { MindMcp } from "../../configs/default/mcp.ts";
import Config from "../../configs/default/worker.ts";
import { callMcpTarget } from "./sdk/mcp.ts";

test("worker.ts hands the platform the class in its method mcp, with the mind's skills", async () => {
  const worker = Object.create(Config.prototype) as Config;
  const ask = (client: object, method: string) => worker.mcpCall("mcp", [client], method, []);
  const skills = (await ask({}, "skills")) as Record<string, unknown>;
  expect(Object.keys(skills).sort()).toEqual(["README.md", "mind-skills/SKILL.md"]);
  // the class says nothing of the tools: the platform's own `run` and its description stand
  expect(await ask({}, "tools")).toBeUndefined();
  // a platform method answers no MCP server, and a name that is no method is refused
  // a method that the platform calls by itself is no target: a delivery hook would be handed
  // the client as its event
  for (const target of ["fetch", "deliverEvent", "processEvent", "processMindEvent", "mcpCall"])
    expect(() => worker.mcpCall(target, [{}], "instructions", []), target).toThrow(
      "platform's method",
    );
  await expect(worker.mcpCall("nothing", [{}], "instructions", [])).rejects.toThrow("no method");
});

test("a client that does not list skills itself is told where they are; Claude Code is not", async () => {
  const said = (name?: string) => new MindMcp({ name }).instructions();
  expect(said("claude-code")).not.toContain("skill://");
  for (const name of ["codex-mcp-client", "antigravity-client", undefined])
    expect(said(name)).toMatch(/skills: mind-skills\..*skill:\/\/<name>\/SKILL\.md/);
});

test("a call reaches a method that the class declares, and nothing else of it", async () => {
  class Server extends RpcTarget {
    secret = "a field";
    greet(name: string) {
      return `hello ${name}`;
    }
  }
  // the SDK's class: what it declares is no target, whatever it answers
  class Base {
    ofTheBase() {
      return new Server();
    }
  }
  class Host extends Base {
    make() {
      return new Server();
    }
    plain() {
      return { greet: () => "no class" };
    }
  }
  const call = (target: string, method: string, args: unknown[] = []) =>
    callMcpTarget(new Host(), Base.prototype, target, [], method, args);
  expect(await call("make", "greet", ["ada"])).toBe("hello ada");
  // a field, `constructor`, what every object has, and a missing method: no call, and undefined
  for (const method of ["secret", "constructor", "toString", "hasOwnProperty", "missing"])
    expect(await call("make", method)).toBeUndefined();
  await expect(call("plain", "greet")).rejects.toThrow("must answer an RpcTarget");
  await expect(call("ofTheBase", "greet", ["ada"])).rejects.toThrow("no method ofTheBase");
});
