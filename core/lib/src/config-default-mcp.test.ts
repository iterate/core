// The default config's MCP server (core/configs/default/apps/mcp/, mounted on mcp.<zone> in
// worker.ts): RFC 9728 discovery, app description for passkey-only member sign-in, anonymous and
// non-member refusals, initialize/tools/list wording, and handing `run` to `auth.mcpRun`.
import { expect, test } from "vitest";
import {
  MCP_INSTRUCTIONS,
  MCP_RUN_DESCRIPTION,
  mcpApp,
} from "../../configs/default/apps/mcp/app.ts";
import {
  mcpAnswer,
  type McpRunMessage,
  runUnavailable,
} from "../../configs/default/apps/mcp/server.ts";
import Config from "../../configs/default/worker.ts";
import { ITERATE_CONTROL_PLANE_HOSTNAME_HEADER, ITERATE_SERVE_HEADER } from "./mind-ingress.ts";
import {
  ITX_PERSON_HEADER,
  ITX_PRINCIPAL_HEADER,
  type AddressedPerson,
  type Principal,
} from "./principal.ts";
import { auth } from "./sdk/auth.ts";

const ORIGIN = "https://mcp.example.com";
const CONTROL_PLANE = "iterate.example.com";
const MEMBER: Principal = { actor: "user_1", email: "ada@example.com" };
const NON_MEMBER: AddressedPerson = {
  userId: "user_2",
  email: "bob@example.com",
  name: "bob",
  method: "email",
};

test("the discovery document names this server and the mind's issuer, for anyone", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const answer = await mcpAnswer(new Request(`${ORIGIN}${path}`), options("anonymous"));
    expect(answer).toMatchObject({ status: 200 });
    expect(await answer.json()).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [`https://${CONTROL_PLANE}`],
      scopes_supported: ["identity"],
      bearer_methods_supported: ["header"],
    });
  }
});

test("anonymous: 401 with the discovery document's address, invalid_token when a bearer failed, and no run", async () => {
  const ran: McpRunMessage[] = [];
  for (const body of [
    call("initialize", {}),
    call("tools/list"),
    call("tools/call", { name: "run", arguments: { script: "async () => 1" } }),
  ]) {
    const answer = await mcpAnswer(post(body), options("anonymous", ran));
    expect(answer).toMatchObject({ status: 401 });
    expect(answer.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="identity"`,
    );
  }
  const badBearer = await mcpAnswer(
    post(call("tools/call", { name: "run", arguments: { script: "async () => 1" } }), {
      authorization: "Bearer for-another-audience",
    }),
    options("anonymous", ran),
  );
  expect(badBearer).toMatchObject({ status: 401 });
  expect(badBearer.headers.get("www-authenticate")).toMatch(
    /^Bearer error="invalid_token", resource_metadata=/,
  );
  // anonymous discover probe gets 400 so a 2026-07-28 client falls back to initialize
  const discover = await mcpAnswer(post(call("server/discover")), options("anonymous", ran));
  expect(discover).toMatchObject({ status: 400 });
  expect(discover.headers.get("www-authenticate")).toBeTruthy();
  expect(ran).toEqual([]);
});

test("signed in, no member: 403, and no run", async () => {
  const ran: McpRunMessage[] = [];
  const answer = await mcpAnswer(
    post(call("tools/call", { name: "run", arguments: { script: "async () => 1" } })),
    options("non-member", ran),
  );
  expect(answer).toMatchObject({ status: 403 });
  expect(ran).toEqual([]);
});

test("a member: initialize, tools/list, run envelope, and edge cases", async () => {
  const ran: McpRunMessage[] = [];
  const init = await (
    await mcpAnswer(post(call("initialize", { protocolVersion: "2025-06-18" })), options("member"))
  ).json();
  expect(init).toMatchObject({
    result: {
      instructions: "Say hello.\n\nOne tool.",
      protocolVersion: "2025-06-18",
    },
  });
  const list = await (await mcpAnswer(post(call("tools/list")), options("member"))).json();
  expect(list).toMatchObject({
    result: {
      tools: [{ name: "run", description: "Say hello.\n\nEvaluate." }],
    },
  });
  const runAnswer = await mcpAnswer(
    post(
      call(
        "tools/call",
        { name: "run", arguments: { script: "async () => 1", extra: "x" }, _meta: { a: 1 } },
        7,
      ),
    ),
    options("member", ran),
  );
  expect(await runAnswer.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { ran: true } });
  expect(ran).toEqual([
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "run", arguments: { script: "async () => 1" }, _meta: { a: 1 } },
    },
  ]);

  const other = await (
    await mcpAnswer(post(call("tools/call", { name: "delete_all" })), options("member"))
  ).json();
  expect(other).toMatchObject({ error: { code: -32602 } });
  const empty = await (
    await mcpAnswer(post(call("tools/call", { name: "run", arguments: {} })), options("member"))
  ).json();
  expect(empty).toMatchObject({ result: { isError: true } });
  expect(
    await mcpAnswer(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
      options("member"),
    ),
  ).toMatchObject({ status: 202 });
  expect(await mcpAnswer(new Request(`${ORIGIN}/mcp`), options("member"))).toMatchObject({
    status: 405,
  });
  expect(await (await mcpAnswer(post([call("ping")]), options("member"))).json()).toMatchObject({
    error: { code: -32600 },
  });
  expect(await mcpAnswer(new Request(`${ORIGIN}/itx`), options("member"))).toMatchObject({
    status: 404,
  });
});

test("runUnavailable refuses and points at the control plane /mcp", async () => {
  const answer = await runUnavailable(() => CONTROL_PLANE)({ id: 3 }).json();
  expect(answer).toMatchObject({
    id: 3,
    result: {
      isError: true,
      content: [{ text: expect.stringContaining(`https://${CONTROL_PLANE}/mcp`) }],
    },
  });
});

