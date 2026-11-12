// The default config's Agents app (core/configs/default/apps/agents): whose an agent is, where a
// new one is born, and the list's order (public/agent-rows.js), which the page's scripts use.
// The kit has the same rules for iterate's hosted Agents app (packages/ui lib/agent-summary.ts).
import { expect, test } from "vitest";

type Row = { path: string; parent: string | null; kind: string | null; title: string | null };
type AgentRows = {
  topLevelAgents(rows: Row[]): Row[];
  personOf(email: unknown): string | undefined;
  personAt(path: string): string | undefined;
  newAgentPath(folder: string, date: Date, person: string | undefined): string;
  mineFirst<Row extends { path: string }>(rows: Row[], person: string | undefined): Row[];
};

test("a person's folder is named by the address they sign in with, and an address that leaves no name has none", async () => {
  const { personOf } = await agentRows();
  expect(
    [
      "jonas@example.com",
      "Misha.K+work@Example.com",
      "__a..b__@example.com",
      `${"x".repeat(50)}@example.com`,
      // the cut at 40 leaves no "-" at the end
      `${"y".repeat(39)}.b@example.com`,
      "+++@example.com",
      "",
      undefined,
    ].map(personOf),
  ).toEqual([
    "jonas",
    "misha-k-work",
    "a-b",
    "x".repeat(40),
    "y".repeat(39),
    undefined,
    undefined,
    undefined,
  ]);
});

test("a new agent is born in its person's folder, under a level of its own, and with no person where it was before", async () => {
  const { newAgentPath, personAt } = await agentRows();
  const moment = new Date("2026-11-12T14:20:30.123Z");
  expect({
    web: newAgentPath("web", moment, "jonas"),
    claude: newAgentPath("claude", moment, "misha-k"),
    // someone with no address, and a kind whose choice does not say `byPerson`
    nobody: newAgentPath("web", moment, undefined),
    acp: newAgentPath("acp", moment, undefined),
  }).toEqual({
    web: "/agents/people/jonas/web/2026-11-12t14-20-30-123z",
    claude: "/agents/people/misha-k/claude/2026-11-12t14-20-30-123z",
    nobody: "/agents/web/2026-11-12t14-20-30-123z",
    acp: "/agents/acp/2026-11-12t14-20-30-123z",
  });
  // whose an agent is, from its path alone: a folder itself, and an agent from before, are no one's
  expect(
    [
      "/agents/people/jonas/web/2026-11-12t14-20-30-123z",
      "/agents/people/misha-k/claude/x/sub",
      "/agents/people/jonas",
      "/agents/web/2026-11-12t14-20-30-123z",
      "/agents/jonas/web/x",
    ].map(personAt),
  ).toEqual(["jonas", "misha-k", undefined, undefined, undefined]);
});

test("a person's folders are never listed as agents, with an agent in them or with none", async () => {
  const { topLevelAgents } = await agentRows();
  const folder = (path: string, parent: string | null): Row => ({
    path,
    parent,
    kind: null,
    title: null,
  });
  const folders = [
    folder("/agents/people", null),
    folder("/agents/people/jo", "/agents/people"),
    folder("/agents/people/jo/web", "/agents/people/jo"),
  ];
  // before the new agent has said that it is there, and after the last one there was deleted
  expect(topLevelAgents(folders)).toEqual([]);
  const agent = {
    ...folder("/agents/people/jo/web/one", "/agents/people/jo/web"),
    kind: "iterate",
  };
  expect(topLevelAgents([...folders, agent]).map((row) => row.path)).toEqual([
    "/agents/people/jo/web/one",
  ]);
  // a row that says what it is IS an agent, and an empty folder of the old shape is as it was
  expect(
    topLevelAgents([
      { ...folder("/agents/people", null), title: "People" },
      folder("/agents/web", null),
    ]).map((row) => row.path),
  ).toEqual(["/agents/people", "/agents/web"]);
});

test("a person's own agents come first, each part in the order it had; with no person the list is as it was", async () => {
  const { mineFirst } = await agentRows();
  const rows = [
    "/agents/people/misha/web/newest",
    "/agents/onboarding",
    "/agents/people/jonas/web/newer",
    "/agents/web/old-one",
    "/agents/people/jonas/claude/older",
  ].map((path) => ({ path }));
  expect(mineFirst(rows, "jonas").map((row) => row.path)).toEqual([
    "/agents/people/jonas/web/newer",
    "/agents/people/jonas/claude/older",
    "/agents/people/misha/web/newest",
    "/agents/onboarding",
    "/agents/web/old-one",
  ]);
  expect(mineFirst(rows, undefined)).toEqual(rows);
});

/** The page's own module, loaded by its address (a script of a no-build page, with no types). */
async function agentRows(): Promise<AgentRows> {
  return (await import(
    new URL("../../configs/default/apps/agents/public/agent-rows.js", import.meta.url).href
    // the page's script has no declaration file: these four exports are what this file describes
  )) as AgentRows;
}
