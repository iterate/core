import type { ItxHostRootContext, ReachableContext } from "core-itx";
import type { GateAnswer } from "iterate/acts";
import type { Door } from "iterate/workers";
import { expect, test } from "vitest";
import { emailRoot } from "./email.ts";

test("a held mail keeps no reservation while it waits, so a retry of its delivery is not refused", async () => {
  const mind = mindWith([held, { sent: true, messageId: "<m1@example.com>" }]);
  const recorded = await mind.send();
  expect(mind).toMatchObject({
    asked: [
      { wait: false, reserved: ["delivery-1"] },
      // the wait for a member's answer: the reservation is given up before it
      { wait: true, reserved: [] },
    ],
  });
  expect(recorded).toMatchObject({ type: "events.iterate.com/email/sent" });
});

test("a mail no rule holds is reserved while it goes, and a held mail nobody approves leaves no reservation", async () => {
  const free = mindWith([{ sent: true, messageId: "<m2@example.com>" }]);
  await free.send();
  expect(free).toMatchObject({ asked: [{ wait: false, reserved: ["delivery-1"] }] });

  const waiting: GateAnswer = { state: "waiting", digest: "d".repeat(64), facts: [] };
  const unanswered = mindWith([held, { sent: false, error: "it waits", gate: waiting }]);
  await expect(unanswered.send()).rejects.toThrow("waits for a member's approval");
  expect(unanswered.reservations()).toEqual([]);
});

test("a recipient that is no single address is refused before anything is reserved or asked", async () => {
  const mind = mindWith([{ sent: true, messageId: "<m3@example.com>" }]);
  await expect(mind.send('"<safe@example.org>" <leak@example.net>')).rejects.toThrow(
    "its address alone",
  );
  expect({ asked: mind.asked, reserved: mind.reservations() }).toEqual({ asked: [], reserved: [] });
});

test("a subject with a line break is refused before anything is reserved or asked: a header is one line", async () => {
  const mind = mindWith([{ sent: true, messageId: "<m4@example.com>" }]);
  await expect(mind.send("jo@example.org", "Hello\r\nBcc: leak@example.net")).rejects.toThrow(
    "the subject has a line break",
  );
  expect({ asked: mind.asked, reserved: mind.reservations() }).toEqual({ asked: [], reserved: [] });
});

test("an answer to a mail whose subject arrived as two lines goes with that subject on one line", async () => {
  const mind = mindWith([{ sent: true, messageId: "<m5@example.com>" }], {
    messageId: "m0@example.org",
    from: "mind@example.com",
    to: ["jo@example.org"],
    cc: [],
    subject: "Hello\r\nBcc: leak@example.net",
    text: "A mail.",
    html: null,
    inReplyTo: null,
    references: [],
    attachments: [],
  });
  await mind.answer(7);
  expect(mind.sent.map((message) => message.subject)).toEqual(["Re: Hello Bcc: leak@example.net"]);
});

test("a mail the provider refuses is said on the mail log, and the caller still gets the refusal", async () => {
  const mind = mindWith([
    { sent: false, error: "the recipient is suppressed", code: "E_RECIPIENT_SUPPRESSED" },
  ]);
  await expect(mind.send()).rejects.toThrow(
    "itx.email.send: the boundary refused it: the recipient is suppressed",
  );
  expect(mind.appended).toMatchObject([
    {
      event: {
        type: "events.iterate.com/email/send-failed",
        payload: {
          from: "mind@example.com",
          to: ["jo@example.org"],
          cc: [],
          subject: "Hello",
          error: "the recipient is suppressed",
          code: "E_RECIPIENT_SUPPRESSED",
        },
      },
      // as the platform, from the context that sent it
      caller: { platform: true, path: "/agents/one" },
    },
  ]);
  expect(mind.reservations()).toEqual([]);
});

test("a refusal whose fact does not land still reaches the caller as the provider's refusal", async () => {
  const mind = mindWith([{ sent: false, error: "the provider is down" }], undefined, {
    appendFails: true,
  });
  await expect(mind.send()).rejects.toMatchObject({
    code: "UNAVAILABLE",
    message: "itx.email.send: the boundary refused it: the provider is down",
  });
});

test("a mail an approval rule refuses records no send-failed fact: the gate's facts say it", async () => {
  const rejected: GateAnswer = {
    state: "rejected",
    digest: "d".repeat(64),
    facts: [],
    by: "jo@example.org",
    reason: "no",
  };
  const mind = mindWith([{ sent: false, error: "rejected", gate: rejected }]);
  await expect(mind.send()).rejects.toThrow("rejected");
  expect(mind).toMatchObject({ appended: [] });
});

type Outcome = Awaited<ReturnType<Door["sendEmail"]>>;

const held: Outcome = {
  sent: false,
  error: "it waits",
  gate: { state: "held", digest: "d".repeat(64), facts: [] },
};

/** A mind whose boundary answers `outcomes` in turn. `asked` keeps, for each call of the boundary,
 *  whether it waits and which reservations stand at that moment. */
function mindWith(
  outcomes: Outcome[],
  stored?: Record<string, unknown>,
  options: { appendFails?: boolean } = {},
) {
  const reservations = new Set<string>();
  const appended: { event: unknown; caller: unknown }[] = [];
  const asked: { wait: boolean; reserved: string[] }[] = [];
  const sent: { subject: string }[] = [];
  const emailContext = {
    reserveSend: async (key: string) => {
      if (reservations.has(key)) return { reserved: false };
      reservations.add(key);
      return { reserved: true };
    },
    releaseSend: async (key: string) => void reservations.delete(key),
    invoke: async (expression: unknown[], _args: unknown[], caller: unknown) => {
      const [verb, event] = [expression.at(-1)].flat();
      if (verb === "append") {
        if (options.appendFails) throw new Error("the log is unreachable");
        appended.push({ event, caller });
        return [{ ...Object(event), offset: 1 }];
      }
      // a mail this mind sent before, at the offset that is asked for
      if (verb === "readEvents")
        return {
          events: [
            { offset: Number(event) + 1, type: "events.iterate.com/email/sent", payload: stored },
          ],
        };
      return undefined;
    },
  };
  const context = {
    path: "/agents/one",
    caller: () => ({
      principal: null,
      cause: { chain: "/agents/one#1", depth: 1, at: 0, writeKey: "delivery" },
    }),
    context: () => emailContext,
  };
  const egress = {
    sendEmail: async (message: { subject: string }, options?: { wait?: boolean }) => {
      sent.push(message);
      asked.push({
        wait: Boolean(options?.wait),
        reserved: [...reservations].map((key) => key.replace(/:email\.send:.*/, "-1")),
      });
      return outcomes.shift()!;
    },
  };
  const root = emailRoot(
    // A test's stand-in: `emailRoot` reads only `path`, `caller` and `context` of the root, and
    // `reserveSend`, `releaseSend` and `invoke` of a context.
    context as unknown as ItxHostRootContext & { context: () => ReachableContext },
    {
      // no attachment is named, so no file is read
      files: {} as R2Bucket,
      egress: () => egress,
      name: "mind",
      domain: "example.com",
    },
  );
  return {
    asked,
    appended,
    reservations: () => [...reservations],
    sent,
    send: (to = "jo@example.org", subject = "Hello") => root.send({ to, subject, text: "A mail." }),
    answer: (inReplyToOffset: number) => root.send({ inReplyToOffset, text: "An answer." }),
  };
}
