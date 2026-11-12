import { expect, test, vi } from "vitest";
import { cloudflareEvents } from "./cloudflare-events.ts";
import { mailRows } from "./mail-outcomes.ts";

test("a bounce becomes one fact on the mind's email log, with Cloudflare's cause", async () => {
  const mind = recordingMind();
  await mailOutcome(bounced(), mind);
  expect(mind).toMatchObject({
    appended: [
      {
        path: "/integrations/email",
        events: [
          {
            type: "events.iterate.com/email/delivery-failed",
            idempotencyKey: "email/delivery-failed:event-1",
            payload: {
              messageId: "m1@mind.example",
              to: "user@example.net",
              kind: "bounced",
              permanent: true,
              cause: "permanent_failure",
              detail: "550 5.1.1 User unknown",
            },
          },
        ],
      },
    ],
  });
});

test("a rejection, a failure and a complaint each become a fact of their kind", async () => {
  const mind = recordingMind();
  await mailOutcome(
    event("rejected", {
      rejection: { reason: "suppressed", party: "recipient", detail: "Recipient is suppressed" },
    }),
    mind,
  );
  await mailOutcome(event("failed", { failure: { reason: "delivery_failed" } }), mind);
  await mailOutcome(event("complained", { complaint: { type: "abuse" } }), mind);
  expect(mind.appended.map(({ events }) => events[0])).toMatchObject([
    {
      payload: {
        kind: "rejected",
        permanent: null,
        cause: "suppressed",
        detail: "Recipient is suppressed",
      },
    },
    { payload: { kind: "failed", permanent: null, cause: "delivery_failed", detail: null } },
    { payload: { kind: "complained", permanent: null, cause: "abuse", detail: null } },
  ]);
});

test("a delivered or deferred mail appends nothing", async () => {
  const mind = recordingMind();
  await mailOutcome(event("delivered", { delivery: { status: "delivered" } }), mind);
  await mailOutcome(
    event("deferred", { bounce: { type: "soft", classification: "temporary_failure" } }),
    mind,
  );
  expect(mind).toMatchObject({ appended: [] });
});

test("a redelivered event adds nothing new: both appends carry one idempotency key", async () => {
  const mind = recordingMind();
  await mailOutcome(bounced(), mind);
  await mailOutcome(bounced(), mind);
  const [first, second] = mind.appended.map(({ events }) => events[0]);
  expect(second).toEqual(first);
  // with no event id, the mail, its kind and its recipient make the key
  const noId = bounced();
  delete (noId.payload as { eventId?: string }).eventId;
  await mailOutcome(noId, mind);
  expect(mind.appended[2]!.events[0]).toMatchObject({
    idempotencyKey: "email/delivery-failed:m1@mind.example:bounced:user@example.net",
  });
});

test.for([
  ["nothing", undefined],
  ["a string", "message.bounced"],
  ["another product's event", { type: "cf.r2.bucket.created", payload: { name: "b" } }],
  ["a bounce with no recipient", { ...bounced(), payload: { eventId: "e1" } }],
  ["a bounce with no payload", { type: "cf.email.sending.message.bounced" }],
] as const)(
  "a body the boundary does not understand (%s) appends nothing and does not throw, so it never blocks the queue",
  async ([, body]) => {
    const mind = recordingMind();
    await expect(mailOutcome(body, mind)).resolves.toBeUndefined();
    expect(mind).toMatchObject({ appended: [] });
  },
);

test("a failed append throws, so the queue delivers the event again", async () => {
  const mind = recordingMind("the mind is away");
  await expect(mailOutcome(bounced(), mind)).rejects.toThrow("the mind is away");
});

test("in a batch, each event the mind took is acked and only the one it did not is retried", async () => {
  const did: string[] = [];
  let calls = 0;
  const mind = {
    append: async () => {
      if (++calls === 2) throw new Error("the mind is away");
    },
  };
  const message = (id: string, body: unknown) => ({
    id,
    body,
    attempts: 1,
    ack: () => did.push(`${id} acked`),
    retry: () => did.push(`${id} retried`),
  });
  const batch = {
    queue: "cloudflare-events",
    messages: [
      message("a", bounced()),
      message("b", bounced()),
      message("c", "not an event"),
      message("d", { type: "cf.other.thing" }),
    ],
  } as unknown as MessageBatch;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await cloudflareEvents(batch, mind, mailRows);
  expect(did).toEqual(["a acked", "b retried", "c acked", "d acked"]);
});

/** One message as the queue handler takes it, alone: what its row makes goes to the mind. */
async function mailOutcome(
  body: unknown,
  mind: { append(path: string, events: unknown[]): Promise<void> },
) {
  const made = mailRows[String((body as { type?: unknown } | null)?.type)]?.(body);
  if (made) await mind.append(made.path, [made.event]);
}

/** A mind that records what is appended, or fails each append with the words given. */
function recordingMind(fails?: string) {
  const appended: { path: string; events: unknown[] }[] = [];
  return {
    appended,
    append: async (path: string, events: unknown[]) => {
      if (fails) throw new Error(fails);
      appended.push({ path, events });
    },
  };
}

/** The bounce from Cloudflare's documentation (Email Service, "Event subscriptions"), for a mail
 *  that the mind sent. */
function bounced() {
  return event("bounced", {
    eventId: "event-1",
    delivery: {
      status: "bounced",
      provider: "external_smtp",
      deliveryTimeMs: 2143,
      smtpStatusCode: "550",
      smtpEnhancedStatusCode: "5.1.1",
      smtpResponse: "550 5.1.1 User unknown",
    },
    bounce: {
      type: "hard",
      classification: "permanent_failure",
      reason: "550 5.1.1 User unknown",
    },
  });
}

function event(kind: string, fields: Record<string, unknown>) {
  return {
    type: `cf.email.sending.message.${kind}`,
    source: { type: "email.sending", zoneId: "0".repeat(32), domain: "mind.example" },
    payload: {
      eventId: `event-${kind}`,
      messageId: "<m1@mind.example>",
      sender: "hello@mind.example",
      recipient: "user@example.net",
      subject: "hello",
      terminal: true,
      ...fields,
    } as Record<string, unknown>,
    metadata: {
      accountId: "0".repeat(32),
      eventSubscriptionId: "0".repeat(32),
      eventSchemaVersion: 1,
      eventTimestamp: "2026-06-01T02:48:57.132Z",
    },
  };
}
