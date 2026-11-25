// sdk/mcp.ts — AN MCP SERVER OF A MIND'S CONFIG, AS A CLASS. The platform speaks MCP (the sign-in,
// JSON-RPC, the protocol's versions, skills); the config's code is a class with a method for each
// tool, and nothing of the protocol is in the config's worker.
//
//   // mcp.ts of a config repo
//   export class GuestbookMcp extends RpcTarget {
//     constructor(private person: Person) { super(); }
//     instructions() { return "The guestbook of this mind."; }
//     tools() {
//       return [{ name: "add_entry", description: "Write an entry.",
//                 inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
//     }
//     add_entry({ text }: { text: string }) { return addEntry(this.person, text); }
//   }
//
// TWO PLACES SERVE SUCH A CLASS:
//   - THE MIND'S OWN MCP SERVER, at its control-plane hostname, for members. The platform serves
//     it, with its tool `run`. A deploy's config may name a method of the config's class
//     (`mcpTarget`, iterate/mind-config) that answers the class for a client; what the class says
//     is added to the platform's defaults, and when it fails the defaults answer alone.
//   - ANY HOST OF THE MIND, from the config's `fetch`: `this.auth.mcpServer(request, { target })`
//     (./auth.ts) answers for `/mcp` and names the method that answers the class.
import { RpcTarget } from "cloudflare:workers";
import type { Person, Principal } from "../principal.ts";
import { codedError } from "../lib.ts";

/** The MCP client that asks, as it named itself (`clientInfo`), and who signed it in. The name
 *  is the client's own word: branch on it for wording, and decide no access by it. */
export type McpClient = {
  name?: string;
  version?: string;
  /** The person who signed the client in; a member of the mind has `member` too. */
  person?: Person;
  member?: Principal;
};

/** One tool, as MCP's `tools/list` describes it. `inputSchema` is JSON Schema for the one
 *  argument of the method that has the tool's name. */
export type McpToolDescription = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/** WHAT A CLASS MAY SAY. Every method is optional, and each may be async.
 *    - `instructions()`: what `initialize` tells the client's model.
 *    - `tools()`: the tools. A call of one calls the method that has its name, with the call's
 *      arguments. A string that comes back is the result's text; any other value is its JSON.
 *      On the mind's own server, an entry named `run` gives the platform's `run` its
 *      description, and nothing else of it.
 *    - `skills()`: a folder of skills (`import skills from "./skills/"`): each folder in it that
 *      has a `SKILL.md` is served by MCP's Skills extension, and as resources. */
export type McpServerTarget = {
  instructions?(): string | Promise<string>;
  tools?(): McpToolDescription[] | Promise<McpToolDescription[]>;
  skills?(): Record<string, string | Uint8Array> | Promise<Record<string, string | Uint8Array>>;
};

/** ONE CALL OF A CLASS, for the platform (`IterateConfigEntrypoint.mcpCall`): `host[target]` is
 *  called with `targetArgs` and answers the class; `method` is called on it with `args`. It
 *  reaches a method that the class declares, never a field and never `Object`'s own. A class
 *  that lacks the method answers undefined: the platform's default then stands.
 *
 *  `target` is a method that the CONFIG'S OWN class declares: the search stops at `base`, the
 *  SDK's class, so no method of the platform's (a delivery hook, `fetch` of the base) is a
 *  target. */
export async function callMcpTarget(
  host: object,
  base: object,
  target: string,
  targetArgs: unknown[],
  method: string,
  args: unknown[],
): Promise<unknown> {
  const make = declaredMethod(host, target, base);
  if (!make) throw codedError("NOT_A_METHOD", `the config has no method ${target}`);
  const made: unknown = await Reflect.apply(make, host, targetArgs);
  if (!(made instanceof RpcTarget))
    throw codedError(
      "NOT_A_METHOD",
      `${target}() must answer an RpcTarget: the MCP server's class`,
    );
  const call = declaredMethod(made, method);
  if (!call) return undefined;
  return await Reflect.apply(call, made, args);
}

/** The method `name` that the class of `value` declares, below `Object`, `RpcTarget` and
 *  `base` (a class's prototype). */
function declaredMethod(value: object, name: string, base?: object) {
  for (
    let prototype: unknown = Object.getPrototypeOf(value);
    prototype &&
    prototype !== Object.prototype &&
    prototype !== RpcTarget.prototype &&
    prototype !== base;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    if (!Object.hasOwn(prototype, name)) continue;
    const member = Object.getOwnPropertyDescriptor(prototype, name)?.value as unknown;
    return typeof member === "function" && name !== "constructor"
      ? (member as (...args: unknown[]) => unknown)
      : undefined;
  }
  return undefined;
}
