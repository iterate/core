// The default config's context descriptions (core/configs/default/context-descriptions.ts): which
// line the table gives a path, the key that makes each line land once, and when the module appends.
// The root here records what it is asked. An agent's own line is iterate/agents' (catalog.test.ts).
import { expect, test } from "vitest";
import {
  contextDescription,
  contextDescriptionsEvent,
  descriptionKey,
} from "../../configs/default/context-descriptions.ts";

test.for<{ name: string; path: string; description: string | undefined }>([
  {
    name: "the root",
    path: "/",
    description:
      "The mind's root: each publication of /repos/config, where its hosts go, and the facts of the whole mind.",
  },
  {
    name: "the config repo: its own row, before the row of every repo",
    path: "/repos/config",
    description:
      "This mind's code: a commit to main publishes the mind. Its AGENTS.md says how the code works.",
  },
  { name: "another repo", path: "/repos/site", description: "The git repository site." },
  {
    name: "a secret says its name",
    path: "/secrets/openai",
    description:
      "The secret openai: its value stays in the vault, and this log records when it was set, refreshed and used.",
  },
  {
    name: "a Slack channel's folder of thread agents names the team and the channel",
    path: "/agents/slack/T1/C2",
    description: "The agents of Slack threads in the channel C2 of the Slack workspace T1.",
  },
  {
    name: "the mail's own row, before the rows of accounts",
    path: "/integrations/email",
    description: "The mind's email: each mail it received and sent, folded into threads.",
  },
  {
    name: "an open doc takes the rest of the path",
    path: "/docs/config/notes/plan.md",
    description:
      "The Docs app's co-editing of notes/plan.md in /repos/config: an open doc, or a folder of them.",
  },
  {
    name: "an agent: no row, its title is its line",
    path: "/agents/onboarding",
    description: undefined,
  },
  {
    name: "a Slack thread's agent: no row",
    path: "/agents/slack/T1/C2/1700000000-1",
    description: undefined,
  },
  { name: "a secret's child: no row", path: "/secrets/openai/more", description: undefined },
  { name: "a path no row names", path: "/elsewhere", description: undefined },
])("the line the table gives: $name", ({ path, description }) => {
  expect(contextDescription(path)).toEqual(description);
});

test("the key names the path and the text: the same text lands once, a changed text once more", () => {
  const key = descriptionKey("/secrets/openai", "One text.");
  expect(key).toMatch(/^config\/described:\/secrets\/openai:[0-9a-z]+$/);
  expect(descriptionKey("/secrets/openai", "One text.")).toEqual(key);
  expect([
    descriptionKey("/secrets/openai", "Another text."),
    descriptionKey("/secrets/github", "One text."),
  ]).not.toContain(key);
});

test.for<{
  name: string;
  event: { type: string; path: string };
  listed: { path: string; description?: string }[];
  appended: string[];
  listCalls: number;
}>([
  {
    name: "a context born that a row names: its line",
    event: { type: "events.iterate.com/itx/created", path: "/secrets/openai" },
    listed: [],
    appended: ["/secrets/openai"],
    listCalls: 0,
  },
  {
    name: "a context born that no row names: no call",
    event: { type: "events.iterate.com/itx/created", path: "/agents/onboarding" },
    listed: [],
    appended: [],
    listCalls: 0,
  },
  {
    name: "a publish: each listed context a row names whose line is not that text yet",
    event: { type: "events.iterate.com/mind/worker-updated", path: "/" },
    listed: [
      { path: "/" },
      { path: "/agents/onboarding" },
      { path: "/repos/site", description: "The git repository site." },
      { path: "/secrets/openai", description: "A person's own words." },
    ],
    appended: ["/", "/secrets/openai"],
    listCalls: 1,
  },
  {
    name: "any other event, an itx/described among them: no call at all",
    event: { type: "events.iterate.com/itx/described", path: "/secrets/openai" },
    listed: [{ path: "/" }],
    appended: [],
    listCalls: 0,
  },
])("when the module appends: $name", async ({ event, listed, appended, listCalls }) => {
  const mind = recordingMind(listed);
  await contextDescriptionsEvent(mind.itx, event);
  expect(mind).toMatchObject({
    calls: {
      listCalls,
      appended: appended.map((path) => ({
        path,
        event: {
          type: "events.iterate.com/itx/described",
          idempotencyKey: descriptionKey(path, contextDescription(path)!),
          payload: { description: contextDescription(path) },
        },
      })),
    },
  });
});

/** A root whose catalog lists `listed`, and that records each list and each append. */
function recordingMind(listed: { path: string; description?: string }[]) {
  const calls = { listCalls: 0, appended: [] as { path: string; event: unknown }[] };
  const itx = {
    cd: (path: string) => ({
      append: async (event: unknown) => {
        calls.appended.push({ path, event });
      },
    }),
    contexts: {
      list: async () => {
        calls.listCalls += 1;
        return listed;
      },
    },
  };
  return { itx, calls };
}
