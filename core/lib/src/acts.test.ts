import { expect, test } from "vitest";
import {
  ActRule,
  actOfText,
  actText,
  mailActOf,
  mailHeaderRefusal,
  mailHeadersOf,
  recipientsRefusal,
  RUN_ACTS_HEADER,
  ruleHolds,
  runApprovedActs,
  rulesTighten,
  sha256Hex,
  verbActOf,
} from "./acts.ts";

test("a mail is one exact text: the same mail sent again is the same act, with no bytes in it", async () => {
  const first = await mailActOf(mail({ headers: { "X-Iterate-Cause": "one" } }));
  const again = await mailActOf(mail({ headers: { "X-Iterate-Cause": "two" } }));
  expect(actText(first)).toBe(actText(again));
  expect(first).toEqual({
    act: "email.send",
    from: "agent@example.com",
    fromName: "The agent",
    replyTo: null,
    to: ["jo@example.net"],
    cc: [],
    subject: "The invoice",
    text: "Attached.",
    html: null,
    inReplyTo: null,
    references: null,
    attachments: [
      {
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: 3,
        sha256: await sha256Hex(new Uint8Array([1, 2, 3])),
        path: "/files/invoice.pdf",
      },
    ],
  });
  expect(JSON.parse(actText(first))).toEqual(first);
  // any change a person would see is another act
  const other = await mailActOf(mail({ subject: "The invoice, again" }));
  expect(actText(other)).not.toBe(actText(first));
  const replyTo = await mailActOf(mail({ headers: { "Reply-To": "elsewhere@example.org" } }));
  expect(replyTo).toMatchObject({ replyTo: "elsewhere@example.org" });
});

test.for([
  ["every mail", { verb: "email.send" }, ["jo@example.net"], true],
  ["a mail to a domain", { verb: "email.send", to: ["*@example.net"] }, ["jo@example.net"], true],
  ["a mail to another domain", { verb: "email.send", to: ["*@example.net"] }, ["jo@x.org"], false],
  [
    "a recipient with a name before its address, which every pattern holds",
    { verb: "email.send", to: ["jo@x.org"] },
    ["Jo <JO@x.org>"],
    true,
  ],
  [
    "a domain that only ends alike",
    { verb: "email.send", to: ["*@x.org"] },
    ["jo@notx.org"],
    false,
  ],
  ["a verb's rule", { verb: "itx.whatsapp.sendMessage" }, ["jo@example.net"], false],
] as const)("a mail rule holds %s", async ([, rule, to, held]) => {
  const act = await mailActOf(mail({ to: [...to] }));
  expect(ruleHolds(ActRule.parse(rule), act)).toBe(held);
});

test("a late approval names its acts by their ids, so the vault's answer stays small whatever the acts hold", async () => {
  const digests = await Promise.all(
    Array.from({ length: 50 }, (_unused, index) => sha256Hex(`act ${index}`)),
  );
  const named = digests.join(",");
  // fifty acts, the most the gate holds: far under what a header may carry
  expect(named.length).toBeLessThan(4096);
  const ran: string[] = [];
  const { answer, ran: all } = runApprovedActs(
    Response.json({ ok: true }, { headers: { [RUN_ACTS_HEADER]: `${named},not-an-id` } }),
    async (digest) => void ran.push(digest),
  );
  await all;
  expect(ran).toEqual(digests);
  // the header is the boundary's alone: it does not go on to the browser
  expect(answer.headers.has(RUN_ACTS_HEADER)).toBe(false);
  expect(await answer.json()).toEqual({ ok: true });
});

test("a copy counts as a recipient", async () => {
  const act = await mailActOf(mail({ to: ["a@x.org"], cc: ["jo@example.net"] }));
  expect(ruleHolds(ActRule.parse({ verb: "email.send", to: ["*@example.net"] }), act)).toBe(true);
});

