import { expect, test, vi } from "vitest";
import { installAgents } from "./install.ts";

test("installAgents enables the catalog on /agents, points the root's itx.agents rule at it, and disables the root's old catalog", async () => {
  const root = fakeRoot({ rows: ["agents"] });
  await installAgents(root);
  expect(root).toMatchObject({
    calls: [
      [
        "/agents processors.enable",
        "agents",
        {
          ...published("AgentCollectionDurableObject"),
          consumes: [
            "events.iterate.com/itx/child-created",
            "events.iterate.com/agent/deleted",
            "events.iterate.com/agent/listing-updated",
          ],
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: {
            match: "itx.agents",
            target: [
              "itx",
              ["cd", "/agents"],
              "facets",
              ["get", "agents", published("AgentCollectionDurableObject")],
            ],
            description: expect.stringContaining("create(path)"),
          },
        },
      ],
      ["processors.list"],
      ["processors.disable", "agents"],
    ],
  });
});

test("installAgents disables nothing once the root has no catalog of its own", async () => {
  const root = fakeRoot({ rows: [] });
  await installAgents(root);
  expect(root.calls.map(([call]) => call)).toEqual([
    "/agents processors.enable",
    "append",
    "processors.list",
  ]);
});

/** The facet spec every row and rule of the app names: a class of the config repo's `agents.ts`,
 *  in the project's published config (the facet restarts by that module's bundle, not a key). */
function published(className: string) {
  return { className, mainModule: "agents.ts", source: ["itx", ["cd", "/"], "config"] };
}

/** A project root, with processor rows named `rows`, that records the calls installing makes. */
function fakeRoot({ rows }: { rows: string[] }) {
  const calls: unknown[][] = [];
  return {
    calls,
    processors: {
      enable: vi.fn(async (name: string) => ({ name })),
      list: vi.fn(async () => {
        calls.push(["processors.list"]);
        return rows.map((name) => ({ name }));
      }),
      disable: vi.fn(async (name: string) => {
        calls.push(["processors.disable", name]);
      }),
    },
    cd: (path: string) => ({
      processors: {
        enable: vi.fn(async (name: string, spec?: object) => {
          calls.push([`${path} processors.enable`, name, spec]);
          return { name };
        }),
      },
    }),
    append: vi.fn(async (...events: object[]) => {
      calls.push(["append", ...events]);
      return [];
    }),
  };
}
