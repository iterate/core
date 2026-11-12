// The default config's mail rules (core/configs/default/mail-replies.ts): which agent a received
// mail reaches, and what an agent learns when its mail was not delivered. The worker's reads of the
// email facet and log are out of scope.
import { expect, test } from "vitest";
import {
  deliveryFailureNote,
  whoGetsTheMail,
  type MailSender,
} from "../../configs/default/mail-replies.ts";

const member: MailSender = { verified: true, member: true, direct: true };
const outsider: MailSender = { verified: true, member: false, direct: true };

test.for([
  {
    name: "an outside person's reply to a mail an agent sent goes to that agent, marked as outside",
    sender: outsider,
    sentFrom: ["/agents/web/a1"],
    expected: { agent: "/agents/web/a1", from: "outside" },
  },
  {
    name: "a reply goes to the newest agent that wrote in the thread",
    sender: outsider,
    sentFrom: ["/agents/web/a1", "/integrations/email", "/agents/web/a2"],
    expected: { agent: "/agents/web/a2", from: "outside" },
  },
  {
    name: "an outside person's mail that no agent's mail came before reaches no agent",
    sender: outsider,
    sentFrom: [],
    expected: null,
  },
  {
    name: "an outside person's mail reaches no agent when only non-agent contexts sent in the thread",
    sender: outsider,
    sentFrom: ["/integrations/email", "/"],
    expected: null,
  },
  {
    name: "a member's reply goes to the agent that wrote",
    sender: member,
    sentFrom: ["/agents/web/a1"],
    expected: { agent: "/agents/web/a1", from: "member" },
  },
  {
    name: "a member's new thread goes to the thread's own agent",
    sender: member,
    sentFrom: [],
    expected: { agent: null, from: "member" },
  },
  {
    name: "a member's forwarded mail counts as outside",
    sender: { verified: true, member: true, direct: false },
    sentFrom: ["/agents/web/a1"],
    expected: { agent: "/agents/web/a1", from: "outside" },
  },
  {
    name: "a member's forwarded mail that starts a thread reaches no agent",
    sender: { verified: true, member: true, direct: false },
    sentFrom: [],
    expected: null,
  },
  {
    name: "an unproven sender's reply reaches no agent",
    sender: { verified: false, member: false, direct: false },
    sentFrom: ["/agents/web/a1"],
    expected: null,
  },
])("$name", ({ sender, sentFrom, expected }) => {
  // exactness is the point: `null` and the agent's path
  expect(whoGetsTheMail({ sender, automated: false, sentFrom })).toEqual(expected);
});

test("an automated mail reaches no agent, even a member's reply to an agent", () => {
  expect(whoGetsTheMail({ sender: member, automated: true, sentFrom: ["/agents/web/a1"] })).toBe(
    null,
  );
});

test("the agent that sent an undelivered mail learns why, and not to send it again", () => {
  expect(
    deliveryFailureNote(failure({ permanent: true, cause: "mailbox unknown" }), {
      origin: "/agents/web/a1",
      subject: "Your order",
    }),
  ).toMatchObject({
    agent: "/agents/web/a1",
    content: [
      "Your mail to ada@example.com was not delivered (bounced, permanent): mailbox unknown.",
      "Its subject: Your order",
      "Do not send it again to the same address unless a member says so.",
    ].join("\n\n"),
  });
});

test("a mail its recipient called spam was delivered: the agent learns of the complaint, and to write there no more", () => {
  expect(
    deliveryFailureNote(failure({ kind: "complained", cause: "abuse" }), {
      origin: "/agents/web/a1",
      subject: "Your order",
    }),
  ).toMatchObject({
    content: [
      "Your mail to ada@example.com was delivered, and its recipient reported it as spam (abuse).",
      "Its subject: Your order",
      "Do not write to that address again unless a member says so.",
    ].join("\n\n"),
  });
});

test("an undelivered mail that no agent sent tells no agent", () => {
  expect(deliveryFailureNote(failure({}), { origin: "/", subject: "Hello" })).toBe(null);
});

function failure(overrides: Partial<Parameters<typeof deliveryFailureNote>[0]>) {
  return {
    messageId: "m1@example.com",
    to: "ada@example.com",
    kind: "bounced" as const,
    permanent: null,
    cause: null,
    detail: null,
    ...overrides,
  };
}
