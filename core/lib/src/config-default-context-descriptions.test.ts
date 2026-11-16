// The default config's context descriptions (core/configs/default/context-descriptions.ts): which
// title and line the table gives a path, the keys that make each land once, and when the module
// appends.
// The root here records what it is asked. An agent's own line is iterate/agents' (catalog.test.ts).
import { expect, test, vi } from "vitest";
import {
  contextDescriptionsEvent,
  contextLine,
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
  expect(contextLine(path)?.description).toEqual(description);
});

test.for<{ name: string; path: string; title: string | undefined }>([
  { name: "the root", path: "/", title: "Mind root" },
  {
    name: "the config repo, before the row of every repo",
    path: "/repos/config",
    title: "Config repo",
  },
  { name: "another repo says its name", path: "/repos/site", title: "Repo site" },
  { name: "a secret says its name", path: "/secrets/openai", title: "Secret openai" },
  { name: "an agent: no row, its title is its own", path: "/agents/onboarding", title: undefined },
])("the title the table gives: $name", ({ path, title }) => {
  expect(contextLine(path)?.title).toEqual(title);
});

test("every row has a short title: at most 40 characters, and no full stop", () => {
  for (const path of [
    "/",
    "/agents",
    "/agents/email",
    "/repos/config",
    "/secrets",
    "/integrations",
    "/integrations/email",
    "/approvals",
    "/docs",
  ]) {
    const title = contextLine(path)?.title;
    expect(title, path).toBeTruthy();
    expect(title!.length, path).toBeLessThanOrEqual(40);
    expect(title, path).not.toMatch(/\.$/);
  }
});

test("the key names the path and the text: the same text lands once, a changed text once more", () => {
  const key = descriptionKey("described", "/secrets/openai", "One text.");
  expect(key).toMatch(/^config\/described:\/secrets\/openai:[0-9a-z]+$/);
  expect(descriptionKey("described", "/secrets/openai", "One text.")).toEqual(key);
  expect([
    descriptionKey("described", "/secrets/openai", "Another text."),
    descriptionKey("described", "/secrets/github", "One text."),
    // a title has a key of its own, so the same words as a description still land
    descriptionKey("titled", "/secrets/openai", "One text."),
  ]).not.toContain(key);
  expect(descriptionKey("titled", "/secrets/openai", "One text.")).toMatch(
    /^config\/titled:\/secrets\/openai:[0-9a-z]+$/,
  );
});

