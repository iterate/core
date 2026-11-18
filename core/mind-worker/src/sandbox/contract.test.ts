// What agents read about sandboxes must be true on every stack. A stack with no named image starts
// the Cloudflare-managed image, which has Node and npm and none of the other tools: a description
// that promised the full list there sent agents to commands that do not exist.
import { expect, test } from "vitest";
import { CLOUDFLARE_MANAGED_IMAGE, SANDBOXES_ROOT_DESCRIPTION } from "./contract.ts";

test("the sandboxes' description gives the tool list to iterate's image alone, and says what the Cloudflare-managed image lacks", () => {
  const at = (text: string) => SANDBOXES_ROOT_DESCRIPTION.indexOf(text);
  // the three things a start with no image and no snapshot can run, in the order it takes them
  const places = {
    mind: at("events.iterate.com/mind/sandbox-image-configured"),
    stack: at("`iterate-dev-image` is one: "),
    tools: at("the Claude, Codex and Grok CLIs"),
    managed: at(`Else \`${CLOUDFLARE_MANAGED_IMAGE}\`: `),
  };
  expect(Object.values(places).every((place) => place >= 0)).toBe(true);
  // the list stands after iterate's image and before the managed one: it is promised for no other
  expect(
    Object.entries(places)
      .sort(([, a], [, b]) => a - b)
      .map(([name]) => name),
  ).toEqual(["mind", "stack", "tools", "managed"]);
  // the managed image's own words say what it lacks, and how an agent finds out
  const managed = SANDBOXES_ROOT_DESCRIPTION.slice(places.managed);
  expect(
    managed.startsWith(`Else \`${CLOUDFLARE_MANAGED_IMAGE}\`: Debian with Node 24 and npm`),
  ).toBe(true);
  expect(managed.includes("no git")).toBe(true);
  expect(SANDBOXES_ROOT_DESCRIPTION.includes("command -v")).toBe(true);
});
