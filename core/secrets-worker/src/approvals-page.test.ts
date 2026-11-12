import { expect, test } from "vitest";
import { ACTS_SCRIPT, mailBodiesOf } from "./acts-page.ts";
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

test("a held mail shows every part that goes: a mail with a text and another HTML shows both", () => {
  expect(
    mailBodiesOf({ text: "See you at 5.", html: "<a href='https://evil.example'>Pay</a>" }),
  ).toEqual([
    { label: "Text part", body: "See you at 5." },
    {
      label: "HTML part, which most mail programs show in place of the text. Its source:",
      body: "<a href='https://evil.example'>Pay</a>",
    },
  ]);
  expect(mailBodiesOf({ text: "See you at 5.", html: null })).toEqual([
    { label: "", body: "See you at 5." },
  ]);
  expect(mailBodiesOf({ text: null, html: "<p>Hi</p>" })).toEqual([
    { label: "This mail has no plain text. Its HTML source:", body: "<p>Hi</p>" },
  ]);
  expect(mailBodiesOf({ text: null, html: null })).toEqual([{ label: "", body: "(no text)" }]);
  // the page runs the same rule, from its own source
  expect([
    ACTS_SCRIPT.includes(`const mailBodiesOf = ${mailBodiesOf.toString()};`),
    ACTS_SCRIPT.includes("for (const part of mailBodiesOf(act))"),
  ]).toEqual([true, true]);
});
