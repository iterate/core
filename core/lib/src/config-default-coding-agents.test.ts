// The default config hosts the sandbox runner for coding agents (core/configs/default/worker.ts:
// `acpSandbox()` in `integrations`, the `acp` kind in `agentKinds`; coding-agents.md). What a
// publish of a new mind does with it, on a root that records each call: the runner's rule and its
// two secrets are made, and the Dash is told where the kind's file is. The runner's own tests are
// with its source, which the template's files copy.
import { expect, test } from "vitest";
import Config from "../../configs/default/worker.ts";

const PUBLISH = { type: "events.iterate.com/mind/worker-updated", path: "/", offset: 7 };
const RULE = "events.iterate.com/itx/rewrite-rule-configured";

test("a publish makes the rule itx.acp.sandbox, which loads acp-sandbox.ts from the published config", async () => {
  const root = recordingRoot();
  await publish(root.itx);
  const rules = root.calls
    .filter((call) => call.path === "append")
    .flatMap(
      (call) => call.args as { type?: string; payload?: { match?: string; target?: unknown } }[],
    )
    .filter((event) => event.type === RULE && event.payload?.match === "itx.acp.sandbox");
  expect(rules.map((rule) => rule.payload?.target)).toEqual([
    [
      "itx",
      "workers",
      ["get", { mainModule: "acp-sandbox.ts", source: ["itx", ["cd", "/"], "config"] }],
    ],
  ]);
});

test("a publish makes the runner's two secrets, each pinned to the runner's own host", async () => {
  const root = recordingRoot();
  await publish(root.itx);
  const made = root.calls
    .filter((call) => call.path === "secrets.set")
    .map((call) => ({ path: call.args[0], urls: (call.args[2] as { urls?: string[] })?.urls }));
  expect(made.toSorted((a, b) => String(a.path).localeCompare(String(b.path)))).toEqual([
    { path: "/secrets/acp-sandbox", urls: ["https://acp-sandbox.example.com"] },
    { path: "/secrets/acp-sandbox-egress", urls: ["https://acp-sandbox.example.com"] },
  ]);
  // each value is 32 random bytes, drawn at the publish and never read back
  const values = root.calls
    .filter((call) => call.path === "secrets.set")
    .map((call) => String(call.args[1]));
  for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/);
  expect([...new Set(values)]).toHaveLength(2);
});

test("a publish that finds the rule there adds none", async () => {
  const first = recordingRoot();
  await publish(first.itx);
  const [made] = first.calls
    .filter((call) => call.path === "append")
    .flatMap(
      (call) =>
        call.args as { type?: string; payload?: { match?: string; description?: string } }[],
    )
    .filter((event) => event.type === RULE && event.payload?.match === "itx.acp.sandbox");
  const second = recordingRoot({
    "rewriteRules.get": (match: string) =>
      match === "itx.acp.sandbox" ? { description: made!.payload!.description } : null,
  });
  await publish(second.itx);
  const again = second.calls
    .filter((call) => call.path === "append")
    .flatMap((call) => call.args as { type?: string; payload?: { match?: string } }[])
    .filter((event) => event.type === RULE && event.payload?.match === "itx.acp.sandbox");
  expect(again).toHaveLength(0);
});

test("a publish tells the Dash where the acp kind's file is, beside the iterate kind's", async () => {
  const root = recordingRoot();
  await publish(root.itx);
  const told = root.calls
    .filter((call) => call.path === "kv.put")
    .map((call) => `${String(call.args[0])} ${String(call.args[1])}`);
  const kinds = told.find((line) => line.includes("agent-kinds/acp.ts"));
  expect(kinds).toBeDefined();
  expect(kinds).toContain("agent-kinds/iterate.ts");
});

/** A root that records every call by its path (`secrets.set`, `append`, `kv.put`; a call on
 *  another context is `cd(<path>).append`) and answers nothing, or what `answers` says. A handle
 *  (`repos.get(…)`, `agents.get(…)`) is a root of its own name. */
function recordingRoot(answers: Record<string, (...args: never[]) => unknown> = {}) {
  const calls: { path: string; args: unknown[] }[] = [];
  const defaults: Record<string, (...args: never[]) => unknown> = {
    url: ((input?: { routingSlug?: string; path?: string }) =>
      `https://${input?.routingSlug ? `${input.routingSlug}.` : ""}example.com${input?.path || "/"}`) as never,
    "rewriteRules.get": () => null,
    "secrets.describe": () => ({ set: false }),
    // the vault's own refusal for a secret that is not there (core/lib `errorCode`)
    "secrets.verifyHmac": () => {
      throw Object.assign(new Error("not set"), { code: "SECRET_NOT_SET" });
    },
    "secrets.list": () => [],
    "contexts.list": () => [],
    "kv.get": () => null,
    ...answers,
  };
  const HANDLES = /^(repos|agents|facets|sandboxes|workers|files)\.get$|^cd$/;
  const node = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_target, key) =>
        typeof key === "symbol" || key === "then" ? undefined : node(path ? `${path}.${key}` : key),
      apply: (_target, _self, args: unknown[]) => {
        const name = path.replace(/^(cd\([^)]*\)\.)+/, "");
        if (HANDLES.test(name))
          return node(
            `${path.replace(/\.?[a-zA-Z]+\.get$|\.?cd$/, "")}${name === "cd" ? `cd(${String(args[0])})` : `${name}(${String(args[0])})`}`.replace(
              /^\./,
              "",
            ),
          );
        calls.push({ path, args });
        const answer = defaults[name];
        return (async () =>
          answer ? (answer as (...a: unknown[]) => unknown)(...args) : undefined)();
      },
    });
  return { itx: node(""), calls };
}

function publish(itx: unknown) {
  // the entrypoint's own state is not the case's: the method is called on a bare instance
  const config = Object.create(Config.prototype) as { processEvent(args: unknown): Promise<void> };
  // a later hook may still reject on this small root: what is asked here is what ran before it
  return config.processEvent({ event: PUBLISH, itx }).catch(() => {});
}