test("a held call may carry the kernel's mark of what its name was, and nothing else beside its name and arguments", () => {
  const act = { act: "itx.whatsapp.sendMessage", args: ["jo"], resolved: "a".repeat(64) };
  expect(actOfText(JSON.stringify(act))).toEqual(act);
  expect(actOfText(JSON.stringify({ ...act, platform: true }))).toBeNull();
});

test("a held call may name the context whose table read its name, as a path of the mind, and say that loaded code asked", () => {
  const act = { act: "itx.whatsapp.sendMessage", args: ["jo"], at: "/agents/one" };
  expect(actOfText(JSON.stringify(act))).toEqual(act);
  expect(actOfText(JSON.stringify({ ...act, at: "agents/one" }))).toBeNull();
  expect(actOfText(JSON.stringify({ ...act, byLoadedCode: true }))).toEqual({
    ...act,
    byLoadedCode: true,
  });
  expect(actOfText(JSON.stringify({ ...act, byLoadedCode: false }))).toBeNull();
});

test.for([
  ["a name before the address", "Jo <jo@example.net>"],
  // a rule and an approver would read safe@example.org; the mail service sends to the last address
  ["a name that holds another address", '"<safe@example.org>" <leak@example.net>'],
  ["two addresses in one", "a@example.org, leak@example.net"],
  ["an address in angle brackets", "<jo@example.net>"],
  ["a space", "jo @example.net"],
  ["no address at all", "undisclosed-recipients:;"],
])("a recipient with %s is refused: the boundary sends to one address alone", ([, recipient]) => {
  expect(recipientsRefusal(["a@example.org", recipient])).toContain("its address alone");
});

test("recipients that are each one address are taken", () => {
  // a tag, capitals and an apostrophe are parts of real addresses
  expect(
    recipientsRefusal(["a@example.org", "Jo.Smith+tag@Sub.Example.net", "o'brien@example.org"]),
  ).toBeNull();
  expect(recipientsRefusal([])).toBeNull();
  expect(recipientsRefusal(["a@example.org", ""])).toContain("its address alone");
});

test("a recipient that is no single address is held by every rule for mail, whatever its pattern", async () => {
  // such a mail never leaves the boundary; were one asked about, no pattern would let it by
  const act = { ...(await mailActOf(mail())), to: ['"<safe@example.org>" <leak@example.net>'] };
  expect(ruleHolds(ActRule.parse({ verb: "email.send", to: ["*@example.net"] }), act)).toBe(true);
  expect(ruleHolds(ActRule.parse({ verb: "email.send", to: ["nobody@x.org"] }), act)).toBe(true);
});

test("a domain with a dot at an end is no address: the same host by another text would pass a rule for the domain", async () => {
  for (const recipient of ["jo@example.net.", "jo@.example.net", "jo@example..net"])
    expect(recipientsRefusal([recipient])).toContain("its address alone");
  // such a mail never leaves the boundary; were one asked about, the rule for its domain holds it
  const act = { ...(await mailActOf(mail())), to: ["jo@example.net."] };
  expect(ruleHolds(ActRule.parse({ verb: "email.send", to: ["*@example.net"] }), act)).toBe(true);
});

test("a rule that names an address holds the same mailbox with a tag, and no other mailbox", async () => {
  const tagged = await mailActOf(mail({ to: ["Jo+bills@example.net"] }));
  const to = (address: string) => ActRule.parse({ verb: "email.send", to: [address] });
  expect([
    ruleHolds(to("jo@example.net"), tagged),
    ruleHolds(to("joe@example.net"), tagged),
    ruleHolds(to("jo@example.org"), tagged),
    // a rule that names the tag holds that tag
    ruleHolds(to("jo+bills@example.net"), tagged),
    ruleHolds(to("jo+other@example.net"), tagged),
  ]).toEqual([true, false, false, true, false]);
});

