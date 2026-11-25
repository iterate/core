// mcp.ts — THE GUESTBOOK'S OWN MCP SERVER, at /mcp on the app's host, for other agents: a class
// with a method for each tool. The platform serves it (iterate/sdk `auth.mcpServer`, which app.ts
// answers in `fetch`): it speaks MCP, and it signs a client's person in. None of that is here.
//
// How an agent signs in: its first call has no token, and gets a 401 that names the document at
// /.well-known/oauth-protected-resource/mcp (RFC 9728). That names the mind's sign-in, at its
// control-plane hostname, as the authorization server. The client registers there, its person
// signs in and consents, and the token it gets is good for this host alone. The platform checks
// the token on the way in and hands this class the person (`client.person`), never the token.
import { RpcTarget } from "cloudflare:workers";
import type { McpClient } from "iterate/sdk";
import type { Guestbook } from "./app.ts";

const TOOLS = [
  {
    name: "list_entries",
    description:
      "List the guestbook's entries: the approved ones, and your own that wait for a member's approval. A reply names the entry it answers in `replyTo`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_entry",
    description:
      "Write an entry in the guestbook as the signed-in person. It waits until a member of the mind approves it.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The entry, 1000 characters at most." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "reply_to_entry",
    description:
      "Answer an approved entry, by its `id` from list_entries. The reply waits for a member's approval like any entry.",
    inputSchema: {
      type: "object",
      properties: { entry: { type: "integer" }, text: { type: "string" } },
      required: ["entry", "text"],
      additionalProperties: false,
    },
  },
];

/** A call of a tool calls the method here that has the tool's name, with the call's arguments,
 *  which the platform has held to the tool's `inputSchema`. What a method returns is the tool's
 *  result; what it throws is the tool's error. */
export class GuestbookMcp extends RpcTarget {
  readonly #client: McpClient;
  readonly #book: Guestbook;

  constructor(client: McpClient, book: Guestbook) {
    super();
    this.#client = client;
    this.#book = book;
  }

  instructions() {
    return `The guestbook of this mind. You are signed in as ${this.#person().email}.`;
  }

  tools() {
    return TOOLS;
  }

  list_entries() {
    // a member is a person whom the platform also stamped as a member
    return this.#book.view({ person: this.#person(), member: Boolean(this.#client.member) });
  }

  add_entry(input: { text: string }) {
    return this.#write({ text: input.text });
  }

  reply_to_entry(input: { entry: number; text: string }) {
    return this.#write({ text: input.text, replyTo: input.entry });
  }

  async #write(input: { text: string; replyTo?: number }) {
    const written = await this.#book.write(this.#person(), input);
    if ("refused" in written) throw new Error(written.refused);
    return written;
  }

  /** The person who signed the client in. The platform lets nobody else reach this server
   *  (`for: "people"` in app.ts). */
  #person() {
    const { person } = this.#client;
    if (!person || person.method === "guest" || person.method === "mind")
      throw new Error("Sign in with an address to use the guestbook.");
    return person;
  }
}
