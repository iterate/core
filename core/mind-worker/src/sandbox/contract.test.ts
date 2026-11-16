// What agents read about sandboxes must be true on every stack. A stack deployed with no image of
// its own (`mind.sandboxImage: "managed"`) starts Cloudflare's lean image, which has Node and npm
// and none of the other tools: a description that promised the full list there sent agents to
// commands that do not exist.
import { expect, test } from "vitest";
import { SANDBOX_BASE_IMAGE, SANDBOX_IMAGE, SANDBOXES_ROOT_DESCRIPTION } from "./contract.ts";

test("the sandboxes' description gives the tool list to the stack's image alone, and names the lean image", () => {
  const at = (text: string) => SANDBOXES_ROOT_DESCRIPTION.indexOf(text);
  // the three things a start with no image and no disk can run, in the order it takes them
  const places = {
    mind: at("events.iterate.com/mind/sandbox-image-configured"),
    stack: at(`\`${SANDBOX_IMAGE}\`: `),
    lean: at(`\`${SANDBOX_BASE_IMAGE}\`: `),
    tools: at("the Claude, Codex and Grok CLIs"),
  };
  expect(Object.values(places).every((place) => place >= 0)).toBe(true);
  // the list stands after the stack's image and before the lean one: it is promised for no other
  expect(
    Object.entries(places)
      .sort(([, a], [, b]) => a - b)
      .map(([name]) => name),
  ).toEqual(["mind", "stack", "tools", "lean"]);
  // the lean image's own words say what it lacks, and how an agent finds out
  const lean = SANDBOXES_ROOT_DESCRIPTION.slice(places.lean);
  expect(lean.startsWith(`\`${SANDBOX_BASE_IMAGE}\`: Debian with Node 24 and npm`)).toBe(true);
  expect(lean.includes("no git")).toBe(true);
  expect(SANDBOXES_ROOT_DESCRIPTION.includes("command -v")).toBe(true);
});
