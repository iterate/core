import { expect, test } from "vitest";
import { ACTS_SCRIPT } from "./acts-page.ts";
import { SCRIPT, tickedAtOpen } from "./approvals-page.ts";

test("the page ticks the one row its link names, and only when its own hash of the row is the row's id", () => {
  expect([
    tickedAtOpen("aaaa", true, "aaaa"),
    // another row of the list, which the member did not come for
    tickedAtOpen("bbbb", true, "aaaa"),
    // opened with no link to a row: the member ticks what they have read
    tickedAtOpen("aaaa", true, null),
    // the text shown is not the text that waits
    tickedAtOpen("aaaa", false, "aaaa"),
  ]).toEqual([true, false, false, false]);
});

test("the page's script carries that rule's own source, and uses it for held requests and for held acts", () => {
  const tick = 'querySelector("[data-pick]").checked = tickedAtOpen(held.digest, good, wanted)';
  expect([
    SCRIPT.includes(`const tickedAtOpen = ${tickedAtOpen.toString()};`),
    SCRIPT.includes(tick),
    ACTS_SCRIPT.includes(tick),
  ]).toEqual([true, true, true]);
});
