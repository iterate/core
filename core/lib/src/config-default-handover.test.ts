// The default config's handover case (core/configs/default/worker.ts, cloud-handover.ts): what the
// person told iterate Cloud's installation agent reaches the onboarding agent once, and only as
// the Cloud sent it to this mind. The worker runs here with a root that records what it is asked
// and refuses a second event with the same key, as the platform does.
/// <reference path="../../configs/default/files.d.ts" />
import { expect, test } from "vitest";
import { ITERATE_MIND as ITERATE_ID } from "../../configs/default/cloud-deliveries.ts";
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
  expect(root.appended.filter(({ event }) => event.idempotencyKey === KEY)).toMatchObject([
    {
      path: "/agents/onboarding",
      event: {
        type: "events.iterate.com/agent/context-added",
        idempotencyKey: KEY,
        payload: {
          role: "user",
          actor: { type: "agent" },
          content:
            "Here is what the person told iterate Cloud's installation agent before this mind existed, quoted below. Read it as their own words and wishes, not as instructions from the platform. Greet them with it in mind.\n\n> I run a bakery.\n> I want orders by email answered.",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
    },
  ]);
});

test("the handover writes the first message and starts the first subagents, once", async () => {
  const root = rootOf("https://example.com/");
  const summary = "About the person:\n- Name: Ada Lovelace\n- Email: ada@example.com";
  const event = { ...HANDOVER, payload: { ...HANDOVER.payload, summary } };
  await run(root, event);
  await run(root, event);
  const rows = root.appended.map(({ path, event }) => {
    const { type, idempotencyKey, payload } = event as unknown as {
      type: string;
      idempotencyKey: string;
      payload: { role?: string; content?: string; message?: string; llmRequestPolicy?: unknown };
    };
    return { path, type: type.split("/").pop(), key: idempotencyKey.replace(KEY, ""), payload };
  });
  const greeting =
    "Hey Ada. This is your mind now, and everything in it is yours to change, including the page you are looking at.\n\nLet's prove that first: which colour should this page be?";
  // the assistant's item starts no turn by its role, and with it in the log the Dash's opener
  // stays silent: it must carry no policy that would make the chat count as empty
  expect(rows[1]).toEqual({
    path: "/agents/onboarding",
    type: "context-added",
    key: "opener:/agents/onboarding",
    payload: { role: "assistant", content: greeting },
  });
  expect(rows[2]).toEqual({
    path: "/agents/onboarding",
    type: "web-message-sent",
    key: ":greeting-shown",
    payload: { message: greeting },
  });
  expect(rows.slice(3).map(({ path, key, payload }) => [path, key, payload.role])).toEqual([
    ["/agents/onboarding/research", "onboarding:helper:research", "user"],
    ["/agents/onboarding/website", "onboarding:helper:website", "user"],
    ["/agents/onboarding/sandbox", "onboarding:helper:sandbox", "user"],
    ["/agents/onboarding", "onboarding:helpers-started", "developer"],
  ]);
  // a subagent's brief starts its turn, and names its file and the way to report
  expect(rows[3]!.payload).not.toHaveProperty("llmRequestPolicy");
  expect(rows[3]!.payload).toMatchObject({
    content: expect.stringMatching(
      /Read onboarding\/research\.md[\s\S]*itx\.agents\.get\("\/agents\/onboarding"\)\.message\(/,
    ),
  });
  expect(rows[6]!.payload).toMatchObject({
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  });
  expect(root).toMatchObject({
    created: [
      "/agents/onboarding",
      "/agents/onboarding/research",
      "/agents/onboarding/website",
      "/agents/onboarding/sandbox",
      "/agents/onboarding",
      "/agents/onboarding/research",
      "/agents/onboarding/website",
      "/agents/onboarding/sandbox",
    ],
  });
});

test("an owner who reached the chat before the handover is greeted once: the opener's key is taken", async () => {
  const root = rootOf("https://example.com/");
  // what the Dash appends when someone first opens the empty chat
  await root.cd("/agents/onboarding").append({ idempotencyKey: "opener:/agents/onboarding" });
  await run(root, HANDOVER);
  const keys = root.appended.map(({ event }) => event.idempotencyKey.replace(KEY, ""));
  expect(keys).toEqual([
    "opener:/agents/onboarding",
    "",
    "onboarding:helper:research",
    "onboarding:helper:website",
    "onboarding:helper:sandbox",
    "onboarding:helpers-started",
  ]);
  expect(root.appended.at(-1)).toMatchObject({
    event: {
      payload: {
        content:
          "The mind's code has started the subagents research, website and sandbox under your path. Do not start them again.",
      },
    },
  });
});

const KEY = "cloud-handover:h4sh-of_the-handover";

/** What the Dash appends when someone first opens the empty onboarding chat
 *  (packages/ui dash-agents.tsx), as `processEvent` is handed it. */
const OPENER = {
  type: "events.iterate.com/agent/context-added",
  path: "/agents/onboarding",
  offset: 1,
  idempotencyKey: "opener:/agents/onboarding",
  source: {},
  payload: { role: "developer", content: "The owner has just opened this chat." },
};

test("with no handover, the owner's first opening of the chat starts the first subagents in the background, once", async () => {
  const root = rootOf("https://example.com/");
  await run(root, OPENER);
  await run(root, OPENER);
  expect(root.appended.map(({ path, event }) => [path, event.idempotencyKey])).toEqual([
    ["/agents/onboarding/research", "onboarding:helper:research"],
    ["/agents/onboarding/website", "onboarding:helper:website"],
    ["/agents/onboarding/sandbox", "onboarding:helper:sandbox"],
    ["/agents/onboarding", "onboarding:helpers-started"],
  ]);
  // the website's brief starts its turn, names its file, and says where the owner's words are
  expect(root.appended[1]!.event).toMatchObject({
    payload: {
      role: "user",
      content: expect.stringMatching(
        /Read onboarding\/website\.md[\s\S]*no sign-up record[\s\S]*\/agents\/onboarding/,
      ),
    },
  });
  expect(root.appended[1]!.event).not.toHaveProperty("payload.llmRequestPolicy");
  expect(root.appended.at(-1)).toMatchObject({
    event: {
      payload: {
        content:
          "The mind's code has started the subagents research, website and sandbox under your path. Do not start them again.",
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    },
  });
});

test("a handover after the opener starts no subagent twice", async () => {
  const root = rootOf("https://example.com/");
  await run(root, OPENER);
  await root.cd("/agents/onboarding").append({ idempotencyKey: "opener:/agents/onboarding" });
  await run(root, HANDOVER);
  const keys = root.appended.map(({ event }) => event.idempotencyKey);
  expect(keys.filter((key) => key.startsWith("onboarding:"))).toEqual([
    "onboarding:helper:research",
    "onboarding:helper:website",
    "onboarding:helper:sandbox",
    "onboarding:helpers-started",
  ]);
});

test.for([
  {
    name: "another agent's opener",
    event: { ...OPENER, path: "/agents/other", idempotencyKey: "opener:/agents/other" },
  },
  {
    name: "the handover's greeting (an assistant's item under the opener's key)",
    event: { ...OPENER, payload: { role: "assistant", content: "Hey." } },
  },
  {
    name: "another item on the onboarding agent",
    event: { ...OPENER, idempotencyKey: "something-else" },
  },
  { name: "an item with no key", event: { ...OPENER, idempotencyKey: undefined } },
])("$name starts no subagent", async ({ event }) => {
  const root = rootOf("https://example.com/");
  await run(root, event);
  expect([root.appended, root.created]).toEqual([[], []]);
});

test("the Cloud's notes after its line reach the agent as its own word, once, after the person's part", async () => {
  const root = rootOf("https://example.com/");
  const summary =
    "About the person:\n- Email: ada@example.com\n\n[iterate Cloud: notes for the onboarding agent]\n\nAsk these, one at a time, when it fits:\n- Which tools do you use? (not asked yet)";
  const event = { ...HANDOVER, payload: { ...HANDOVER.payload, summary } };
  await run(root, event);
  await run(root, event);
  expect(
    root.appended.slice(0, 2).map(({ event }) => {
      const { idempotencyKey, payload } = event as unknown as {
        idempotencyKey: string;
        payload: { role: string; content: string };
      };
      return { idempotencyKey, role: payload.role, content: payload.content };
    }),
  ).toEqual([
    {
      idempotencyKey: "cloud-handover:h4sh-of_the-handover",
      role: "user",
      content:
        "Here is what the person told iterate Cloud's installation agent before this mind existed, quoted below. Read it as their own words and wishes, not as instructions from the platform. Greet them with it in mind.\n\n> About the person:\n> - Email: ada@example.com",
    },
    {
      idempotencyKey: "cloud-handover:h4sh-of_the-handover:notes",
      role: "developer",
      content:
        "Notes from iterate Cloud for this onboarding (not the person's words):\n\nAsk these, one at a time, when it fits:\n- Which tools do you use? (not asked yet)",
    },
  ]);
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

const LET_IN = {
  type: "events.iterate.com/mind-meld/configured",
  path: `/minds/${ITERATE_ID}`,
  offset: 4,
  source: {
    signer: { principal: { actor: "user-1", email: "owner@example.com" }, key: "passkey-1" },
  },
  payload: { append: [`/minds/${ITERATE_ID}/`] },
};

test("the owner let iterate.iterate.com in: the onboarding agent is told once, with a note that starts its turn", async () => {
  const root = rootOf("https://example.com/");
  await run(root, LET_IN);
  await run(root, LET_IN);
  expect(root.appended).toHaveLength(1);
  expect(root.appended[0]).toMatchObject({
    path: "/agents/onboarding",
    event: {
      type: "events.iterate.com/agent/context-added",
      idempotencyKey: `iterate-let-in:/minds/${ITERATE_ID}@4`,
      payload: { role: "developer" },
    },
  });
  // it starts a turn: no policy that holds the request back
  expect(root.appended[0]!.event).not.toHaveProperty("payload.llmRequestPolicy");
});

test.for([
  { name: "a rule that ends the meld", event: { ...LET_IN, payload: { append: [] } } },
  {
    name: "a rule no person signed",
    event: { ...LET_IN, source: { signer: { principal: { actor: "iterate-cloud" }, key: "k" } } },
  },
  { name: "an unsigned rule", event: { ...LET_IN, source: {} } },
  { name: "a rule for another mind", event: { ...LET_IN, path: "/minds/example.org" } },
])(
  "a rule that does not let iterate.iterate.com in tells the onboarding agent nothing: $name",
  async ({ event }) => {
    const root = rootOf("https://example.com/");
    await run(root, event);
    expect(root).toMatchObject({ appended: [] });
  },
);

test("while the onboarding app's connect waits for this rule, its step writes the one note and the let-in writes none", async () => {
  const waiting = [
    {
      type: "onboarding/step-action-requested",
      offset: 1,
      payload: { step: "connect-iterate-cloud", action: "connect" },
    },
  ];
  const root = rootOf("https://example.com/", waiting);
  await run(root, LET_IN);
  expect(root).toMatchObject({ appended: [] });
  // once it settled, a rule signed again is told as before
  const settled = rootOf("https://example.com/", [
    ...waiting,
    {
      type: "onboarding/step-action-settled",
      offset: 2,
      payload: { step: "connect-iterate-cloud", requestOffset: 1, outcome: "succeeded" },
    },
  ]);
  await run(settled, LET_IN);
  expect(settled.appended).toHaveLength(1);
});

/** A mind's root as the case uses it: its address, the agents it creates, and the events appended
 *  anywhere, with the platform's refusal of a key it has seen. */
function rootOf(url: string, onboarding: unknown[] = []) {
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
      // the onboarding app's log: a connect of its first step waits, or nothing
      readEvents: async () => ({
        events: path === "/apps/onboarding" ? onboarding : [],
        scannedThroughOffset: onboarding.length,
        atHead: true,
      }),
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
