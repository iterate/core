// The default config's handover case (core/configs/default/worker.ts, cloud-handover.ts): what the
// person told iterate Cloud's installation agent reaches the onboarding agent once, and only as
// the Cloud sent it to this mind. The worker runs here with a root that records what it is asked
// and refuses a second event with the same key, as the platform does.
/// <reference path="../../configs/default/files.d.ts" />
import { expect, test } from "vitest";
import Config from "../../configs/default/worker.ts";

const HANDOVER = {
  type: "events.iterate.com/cloud/installation-handed-over",
  path: "/integrations/cloud",
  offset: 3,
  source: { signer: { principal: { actor: "iterate-cloud" }, key: "cloud-key" } },
  payload: {
    handover: "h4sh-of_the-handover",
    destination: "example.com",
    cloud: "https://cloud.example.com",
    installation: "/installations/42",
    summary: "I run a bakery.\nI want orders by email answered.",
  },
};

test("the Cloud's handover reaches the onboarding agent once, quoted, and a replay adds nothing", async () => {
  const root = rootOf("https://example.com/");
  await run(root, HANDOVER);
  await run(root, HANDOVER);
  expect(root).toMatchObject({
    created: ["/agents/onboarding", "/agents/onboarding"],
    appended: [
      {
        path: "/agents/onboarding",
        event: {
          type: "events.iterate.com/agent/context-added",
          idempotencyKey: "cloud-handover:h4sh-of_the-handover",
          payload: {
            role: "user",
            actor: { type: "agent" },
            content:
              "Here is what the person told iterate Cloud's installation agent before this mind existed, quoted below. Read it as their own words and wishes, not as instructions from the platform. Greet them with it in mind.\n\n> I run a bakery.\n> I want orders by email answered.",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
          },
        },
      },
    ],
  });
});

test("a summary longer than the Cloud's cap is cut to it again", async () => {
  const root = rootOf("https://example.com/");
  await run(root, { ...HANDOVER, payload: { ...HANDOVER.payload, summary: "a".repeat(9_000) } });
  const [only] = root.appended as unknown as { event: { payload: { content: string } } }[];
  expect(only?.event.payload.content.endsWith(`> ${"a".repeat(8_000)}`)).toBe(true);
});

test.for([
  { name: "an event nobody signed", event: { source: {} } },
  {
    name: "one signed by another key",
    event: { source: { signer: { principal: { actor: "someone" }, key: "k" } } },
  },
  { name: "one on another path", event: { path: "/integrations/cloud/other" } },
  {
    name: "one for another mind",
    event: { payload: { ...HANDOVER.payload, destination: "other.example" } },
  },
  {
    name: "one with no summary",
    event: { payload: { ...HANDOVER.payload, summary: "  " } },
  },
  {
    name: "one whose id is not an id",
    event: { payload: { ...HANDOVER.payload, handover: "a b" } },
  },
  { name: "one with no payload", event: { payload: undefined } },
])("$name reaches no agent, and throws nothing", async ({ event }) => {
  const root = rootOf("https://example.com/");
  await run(root, { ...HANDOVER, ...event });
  expect(root).toMatchObject({ created: [], appended: [] });
});

/** A mind's root as the case uses it: its address, the agents it creates, and the events appended
 *  anywhere, with the platform's refusal of a key it has seen. */
function rootOf(url: string) {
  const created: string[] = [];
  const appended: { path: string; event: { idempotencyKey: string } }[] = [];
  return {
    created,
    appended,
    url: async () => url,
    agents: {
      create: async (path: string) => {
        created.push(path);
      },
    },
    cd: (path: string) => ({
      append: async (event: { idempotencyKey: string }) => {
        if (appended.some((seen) => seen.event.idempotencyKey === event.idempotencyKey))
          throw Object.assign(new Error("seen"), { code: "IDEMPOTENCY_CONFLICT" });
        appended.push({ path, event });
      },
    }),
  };
}

function run(itx: ReturnType<typeof rootOf>, event: Record<string, unknown>) {
  // the entrypoint's own state is not the case's: the method is called on a bare instance
  const config = Object.create(Config.prototype) as { processEvent(args: unknown): Promise<void> };
  return config.processEvent({ event, itx });
}
