import { expect, test } from "vitest";
import { ACTS_SCRIPT, mailBodiesOf } from "./acts-page.ts";
import { ruleForm, ruleFromLink, SCRIPT, tickedAtOpen } from "./approvals-page.ts";

test("a link fills in a secret's rule under 'A new rule': the page shows its words, and saves nothing by itself", () => {
  const link = new URL(
    "https://iterate.example.com/secrets/approvals?path=/secrets/fastmail&methods=POST&hosts=api.fastmail.com&jsonStrings=EmailSubmission/set&freePaths=/jmap/upload/#offered",
  );
  const offered = ruleFromLink(link.searchParams);
  expect(offered).toEqual({
    path: "/secrets/fastmail",
    rule: {
      methods: ["POST"],
      hosts: ["api.fastmail.com"],
      jsonStrings: ["EmailSubmission/set"],
      freePaths: ["/jmap/upload/"],
    },
  });
  const form = ruleForm("", offered!.rule, offered!.path);
  // the form that a member fills by hand, with the link's words in its fields, and its one Save
  for (const filled of [
    'name="path" value="/secrets/fastmail"',
    'name="methods" value="POST"',
    'name="hosts" value="api.fastmail.com"',
    'name="jsonStrings" value="EmailSubmission/set"',
    'name="freePaths" value="/jmap/upload/"',
    "A link filled in this rule for /secrets/fastmail.",
    "nothing is saved until you press Save",
    '<button type="submit">Save</button>',
  ])
    expect(form).toContain(filled);
  // a new rule has no signed buttons: those are for a rule that a secret has
  expect(form).not.toContain("data-sign-rule");
});

test.for([
  ["no path", "methods=POST&hosts=example.com"],
  ["a path that is no secret's", "path=/agents/one&methods=POST&hosts=example.com"],
  ["a path with markup", "path=/secrets/%3Cscript%3E&methods=POST"],
])("a link with %s offers no rule", ([, query]) => {
  expect(ruleFromLink(new URLSearchParams(query))).toBeNull();
});

test("a link's words are written into the form as text, and a long list is cut", () => {
  const offered = ruleFromLink(
    new URLSearchParams({
      path: "/secrets/x",
      methods: "POST",
      hosts: `"><script>alert(1)</script>, ${Array.from({ length: 40 }, (_, at) => `h${at}.example`).join(",")}`,
    }),
  )!;
  expect(offered.rule.hosts).toHaveLength(20);
  const form = ruleForm("", offered.rule, offered.path);
  expect(form).not.toContain("<script>alert(1)");
});

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