test.for([
  ["the subject", { subject: "The invoice\r\nBcc: leak@example.net" }],
  [
    "the sender's name",
    { from: { email: "agent@example.com", name: "The agent\nBcc: leak@example.net" } },
  ],
  ["Reply-To", { headers: { "Reply-To": "jo@example.com\r\nBcc: leak@example.net" } }],
  ["In-Reply-To", { headers: { "In-Reply-To": "<m1@example.org>\nBcc: leak@example.net" } }],
  ["References", { headers: { References: "<m0@example.org>\r<m1@example.org>" } }],
] as const)(
  "a mail with a line break in %s is refused: what follows it would be a header that nobody read",
  async ([field, change]) => {
    expect(mailHeaderRefusal(await mailActOf(mail(change)))).toContain(field);
  },
);

test("a mail whose headers are each one line is taken", async () => {
  const given = { "Reply-To": "jo@example.com", References: "<m0@example.org> <m1@example.org>" };
  expect(mailHeaderRefusal(await mailActOf(mail({ headers: given })))).toBeNull();
  // a body has as many lines as it likes
  expect(mailHeaderRefusal(await mailActOf(mail({ text: "one\ntwo" })))).toBeNull();
});

test("the mail that goes has the act's own three headers and no other that its sender gave", async () => {
  const given = {
    "reply-to": "alice@example.com",
    // a second one in another letter case, a blind copy and a resend: no approver saw them
    "Reply-To": "attacker@example.net",
    Bcc: "leak@example.net",
    "Resent-To": "leak@example.net",
    "In-Reply-To": "<m1@example.org>",
    References: "<m0@example.org> <m1@example.org>",
    "Auto-Submitted": "auto-generated",
    "X-Iterate-Cause": "one",
  };
  const act = await mailActOf(mail({ headers: given }));
  expect(mailHeadersOf(act, given)).toEqual({
    "Reply-To": "alice@example.com",
    "In-Reply-To": "<m1@example.org>",
    References: "<m0@example.org> <m1@example.org>",
    "Auto-Submitted": "auto-generated",
  });
  // what the act holds is what the approver's page shows as "Replies go to"
  expect(act).toMatchObject({ replyTo: "alice@example.com" });
  expect(mailHeadersOf(await mailActOf(mail()), { "Auto-Submitted": "no; Bcc: x@y.z" })).toEqual(
    {},
  );
});

test("a verb's rule holds that verb, or every verb under a prefix, and no other", () => {
  const send = { act: "itx.whatsapp.sendMessage", args: ["jo", { text: "hello" }] };
  expect(ruleHolds(ActRule.parse({ verb: "itx.whatsapp.sendMessage" }), send)).toBe(true);
  expect(ruleHolds(ActRule.parse({ verb: "itx.whatsapp.*" }), send)).toBe(true);
  expect(ruleHolds(ActRule.parse({ verb: "itx.whatsapp.send" }), send)).toBe(false);
  expect(ruleHolds(ActRule.parse({ verb: "itx.whats.*" }), send)).toBe(false);
  expect(ruleHolds(ActRule.parse({ verb: "email.send" }), send)).toBe(false);
});

test("the gate reads a verb's rule as the kernel does: the rule's name and every name under it, with .* or without", () => {
  // the kernel holds these two calls and asks the gate, which must not free them
  const under = { act: "itx.whatsapp.sendMessage.now", args: ["jo"] };
  const itself = { act: "itx.whatsapp", args: ["jo"] };
  expect(ruleHolds(ActRule.parse({ verb: "itx.whatsapp.sendMessage" }), under)).toBe(true);
  expect(ruleHolds(ActRule.parse({ verb: "itx.whatsapp" }), under)).toBe(true);
  expect(ruleHolds(ActRule.parse({ verb: "itx.whatsapp.*" }), itself)).toBe(true);
  // a name that only begins with the same letters is another name
  expect(ruleHolds(ActRule.parse({ verb: "itx.whats" }), itself)).toBe(false);
  expect(ruleHolds(ActRule.parse({ verb: "itx.whats.*" }), itself)).toBe(false);
  expect(ruleHolds(ActRule.parse({ verb: "itx.whatsapp.send" }), under)).toBe(false);
});

