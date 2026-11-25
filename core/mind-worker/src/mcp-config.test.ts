// mcp-config.test.ts — an MCP server whose tools, instructions and skills a config's class gives
// (./mcp.ts), and what the server answers when that class fails.
import { expect, test, vi } from "vitest";
import { serveAppMcp, serveMcp, type McpConfigCall } from "./mcp.ts";

test("who may connect to an app's server is the platform's decision, before the class is asked anything", async () => {
  const calls: unknown[][] = [];
  const config = guestbook(calls);
  const challenge =
    'Bearer resource_metadata="https://guestbook.example.org/.well-known/oauth-protected-resource/mcp", scope="identity"';
  const guest = {
    userId: "guest_1",
    email: "" as const,
    name: "a guest",
    method: "guest" as const,
  };
  const cases: [string, Response, number][] = [
    ["nobody", await serve(config, post("tools/list"), { principal: null }), 401],
    [
      "nobody, at the probe",
      await serve(config, post("server/discover"), { principal: null }),
      400,
    ],
    ["a guest", await serve(config, post("tools/list"), { principal: null, person: guest }), 403],
    [
      "a person, at a members' server",
      await serve(config, post("tools/list"), { principal: null, person }, "members"),
      403,
    ],
    [
      "another site's page",
      await serve(config, post("tools/list", undefined, { origin: "https://evil.example" })),
      403,
    ],
    ["a GET", await serve(config, new Request("https://guestbook.example.org/mcp")), 405],
  ];
  expect(cases.map(([who, answer]) => [who, answer.status])).toEqual(
    cases.map(([who, , status]) => [who, status]),
  );
  expect(cases[0][1].headers.get("www-authenticate")).toBe(challenge);
  expect(calls).toEqual([]);

  // NOBODY'S BODY IS READ WHOLE, OR WAITED FOR. The probe is named in a header, and then no byte
  // is read. With no header, only a body that declares a small length is read.
  let pulled = 0;
  const streamed = (
    pull: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
    headers = {},
  ) =>
    new Request("https://guestbook.example.org/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          pull(controller);
        },
      }),
      // @ts-expect-error -- Node asks for it on a request with a stream as its body
      duplex: "half",
    });
  const endless = (controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
  const anonymous = (request: Request) => serve(config, request, { principal: null });
  // named in the header: 400, and the body is not asked for
  expect(await anonymous(streamed(endless, { "mcp-method": "server/discover" }))).toMatchObject({
    status: 400,
  });
  expect(pulled).toBeLessThanOrEqual(1);
  // a body of unknown length: not read at all
  pulled = 0;
  expect(await anonymous(streamed(endless))).toMatchObject({ status: 401 });
  expect(pulled).toBeLessThanOrEqual(1);
  // a declared length over the limit: not read
  const long = post("server/discover", { padding: "x".repeat(4096) });
  expect(await anonymous(long)).toMatchObject({ status: 401 });
  // a small declared body that sends more than it declared: the chunk past it is not decoded
  const probe = '{"jsonrpc":"2.0","id":1,"method":"server/discover"}';
  const lying = streamed(
    (controller) => controller.enqueue(new TextEncoder().encode(probe.padEnd(8192))),
    { "content-length": "64" },
  );
  expect(await anonymous(lying)).toMatchObject({ status: 401 });
  // a small declared body that never arrives: the answer comes after a second, not never
  vi.useFakeTimers();
  const stalled = anonymous(streamed(() => {}, { "content-length": "64" }));
  await vi.advanceTimersByTimeAsync(1100);
  vi.useRealTimers();
  expect(await stalled).toMatchObject({ status: 401 });
  // AS THE KERNEL HANDS IT OVER: the request is a copy, one branch of a tee whose other branch
  // (the one the config's fetch got) nobody reads or cancels. No refusal waits for that branch.
  for (const headers of [
    {},
    { "mcp-method": "server/discover" },
    { origin: "https://evil.example" },
  ]) {
    const original = streamed(endless, headers);
    const refused = await Promise.race([
      anonymous(original.clone()),
      new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 500)),
    ]);
    expect(refused, JSON.stringify(headers)).not.toBe("waited");
  }
  // and the small probe itself, with no header, is still recognized
  expect(await anonymous(post("server/discover"))).toMatchObject({ status: 400 });

  const metadata = await serve(
    config,
    new Request("https://guestbook.example.org/.well-known/oauth-protected-resource/mcp"),
    { principal: null },
  );
  expect(await metadata.json()).toEqual({
    resource: "https://guestbook.example.org",
    authorization_servers: ["https://iterate.example.org"],
    scopes_supported: ["identity"],
    bearer_methods_supported: ["header"],
  });
  // a member is taken at a members' server, and the class is told who asks
  const member_ = await serve(config, post("initialize", INIT), { principal: member }, "members");
  expect(member_).toMatchObject({ status: 200 });
  expect(calls.length).toBeGreaterThan(0);
});

