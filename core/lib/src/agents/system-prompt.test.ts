// system-prompt.test.ts — the standing rules about an agent's own summary that a list depends on.
import { expect, test } from "vitest";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./system-prompt.ts";

test("the prompt keeps an agent's title and description apart from its task of the moment", () => {
  const rule = DEFAULT_AGENT_SYSTEM_PROMPT.split("\n").find((line) => line.includes("setSummary"));
  // the title is who the agent is, set once; a list shows it long after any one task ended
  expect(rule).toContain("not for what you are doing");
  expect(rule).toContain("A new request is not a first turn");
  // the task of the moment has one place, the script's status label
  expect(rule).toContain("what you are doing right now goes in `status`, nowhere else");
  // and a bad title can still be put right
  expect(rule).toContain("when a person renames you");
});