test("a rule is a verb, with recipients for a mail alone", () => {
  for (const rule of [
    { verb: "secrets.set" },
    { verb: "itx" },
    { verb: "itx.*" },
    { verb: "itx.whatsapp.*.send" },
    { verb: "itx.whatsapp.sendMessage", to: ["*"] },
    { verb: "email.send", to: [] },
    { verb: "email.send", to: ["example.net"] },
    { verb: "email.send", extra: true },
  ])
    expect(ActRule.safeParse(rule)).toHaveProperty("success", false);
  expect(ActRule.parse({ verb: "email.send", to: ["*@B.com", "a@b.com", "*@b.com"] })).toEqual({
    verb: "email.send",
    to: ["*@b.com", "a@b.com"],
  });
});

test("a held verb's arguments are plain JSON", () => {
  expect(verbActOf("itx.whatsapp.sendMessage", ["jo", { text: "hi", n: [1, null] }])).toEqual({
    act: "itx.whatsapp.sendMessage",
    args: ["jo", { text: "hi", n: [1, null] }],
  });
  for (const args of [[new Uint8Array(2)], [() => {}], [{ at: new Date(0) }], [undefined]])
    expect(verbActOf("itx.whatsapp.sendMessage", args)).toHaveProperty("refused");
});

test.for([
  [
    "one more rule",
    [{ verb: "email.send", to: ["*@a.com"] }],
    [{ verb: "email.send", to: ["*@a.com"] }, { verb: "itx.x.y" }],
    true,
  ],
  [
    "one more recipient",
    [{ verb: "email.send", to: ["*@a.com"] }],
    [{ verb: "email.send", to: ["*@a.com", "*@b.com"] }],
    true,
  ],
  [
    "every mail in place of some",
    [{ verb: "email.send", to: ["*@a.com"] }],
    [{ verb: "email.send" }],
    true,
  ],
  ["a prefix in place of a verb", [{ verb: "itx.x.y" }], [{ verb: "itx.x.*" }], true],
  [
    "a rule removed",
    [{ verb: "email.send" }, { verb: "itx.x.y" }],
    [{ verb: "email.send" }],
    false,
  ],
  [
    "a recipient removed",
    [{ verb: "email.send", to: ["*@a.com", "*@b.com"] }],
    [{ verb: "email.send", to: ["*@a.com"] }],
    false,
  ],
  [
    "some mail in place of every mail",
    [{ verb: "email.send" }],
    [{ verb: "email.send", to: ["*@a.com"] }],
    false,
  ],
  ["a verb in place of a prefix", [{ verb: "itx.x.*" }], [{ verb: "itx.x.y" }], false],
  // with .* or without, a rule holds its name and every name under it
  ["a name in place of every verb under it", [{ verb: "itx.x.*" }], [{ verb: "itx.x" }], true],
  [
    "every verb under a name in place of the name",
    [{ verb: "itx.x" }],
    [{ verb: "itx.x.*" }],
    true,
  ],
  ["a name above in place of a verb", [{ verb: "itx.x.y" }], [{ verb: "itx.x" }], true],
  ["a verb under a name in place of the name", [{ verb: "itx.x" }], [{ verb: "itx.x.y" }], false],
  ["a name that only begins the same", [{ verb: "itx.xy" }], [{ verb: "itx.x" }], false],
] as const)("%s: tighter is %s", ([, before, after, tighter]) => {
  const parsed = (rules: readonly unknown[]) => rules.map((rule) => ActRule.parse(rule));
  expect(rulesTighten(parsed(before), parsed(after))).toBe(tighter);
});

function mail(
  change: Partial<Parameters<typeof mailActOf>[0]> = {},
): Parameters<typeof mailActOf>[0] {
  return {
    from: { email: "Agent@example.com", name: "The agent" },
    to: ["jo@example.net"],
    cc: [],
    subject: "The invoice",
    text: "Attached.",
    headers: {},
    attachments: [
      {
        filename: "invoice.pdf",
        contentType: "application/pdf",
        content: new Uint8Array([1, 2, 3]),
        path: "/files/invoice.pdf",
      },
    ],
    ...change,
  };
}