test("an app's server: the class's instructions, tools and skills, and no run", async () => {
  const calls: unknown[][] = [];
  const config = guestbook(calls);
  const init = await app(config, "initialize", INIT);
  expect(init.result).toMatchObject({
    instructions: "The guestbook.",
    serverInfo: { name: "guestbook" },
    capabilities: {
      tools: {},
      resources: {},
      extensions: { "io.modelcontextprotocol/skills": {} },
    },
  });
  // the class is told how the client named itself
  expect(calls[0]).toEqual(["codex-mcp-client", "instructions"]);

  const list = await app(config, "tools/list");
  expect(list.result).toMatchObject({ tools: [{ name: "add_entry" }] });
  expect(list.result?.tools).toHaveLength(1);

  const called = await app(config, "tools/call", {
    name: "add_entry",
    arguments: { text: "hello" },
  });
  expect(called.result).toMatchObject({
    isError: false,
    content: [{ type: "text", text: '{"added":"hello"}' }],
  });
  // the SDK holds the arguments to the tool's schema before the class is called
  const refused = await app(config, "tools/call", { name: "add_entry", arguments: {} });
  expect(JSON.stringify(refused)).toMatch(/text|required|invalid/i);
  expect(calls.filter(([, method]) => method === "add_entry")).toHaveLength(1);

  const skills = await app(config, "skills/list");
  expect(skills.result).toMatchObject({
    resultType: "complete",
    skills: [
      { uri: "skill://tea/SKILL.md", frontmatter: { name: "tea", description: "Brew tea." } },
    ],
  });
  expect((await app(config, "skills/get", { uri: "skill://tea/SKILL.md" })).result).toMatchObject({
    skill: { uri: "skill://tea/SKILL.md" },
  });
  expect((await app(config, "resources/list")).result?.resources).toEqual([
    expect.objectContaining({ uri: "skill://tea/SKILL.md", name: "tea" }),
  ]);
  expect(
    (await app(config, "resources/read", { uri: "skill://tea/SKILL.md" })).result,
  ).toMatchObject({
    contents: [{ uri: "skill://tea/SKILL.md", text: SKILL_MD }],
  });
  // a file in no skill, a path that climbs, a skill that is not there: not found, with the URI
  for (const [method, uri] of [
    ["resources/read", "skill://README.md"],
    ["resources/read", "skill://tea/../../worker.ts"],
    ["skills/get", "skill://none/SKILL.md"],
  ])
    expect((await app(config, method, { uri })).error).toMatchObject({
      code: -32602,
      data: { uri },
    });
});

test("a tool of the class that throws is an isError result", async () => {
  const config = classOf({
    tools: () => [{ name: "fail" }],
    fail: () => {
      throw new Error("the tool broke");
    },
  });
  expect((await app(config, "tools/call", { name: "fail", arguments: {} })).result).toMatchObject({
    isError: true,
    content: [{ type: "text", text: "the tool broke" }],
  });
});

