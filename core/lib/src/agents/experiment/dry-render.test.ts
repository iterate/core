// dry-render.test.ts — the chief of staff's next request, rendered from its real rebuilt state the way
// the cached processor will (head snapshot first), written to <DRY>/cos-next-body.json so OpenAI's
// token counter can check the shape before a real input arrives. Not a test: run with DRY=<dir>.
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { buildResponsesInput, RUN_TOOL, stableCapabilityTree, type RenderItem } from "../render.ts";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../system-prompt.ts";

const DRY = process.env.DRY;
test.skipIf(!DRY)("render the chief's next request", () => {
  const state = JSON.parse(readFileSync(`${DRY}/cos-state.json`, "utf8"));
  const src = JSON.parse(readFileSync(`${DRY}/cos-sections-src.json`, "utf8"));
  const sections: Record<string, string> = {
    system: DEFAULT_AGENT_SYSTEM_PROMPT,
    "AGENTS.md": `AGENTS.md (/repos/config), as it is now:\n\n${src.agents}`,
    "chief-of-staff.md": `chief-of-staff.md (/repos/config), as it is now:\n\n${src.role}`,
    "capability-tree": stableCapabilityTree(src.tree)!,
    identity: `CURRENT PROJECT: ${JSON.stringify(src.whoami)}`,
  };
  const last = Math.max(...state.contextItems.map((item: RenderItem) => item.offset));
  const items: RenderItem[] = [
    ...state.contextItems,
    {
      offset: last + 1,
      role: "system",
      content: "[standing instructions: the head snapshot]",
      sections,
      snapshot: true,
      llmRequestOffset: last + 1,
    },
    { offset: last + 2, role: "user", content: "[dry run] (not sent)", actor: { type: "user" } },
  ];
  const input = buildResponsesInput({
    items,
    images: new Map(),
    runs: state.runs,
    model: "gpt-6-astra",
    ownPath: "/agents/chief-of-staff",
  });
  writeFileSync(
    `${DRY}/cos-next-body.json`,
    JSON.stringify({
      model: "gpt-6-astra",
      input,
      tools: [RUN_TOOL],
      tool_choice: "auto",
      parallel_tool_calls: false,
    }),
  );
  const kinds: Record<string, number> = {};
  for (const item of input)
    kinds[String(item.type ?? item.role)] = (kinds[String(item.type ?? item.role)] ?? 0) + 1;
  console.log(JSON.stringify(kinds));
});
