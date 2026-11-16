// The default config's publish hook (core/configs/default/worker.ts, the `mind/worker-updated`
// case): each step by itself. The root here refuses what a test names and records the rest.
import { expect, test, vi } from "vitest";
import Config from "../../configs/default/worker.ts";

const PUBLISH = { type: "events.iterate.com/mind/worker-updated", path: "/", offset: 7 };

test("a publish on a mind whose onboarding agent was deleted still runs every hook, and reports no fault for it", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = rootOf(async () => {
    throw new Error("agent /agents/onboarding: deleted — not re-creatable");
  });
  await publish(root.itx);
  const steps = reportedSteps(errors);
  errors.mockRestore();
  // the create was tried, and the hooks after the switch ran: the contexts' lines read the catalog
  expect(root.calls).toContain("agents.create /agents/onboarding");
  expect(root.calls).toContain("contexts.list");
  // a deleted onboarding agent is the owner's choice, not a fault of the publish
  expect(steps).not.toContain("onboarding-agent");
});

test("a step that throws for another reason is reported with its name, and the steps after it still run", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = rootOf(async () => {
    throw new Error("the mind refused this call");
  });
  await publish(root.itx);
  const steps = reportedSteps(errors);
  errors.mockRestore();
  expect(steps).toContain("onboarding-agent");
  expect(root.calls).toContain("contexts.list");
});

/** A root that records each call's name. Every call that a test does not name answers nothing,
 *  so a step may fail on it: the hook must go on. */
function rootOf(createAgent: (path: string) => Promise<unknown>) {
  const calls: string[] = [];
  const context = {
    append: async () => {
      calls.push("append");
    },
    facets: {
      get: () => {
        throw new Error("this root has no facets");
      },
    },
  };
  const itx = {
    agents: {
      create: async (path: string) => {
        calls.push(`agents.create ${path}`);
        return await createAgent(path);
      },
    },
    cd: () => context,
    contexts: {
      list: async () => {
        calls.push("contexts.list");
        return [];
      },
    },
    url: async () => "https://example.com/",
  };
  return { itx, calls };
}

function publish(itx: unknown) {
  // the entrypoint's own state is not the case's: the method is called on a bare instance
  const config = Object.create(Config.prototype) as { processEvent(args: unknown): Promise<void> };
  // a later hook may still reject on this small root: what is asked here is what ran before it
  return config.processEvent({ event: PUBLISH, itx }).catch(() => {});
}

/** The `config.publish-hook` lines that `reportIssue` printed, by their step. */
function reportedSteps(errors: { mock: { calls: unknown[][] } }) {
  return errors.mock.calls
    .map((call) => call[0] as { failureSite?: string; step?: string })
    .filter((line) => line?.failureSite === "config.publish-hook")
    .map((line) => line.step);
}