test("worker.ts mounts apps/mcp on mcp.<zone>: app description is public for members, and a member's run hands off via auth.mcpRun", async () => {
  const worker = Object.create(Config.prototype) as Config;
  Object.assign(worker, { auth, ctx: { waitUntil: () => {} } });

  // App description is open so the sign-in page shows the mind's icon and opens on the passkey.
  const described = await worker.fetch(new Request(`${ORIGIN}/.well-known/iterate-app`));
  expect(described).toMatchObject({ status: 200 });
  expect(await described.json()).toEqual({ name: "MCP", icon: "/icon.svg", for: "members" });

  // Discovery document is open on mcp.<zone>.
  const discovery = await worker.fetch(
    stampedRequest(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
  );
  expect(discovery).toMatchObject({ status: 200 });
  expect(await discovery.json()).toMatchObject({
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [`https://${CONTROL_PLANE}`],
  });

  // Non-member gets 403.
  const nonMember = await worker.fetch(
    stampedRequest(
      `${ORIGIN}/mcp`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          call("tools/call", { name: "run", arguments: { script: "async () => 1" } }),
        ),
      },
      { person: NON_MEMBER },
    ),
  );
  expect(nonMember).toMatchObject({ status: 403 });

  // Member initialize carries the default instructions, and tools/call of run returns x-iterate-serve: mcp-run.
  const init = await worker.fetch(
    stampedRequest(
      `${ORIGIN}/mcp`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call("initialize", { protocolVersion: "2025-06-18" })),
      },
      { principal: MEMBER },
    ),
  );
  expect(await init.json()).toMatchObject({
    result: { instructions: MCP_INSTRUCTIONS },
  });

  const runResponse = await worker.fetch(
    stampedRequest(
      `${ORIGIN}/mcp`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          call(
            "tools/call",
            { name: "run", arguments: { script: "async (itx) => itx.whoami()" } },
            9,
          ),
        ),
      },
      { principal: MEMBER },
    ),
  );
  expect(runResponse).toMatchObject({ status: 200 });
  expect(runResponse.headers.get(ITERATE_SERVE_HEADER)).toBe("mcp-run");
  expect(await runResponse.json()).toEqual({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "run", arguments: { script: "async (itx) => itx.whoami()" } },
  });

  // Sanity check default description mentions run.
  const app = mcpApp();
  const list = await app.fetch(
    stampedRequest(
      `${ORIGIN}/mcp`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(call("tools/list")),
      },
      { principal: MEMBER },
    ),
    { auth },
  );
  expect(await list.json()).toMatchObject({
    result: { tools: [{ name: "run", description: MCP_RUN_DESCRIPTION }] },
  });
});

// ── helpers ──

const guidance = {
  instructions: "Say hello.\n\nOne tool.",
  runDescription: "Say hello.\n\nEvaluate.",
};

function options(caller: "member" | "non-member" | "anonymous", ran: McpRunMessage[] = []) {
  return {
    caller,
    controlPlaneHostname: () => CONTROL_PLANE,
    guidance,
    runAsMember: (message: McpRunMessage) => {
      ran.push(message);
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { ran: true } });
    },
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function call(method: string, params?: Record<string, unknown>, id: string | number = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function stampedRequest(
  url: string,
  init: RequestInit = {},
  who: { principal?: Principal; person?: AddressedPerson } = {},
) {
  const headers = new Headers(init.headers);
  headers.set(ITERATE_CONTROL_PLANE_HOSTNAME_HEADER, CONTROL_PLANE);
  if (who.principal) headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(who.principal));
  if (who.person) headers.set(ITX_PERSON_HEADER, JSON.stringify(who.person));
  return new Request(url, { ...init, headers });
}
