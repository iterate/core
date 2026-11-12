// The `email` facet's fold of the mind's mail into threads (./processor.ts): here, the hop count
// of another mind's mail that each thread keeps. Threading by Message-ID is out of scope.
import { reduceProcessor } from "iterate/stream/test-support";
import { expect, test } from "vitest";
import { EmailProcessor } from "./processor.ts";

test("a thread keeps the most hops of another mind's mail received in it", () => {
  const state = reduceProcessor(new EmailProcessor(), [
    received("m1", null, { hops: 3 }),
    sent("m2", "m1"),
    received("m3", "m2", { hops: 5 }),
    received("m4", "m3", { hops: 4 }),
  ]);
  expect(state).toMatchObject({
    threads: { "1": { messageOffsets: [1, 2, 3, 4], mindHops: 5 } },
  });
});

test("a thread with no mind's mail keeps no hop count", () => {
  const state = reduceProcessor(new EmailProcessor(), [
    received("m1", null, null),
    sent("m2", "m1"),
  ]);
  // exactness is the point: no `mindHops` key at all
  expect(state).toEqual({
    threads: { "1": { subject: "Hello", messageOffsets: [1, 2] } },
    threadOffsetByMessageId: { m1: 1, m2: 1 },
  });
});

/** A mail that reached the mind: another mind's at `mind.hops`, or a person's. */
function received(messageId: string, inReplyTo: string | null, mind: { hops: number } | null) {
  return {
    type: "events.iterate.com/email/received",
    payload: {
      ...message(messageId, inReplyTo),
      envelope: { from: "agent@other.example", to: "mind@example.com" },
      sender: { verified: true, member: false, direct: true },
      automated: Boolean(mind),
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
      mind,
    },
  };
}

function sent(messageId: string, inReplyTo: string) {
  return { type: "events.iterate.com/email/sent", payload: message(messageId, inReplyTo) };
}

function message(messageId: string, inReplyTo: string | null) {
  return {
    messageId,
    from: "agent@other.example",
    to: ["mind@example.com"],
    cc: [],
    subject: "Hello",
    text: "A mail.",
    html: null,
    inReplyTo,
    references: inReplyTo ? [inReplyTo] : [],
    attachments: [],
  };
}