test.for<{
  name: string;
  event: { type: string; path: string };
  listed: Listed[];
  /** each append, in order: the path, and whether it writes the description or the title */
  appended: [path: string, what: "description" | "title"][];
  listCalls: number;
}>([
  {
    name: "a context born that a row names: its line, and its title beside the metadata it has by then",
    event: { type: "events.iterate.com/itx/created", path: "/secrets/openai" },
    listed: [{ path: "/secrets/openai", eventCount: 2, metadata: { setAtBirth: "by its maker" } }],
    appended: [
      ["/secrets/openai", "description"],
      ["/secrets/openai", "title"],
    ],
    listCalls: 1,
  },
  {
    name: "a context born that the catalog does not list yet: its line, and no title that could erase metadata",
    event: { type: "events.iterate.com/itx/created", path: "/secrets/openai" },
    listed: [{ path: "/secrets/openai/child" }],
    appended: [["/secrets/openai", "description"]],
    listCalls: 1,
  },
  {
    name: "a context born that is listed awake with no stored summary (eventCount 0): its line, and no title",
    event: { type: "events.iterate.com/itx/created", path: "/secrets/openai" },
    listed: [{ path: "/secrets/openai", eventCount: 0 }],
    appended: [["/secrets/openai", "description"]],
    listCalls: 1,
  },
  {
    name: "a context born whose row has the title already: its line alone",
    event: { type: "events.iterate.com/itx/created", path: "/secrets/openai" },
    listed: [{ path: "/secrets/openai", eventCount: 2, metadata: { title: "Secret openai" } }],
    appended: [["/secrets/openai", "description"]],
    listCalls: 1,
  },
  {
    name: "metadata that a title would push over the catalog's 4,000 characters: no title, at birth",
    event: { type: "events.iterate.com/itx/created", path: "/secrets/openai" },
    listed: [{ path: "/secrets/openai", eventCount: 2, metadata: { notes: "n".repeat(3_980) } }],
    appended: [["/secrets/openai", "description"]],
    listCalls: 1,
  },
  {
    name: "the same at a publish: the record stays as it is, and the others get their titles",
    event: { type: "events.iterate.com/mind/worker-updated", path: "/" },
    listed: [
      {
        path: "/secrets/openai",
        description:
          "The secret openai: its value stays in the vault, and this log records when it was set, refreshed and used.",
        metadata: { notes: "n".repeat(3_980) },
      },
      { path: "/repos/site", description: "The git repository site." },
    ],
    appended: [["/repos/site", "title"]],
    listCalls: 1,
  },
  {
    name: "a context born that no row names: no call",
    event: { type: "events.iterate.com/itx/created", path: "/agents/onboarding" },
    listed: [],
    appended: [],
    listCalls: 0,
  },
  {
    name: "a publish: each listed context a row names, for the line and the title it does not say yet",
    event: { type: "events.iterate.com/mind/worker-updated", path: "/" },
    listed: [
      { path: "/" },
      { path: "/agents/onboarding" },
      // says both already: no call
      {
        path: "/repos/site",
        description: "The git repository site.",
        metadata: { title: "Repo site" },
      },
      // the line is a person's, the title is the table's already: the line alone
      {
        path: "/secrets/openai",
        description: "A person's own words.",
        metadata: { title: "Secret openai" },
      },
      // the line is the table's, the title is missing: the title alone, beside what is there
      {
        path: "/repos/config",
        description:
          "This mind's code: a commit to main publishes the mind. Its AGENTS.md says how the code works.",
        metadata: { kept: true },
      },
    ],
    appended: [
      ["/", "description"],
      ["/", "title"],
      ["/secrets/openai", "description"],
      ["/repos/config", "title"],
    ],
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
      appended: appended.map(([path, what]) => {
        const line = contextLine(path)!;
        return {
          path,
          event:
            what === "description"
              ? {
                  type: "events.iterate.com/itx/described",
                  idempotencyKey: descriptionKey("described", path, line.description),
                  payload: { description: line.description },
                }
              : {
                  type: "events.iterate.com/itx/described",
                  idempotencyKey: descriptionKey("titled", path, line.title),
                  // the title goes in beside what the context's metadata holds
                  payload: {
                    metadata: {
                      ...listed.find((context) => context.path === path)?.metadata,
                      title: line.title,
                    },
                  },
                },
        };
      }),
    },
  });
  expect(mind.calls.appended).toHaveLength(appended.length);
});

test("a context whose metadata cannot take a title says so once, not at every publish", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const mind = recordingMind([{ path: "/secrets/long", metadata: { notes: "n".repeat(3_990) } }]);
  const publish = { type: "events.iterate.com/mind/worker-updated", path: "/" };
  await contextDescriptionsEvent(mind.itx, publish);
  await contextDescriptionsEvent(mind.itx, publish);
  const said = errors.mock.calls.filter((call) => JSON.stringify(call).includes("/secrets/long"));
  errors.mockRestore();
  expect(said).toHaveLength(1);
  // the description still lands (twice here: this fake keeps no keys), and never a title
  expect(mind.calls.appended.map(({ event }) => Object.keys((event as any).payload)[0])).toEqual([
    "description",
    "description",
  ]);
});

test("an append that fails skips that one context: the others get theirs, and the publish says so once", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const mind = recordingMind([{ path: "/repos/site" }, { path: "/secrets/openai" }, { path: "/" }]);
  const append = mind.itx.cd;
  mind.itx.cd = (path: string) =>
    path === "/secrets/openai"
      ? {
          append: async () => {
            throw new Error("the mind refused this append");
          },
        }
      : append(path);
  await contextDescriptionsEvent(mind.itx, {
    type: "events.iterate.com/mind/worker-updated",
    path: "/",
  });
  const said = errors.mock.calls.filter((call) =>
    JSON.stringify(call).includes("config.context-descriptions.publish"),
  );
  errors.mockRestore();
  // both writes of the two other contexts landed
  expect(mind.calls.appended.map(({ path }) => path).toSorted()).toEqual([
    "/",
    "/",
    "/repos/site",
    "/repos/site",
  ]);
  // one report for the publish, with how many contexts were left as they were
  expect(said).toHaveLength(1);
  // both writes of the one context failed: it is one context, counted once
  expect(JSON.stringify(said[0])).toContain('"contexts":1');
});

type Listed = {
  path: string;
  description?: string;
  metadata?: Record<string, unknown>;
  eventCount?: number;
};

/** A root whose catalog lists `listed`, and that records each list and each append. */
function recordingMind(listed: Listed[]) {
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
