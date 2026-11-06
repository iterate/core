// egress.test.ts — which requests egress traces as a model call (egress.ts `modelCallAt`), and as
// whose. The relay and the spans are agent-spans.ts's.

import { expect, test } from "vitest";
import { modelCallAt } from "./egress.ts";

const RESPONSES = "https://api.openai.com/v1/responses";
const AGENT = { projectId: "prj_1", path: "/agents/support" };

test.for([
  {
    name: "a Responses socket: relayed, as the agent's",
    request: upgrade(RESPONSES),
    at: AGENT,
    expected: { kind: "socket", call: { projectId: "prj_1", path: "/agents/support" } },
  },
  {
    name: "a Responses call over HTTP: read through, as the agent's",
    request: post(RESPONSES),
    at: AGENT,
    expected: { kind: "http", call: { projectId: "prj_1", path: "/agents/support" } },
  },
  {
    name: "another OpenAI endpoint",
    request: post("https://api.openai.com/v1/embeddings"),
    at: AGENT,
    expected: undefined,
  },
  {
    name: "a GET of the Responses URL",
    request: new Request(RESPONSES),
    at: AGENT,
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