test("the mind's own server: the class describes run and adds to it; a class that fails leaves the defaults", async () => {
  const mind = (config: McpConfigCall | undefined, method: string, params?: unknown) =>
    serveMcp(
      post(method, params, {
        "x-itx-principal": JSON.stringify(member),
      }),
      () => Promise.reject(new Error("no file is read")),
      config,
    );
  // the stamp is the boundary's: without it this server answers 401, whatever the config says
  const unsigned = await serveMcp(
    post("tools/list"),
    () => Promise.reject(new Error("no")),
    guestbook(),
  );
  expect(unsigned).toMatchObject({ status: 401 });

  const defaults = await answerOf(await mind(undefined, "tools/list"));
  const [defaultRun] = (defaults.result || {}).tools as { name: string; description: string }[];
  expect(defaultRun).toMatchObject({ name: "run" });

  const custom = classOf({
    instructions: () => "Read the skills first.",
    tools: () => [{ name: "run", description: "Run, as this mind says." }, { name: "hello" }],
    hello: () => "hi",
  });
  expect((await answerOf(await mind(custom, "initialize", INIT))).result).toMatchObject({
    instructions: "Read the skills first.",
  });
  expect((await answerOf(await mind(custom, "tools/list"))).result?.tools).toEqual([
    expect.objectContaining({ name: "hello" }),
    expect.objectContaining({ name: "run", description: "Run, as this mind says." }),
  ]);

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const broken = classOf({
    instructions: () => {
      throw new Error("the config broke");
    },
    tools: () => "no list",
    skills: () => new Promise(() => {}),
  });
  vi.useFakeTimers();
  const pending = mind(broken, "initialize", INIT);
  await vi.advanceTimersByTimeAsync(6000);
  vi.useRealTimers();
  const init = await answerOf(await pending);
  expect(init.result?.instructions).toMatch(/^One tool, `run/);
  expect(init.result?.capabilities).not.toHaveProperty("resources");
  expect((await answerOf(await mind(broken, "tools/list"))).result?.tools).toEqual([
    expect.objectContaining({ name: "run", description: defaultRun.description }),
  ]);
  // each failure is one log line: the initialize asked all three, the list its tools again
  expect(warn.mock.calls.map(([line]) => (line as { what: string }).what).sort()).toEqual([
    "iterate-mind.instructions",
    "iterate-mind.skills",
    "iterate-mind.tools",
    "iterate-mind.tools",
  ]);
  warn.mockRestore();
});

const SKILL_MD = "---\nname: tea\ndescription: Brew tea.\n---\n\n# Tea\n";
const member = { actor: "user_owner", email: "owner@example.com" };

/** A config's class, as `mcpCall` reaches it: a missing method answers undefined. */
const classOf =
  (
    methods: Record<string, (...args: never[]) => unknown>,
    calls: unknown[][] = [],
  ): McpConfigCall =>
  async (client, method, args) => {
    calls.push([client.name, method, ...args]);
    return Object.hasOwn(methods, method)
      ? (methods[method] as (...a: unknown[]) => unknown)(...args)
      : undefined;
  };

const guestbook = (calls?: unknown[][]) =>
  classOf(
    {
      instructions: () => "The guestbook.",
      tools: () => [
        {
          name: "add_entry",
          description: "Write an entry.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        { name: "tools", description: "no tool may have this name" },
      ],
      add_entry: ({ text }: { text: string }) => ({ added: text }),
      skills: () => ({ "tea/SKILL.md": SKILL_MD, "README.md": "in no skill" }),
    },
    calls,
  );

let id = 0;
/** One JSON-RPC call as an HTTP client sends it: a body of a known length. */
function post(method: string, params?: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
  return new Request("https://guestbook.example.org/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      ...headers,
    },
    body,
  });
}
/** The JSON-RPC answer of one call, out of the SDK's event stream. */
async function answerOf(response: Response) {
  const text = await response.text();
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .findLast((line) => line.includes('"jsonrpc"'));
  return JSON.parse(data || text) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
  };
}
const INIT = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "codex-mcp-client", version: "1" },
};
const person = {
  userId: "user_friend",
  email: "friend@example.net",
  name: "friend",
  method: "email" as const,
};
const serve = (
  config: McpConfigCall,
  request: Request,
  caller: Parameters<typeof serveAppMcp>[1] = { principal: null, person },
  who: "members" | "people" = "people",
) =>
  serveAppMcp(request, caller, {
    target: "guestbookMcp",
    for: who,
    name: "guestbook",
    controlPlaneOrigin: "https://iterate.example.org",
    config,
  });
const app = (config: McpConfigCall, method: string, params?: unknown) =>
  serve(config, post(method, params)).then(answerOf);
