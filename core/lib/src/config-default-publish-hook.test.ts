// The default config's publish hook (core/configs/default/worker.ts, the `mind/worker-updated`
// case): each step by itself. Creating `/agents/main` lives in the onboarding app
// (`apps/onboarding/launch.ts`), not the publish hook.
import { expect, test, vi } from "vitest";
import Config from "../../configs/default/worker.ts";

const PUBLISH = { type: "events.iterate.com/mind/worker-updated", path: "/", offset: 7 };

test("a publish does not create /agents/main (the onboarding app owns agent launch)", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = rootOf();
  await publish(root.itx);
  errors.mockRestore();
  expect(root.calls).not.toContain("agents.create /agents/main");
  expect(root.calls).toContain("contexts.list");
});

test("a step that throws is reported with its name, and the steps and hooks after it still run", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const root = rootOf({ failAgentKinds: true });
  await publish(root.itx);
  const steps = reportedSteps(errors);
  errors.mockRestore();
  expect(steps).toContain("agent-kinds");
  expect(root.calls).toContain("contexts.list");
});

/** A root that records each call's name. Every call that a test does not name answers nothing,
 *  so a step may fail on it: the hook must go on. */
function rootOf(options: { failAgentKinds?: boolean } = {}) {
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
    kv: {
      put: async () => {
        if (options.failAgentKinds) throw new Error("the mind refused this call");
        calls.push("kv.put");
      },
    },
  };
  const itx = {
    agents: {
      create: async (path: string) => {
        calls.push(`agents.create ${path}`);
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
