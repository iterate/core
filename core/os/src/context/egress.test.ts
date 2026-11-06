// egress.test.ts — first-hop-only model-call tracing; see `modelCallAt` in egress.ts for the routing
// rationale. The relay and the spans are agent-spans.ts's.

import { expect, test } from "vitest";
import { modelCallAt } from "./egress.ts";

const RESPONSES = "https://api.openai.com/v1/responses";
const AGENT_HOP = { projectId: "prj_1", path: "/agents/support", secretPath: "/secrets/chatgpt" };
const SECRET_HOP = { projectId: "prj_1", path: "/secrets/chatgpt", secretPath: "/secrets/chatgpt" };

test.for([
  {
    name: "a project-key socket, at the agent's context: relayed, as the agent's",
    request: upgrade(RESPONSES),
    at: AGENT_HOP,
    expected: { kind: "socket", call: { projectId: "prj_1", path: "/agents/support" } },
  },
  {
    name: "the same socket, at the secret's own context: not relayed again",
    request: upgrade(RESPONSES),
    at: SECRET_HOP,
    expected: undefined,
  },
  {
    name: "a project-key HTTP call, at the agent's context: read through, as the agent's",
    request: post(RESPONSES),
    at: AGENT_HOP,
    expected: { kind: "http", call: { projectId: "prj_1", path: "/agents/support" } },
  },
  {
    name: "the same HTTP call, at the secret's own context: not read again",
    request: post(RESPONSES),
    at: SECRET_HOP,
    expected: undefined,
  },
  {
    name: "a call that names no secret, which has one hop",
    request: post(RESPONSES),
    at: { ...AGENT_HOP, secretPath: undefined },
    expected: { kind: "http", call: { path: "/agents/support" } },
  },
  {
    name: "another OpenAI endpoint",
    request: post("https://api.openai.com/v1/embeddings"),
    at: AGENT_HOP,
    expected: undefined,
  },
  {
    name: "a GET of the Responses URL",
    request: new Request(RESPONSES),
    at: AGENT_HOP,
    expected: undefined,
  },
])("$name", ({ request, at, expected }) => {
  if (expected) expect(modelCallAt(request, at)).toMatchObject(expected);
  else expect(modelCallAt(request, at)).toBeUndefined();
});

/** A WebSocket upgrade, as responses-keys.ts dials the agent's socket. */
function upgrade(url: string): Request {
  return new Request(url, { headers: { upgrade: "websocket" } });
}

/** A Responses API call over HTTP. */
function post(url: string): Request {
  return new Request(url, { method: "POST", body: "{}" });
}
