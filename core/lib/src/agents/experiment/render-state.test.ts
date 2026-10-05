// render-state.test.ts — an agent's current conversation as the cached processor would send it, from a
// state dump (snapshot's contextItems, runs, creation): RENDER_STATE=<state.json> RENDER_OUT=<out.json>.
// Not a test. The standing sections come from the state's own head snapshot.
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { buildResponsesInput, RUN_TOOL, type RenderItem } from "../render.ts";

test.skipIf(!process.env.RENDER_STATE)("render an agent's state", () => {
  const state = JSON.parse(readFileSync(process.env.RENDER_STATE!, "utf8"));
  const path = process.env.RENDER_PATH || "/agents/chief-of-staff";
  const input = buildResponsesInput({
    items: state.contextItems as RenderItem[],
    images: new Map(),
    runs: state.runs,
    model: "gpt-6.1-sol",
    ownPath: path,
  });
  writeFileSync(process.env.RENDER_OUT!, JSON.stringify({ input, tools: [RUN_TOOL] }));
});
