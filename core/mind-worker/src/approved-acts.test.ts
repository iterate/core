import type { ReachableContext } from "core-itx";
import { ACT_DONE, actText } from "iterate/acts";
import { expect, test } from "vitest";
import { runApprovedAct } from "./approved-acts.ts";

test("a verb approved late is called at the context that held it, as its caller's call arrived there, and the fact lands on the caller's context", async () => {
  const mind = pretendMind();
  // the caller's own table may give this name to another function: the act says whose table read it
  const text = actText({
    act: "itx.whatsapp.jo.sendMessage",
    args: ["jo", { text: "hi" }],
    at: "/",
  });

  await runApprovedAct(mind.deps, { digest: "d1", text, from: "/agents/one" });

  expect({ calls: mind.calls, facts: mind.facts }).toEqual({
    calls: [
      {
        at: "/",
        expression: ["itx", "whatsapp", "jo", ["sendMessage", "jo", { text: "hi" }]],
        caller: { principal: null, approvedAct: text, path: "/agents/one" },
      },
    ],
    facts: [
      {
        path: "/agents/one",
        type: ACT_DONE,
        payload: { digest: "d1", act: "itx.whatsapp.jo.sendMessage", ok: true, result: "ran at /" },
      },
    ],
  });
});

test("a verb held at its caller's own context, or by a build that named no context, is called from the caller's context", async () => {
  const mind = pretendMind();
  const here = actText({ act: "itx.config.slack", args: [], at: "/agents/one" });
  const old = actText({ act: "itx.config.slack", args: [] });

  await runApprovedAct(mind.deps, { digest: "d2", text: here, from: "/agents/one" });
  await runApprovedAct(mind.deps, { digest: "d3", text: old, from: "/agents/one" });

  expect(mind.calls.map(({ at, caller }) => ({ at, caller }))).toEqual([
    { at: "/agents/one", caller: { principal: null, approvedAct: here } },
    { at: "/agents/one", caller: { principal: null, approvedAct: old } },
  ]);
});

test("an act that loaded code asked for is called as loaded code", async () => {
  const mind = pretendMind();
  const text = actText({ act: "itx.config.slack", args: [], at: "/", byLoadedCode: true });

  await runApprovedAct(mind.deps, { digest: "d4", text, from: "/" });

  expect(mind.calls.map(({ caller }) => caller)).toEqual([
    { principal: null, approvedAct: text, app: true },
  ]);
});

/** A mind whose every context answers a call with where it ran, and a gate that lets each act go. */
function pretendMind() {
  const calls: { at: string; expression: unknown; caller: unknown }[] = [];
  const facts: { path: string; type: string; payload: unknown }[] = [];
  const deps: Deps = {
    // no mail is sent, so no file is read
    files: {} as R2Bucket,
    // A test's stand-in: a verb's late approval asks the gate once and sends no mail.
    egress: { act: async () => ({ state: "go" }) } as unknown as Deps["egress"],
    contextAt: (at) =>
      // A test's stand-in: `runApprovedAct` reads only `invoke` of the context.
      ({
        invoke: async (expression: unknown, _args: unknown, caller: unknown) => {
          calls.push({ at, expression, caller });
          return `ran at ${at}`;
        },
      }) as unknown as ReachableContext,
    appendAsPlatform: async (path, events) => {
      facts.push(...events.map(({ type, payload }) => ({ path, type, payload })));
    },
  };
  return { deps, calls, facts };
}

type Deps = Parameters<typeof runApprovedAct>[0];
