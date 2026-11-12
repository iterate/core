import { Script } from "node:vm";
import { expect, test } from "vitest";
import { ITX_PERSON_HEADER, ITX_PRINCIPAL_HEADER } from "iterate/principal";
import { ACTS_SCRIPT, mailBodiesOf, proposedRules, secretRuleInWords } from "./acts-page.ts";
import { ruleForm, SCRIPT, secretApprovals, tickedAtOpen } from "./approvals-page.ts";

test("no value of the page comes from its address: a link with a rule's words in its query fills in nothing", async () => {
  // the link of an earlier build, which filled the form 'A new rule' from its query
  const link =
    "https://iterate.example.com/secrets/approvals?path=/secrets/from-a-link&methods=PATCH&hosts=evil.example&jsonStrings=Zzyzx&freePaths=/zz/";
  const member = { userId: "user_1", email: "jo@example.net" };
  const opened = await secretApprovals(
    new Request(link, {
      headers: {
        [ITX_PERSON_HEADER]: JSON.stringify(member),
        [ITX_PRINCIPAL_HEADER]: JSON.stringify({ actor: member.userId, email: member.email }),
      },
    }),
    {
      mind: "example.com",
      index: { paths: async () => [], remove: async () => undefined },
      // no secret has a rule, so none is read; and the page's GET decides nothing
      secretOf: () => {
        throw new Error("the page read a secret");
      },
      gate: {
        state: async () => ({ locked: false, rules: [], proposed: [], held: [] }),
        setRules: async () => ({ facts: [] }),
        decide: async () => ({ result: {}, facts: [] }),
        proposalTaken: async () => ({ facts: [] }),
        rejectProposal: async () => ({ facts: [] }),
      },
    },
  );
  const html = await opened.text();
  // the form that a member fills by hand, as it is with no link: its own first values, one Save
  for (const plain of [
    'name="path" value="/secrets/"',
    'name="methods" value="POST"',
    'name="hosts" value=""',
    'name="jsonStrings" value=""',
    'name="freePaths" value=""',
    '<button type="submit">Save</button>',
  ])
    expect(html).toContain(plain);
  for (const fromTheLink of ["/secrets/from-a-link", "PATCH", "evil.example", "Zzyzx", "/zz/"])
    expect(html).not.toContain(fromTheLink);
  // a new rule has no signed buttons: those are for a rule that a secret has
  expect(ruleForm("", null)).not.toContain("data-sign-rule");
});

test("a proposed rule waits as a held act does: a row to tick with what it holds, what stays free, its exact text and who asked, and the two buttons of what waits", () => {
  const rule = {
    secret: "/secrets/fastmail",
    methods: ["POST"],
    hosts: ["api.fastmail.com"],
    jsonStrings: ["EmailSubmission/set"],
    freePaths: ["/jmap/upload/"],
  };
  expect(secretRuleInWords(rule)).toBe(
    "A request with /secrets/fastmail waits when it is POST to api.fastmail.com and its JSON body holds EmailSubmission/set (a body that is no JSON waits too). What stays free: a request whose JSON body holds none of them; a request to /jmap/upload/, whatever its body; every other method and host.",
  );
  const listed = proposedRules({
    locked: true,
    rules: [],
    held: [],
    proposed: [
      { id: "p1", rule, from: "/agents/a", at: 0 },
      { id: "p2", rule: { verb: "email.send" }, at: 0 },
    ],
  });
  // a row as a held act's is: a box to tick, and the two buttons of what waits
  expect(listed.match(/<input type="checkbox" data-pick="p[12]">/g)).toHaveLength(2);
  expect(listed).toContain('<button type="button" data-approve>Approve the chosen</button>');
  expect(listed).toContain("data-reject>Reject them</button>");
  expect(listed).toContain("A proposed rule, asked for from /agents/a at 1970-01-01 00:00 UTC.");
  expect(listed).toContain("/secrets/fastmail has no rule now.");
  // the exact rule under its words, written as text
  expect(listed.replaceAll(/&(?:quot|#34);/g, '"')).toContain('"EmailSubmission/set"');
  // approved, it takes the place of the rule that is there: the row says which one that is
  expect(
    proposedRules(
      { locked: true, rules: [], held: [], proposed: [{ id: "p1", rule, at: 0 }] },
      () => ({ methods: ["POST", "PUT"], hosts: ["api.fastmail.com"] }),
    ),
  ).toContain(
    "It takes the place of the rule that /secrets/fastmail has now: A request with /secrets/fastmail waits when it is POST or PUT to api.fastmail.com. What stays free: every other method and host.",
  );
  // nothing proposed: no part of the page
  expect(proposedRules({ locked: true, rules: [], held: [], proposed: [] })).toBe("");
});

test("the page's script parses: a slip in the template that holds it shows here, and not in a member's browser", () => {
  expect(() => new Script(`${SCRIPT}${ACTS_SCRIPT}`)).not.toThrow();
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
