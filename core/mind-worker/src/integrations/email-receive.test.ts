// A received mail as the mind takes it from the boundary (email.ts `receiveEmail`), and the
// boundary's ask for the mind's next request to forward it (`emailForwardRequest`), with an email
// log that says what it was asked.
import type { ReachableContext } from "core-itx";
import { codedError } from "iterate/lib";
import type { ReceivedEmail } from "iterate/workers";
import { expect, test, vi } from "vitest";
import { emailForwardClaim, emailForwardRequest, receiveEmail } from "./email.ts";

const RAW = "/email/key/hello@mind.example.eml";

test("a received mail's files are stored first, then its fact is appended as the platform, and the answer is the fact's offset", async () => {
  const log = emailLog();
  const files = bucket();
  expect(await receiveEmail(files.bucket, log.context, mail())).toEqual({ offset: 1 });
  expect(files).toMatchObject({ put: ["email/key/hello@mind.example.eml"] });
  expect(log).toMatchObject({
    appended: [
      { type: "events.iterate.com/email/received", platform: true, key: "email/received:key" },
    ],
  });
});

test("a redelivery, whose fact differs in what Cloudflare stamps anew, records nothing and answers the first delivery's offset", async () => {
  const log = emailLog({ held: { offset: 12, payload: { subject: "hello", headers: ["first"] } } });
  const again = mail({ subject: "hello", headers: ["second"] });
  expect(await receiveEmail(bucket().bucket, log.context, again)).toEqual({ offset: 12 });
});

test("another message under a Message-ID that the log holds records nothing and gets no offset: the requests to forward the first message are not for it", async () => {
  const log = emailLog({ held: { offset: 12, payload: { subject: "hello", text: "pay Ada" } } });
  const other = mail({ subject: "hello", text: "pay Mallory" });
  expect(await receiveEmail(bucket().bucket, log.context, other)).toBeUndefined();
  expect(log).toMatchObject({ appended: [] });
});

test("the next forward request of a mail is the next one on the log that names its raw file, after the offset asked for", async () => {
  const log = emailLog({ requests: [{ offset: 5, to: "a@elsewhere.example", origin: "/" }] });
  expect(
    await emailForwardRequest(log.context, { raw: RAW, afterOffset: 3, timeoutMs: 50 }),
  ).toEqual({ offset: 5, to: "a@elsewhere.example", origin: "/" });
  expect(log.waits).toMatchObject([{ payload: { raw: RAW }, afterOffset: 3 }]);
});

test("one attempt for each mail and address: a request from the root is claimed before it is answered, and a request whose pair is claimed is passed over", async () => {
  const log = emailLog({
    requests: [
      { offset: 5, to: "A@elsewhere.example", origin: "/" },
      { offset: 6, to: "b@elsewhere.example", origin: "/" },
    ],
    claimed: [`email/forward-attempt:${RAW}:a@elsewhere.example`],
  });
  expect(await emailForwardRequest(log.context, { raw: RAW, timeoutMs: 50 })).toEqual({
    offset: 6,
    to: "b@elsewhere.example",
    origin: "/",
  });
  expect(log).toMatchObject({
    waits: [{ afterOffset: undefined }, { afterOffset: 5 }],
    claimed: [
      `email/forward-attempt:${RAW}:a@elsewhere.example`,
      `email/forward-attempt:${RAW}:b@elsewhere.example`,
    ],
  });
});

test("a request from another context claims nothing: it is answered as it is, and the config's own request for that address is still served", async () => {
  const log = emailLog({
    requests: [
      { offset: 5, to: "a@elsewhere.example", origin: "/agents/x" },
      { offset: 6, to: "a@elsewhere.example", origin: "/" },
    ],
  });
  const wait = { raw: RAW, timeoutMs: 50 };
  expect(await emailForwardRequest(log.context, wait)).toMatchObject({ offset: 5 });
  expect(log).toMatchObject({ claimed: [] });
  expect(await emailForwardRequest(log.context, { ...wait, afterOffset: 5 })).toMatchObject({
    offset: 6,
    origin: "/",
  });
});

test("the claim of the stack's own forward is the claim of a request's: taken once, and given back by the delivery that took it", async () => {
  const log = emailLog();
  const claim = { raw: RAW, to: " A@elsewhere.example", owner: "first" };
  expect(await emailForwardClaim(log.context, claim)).toBe(true);
  expect(await emailForwardClaim(log.context, { ...claim, owner: "second" })).toBe(false);
  expect(log.claimed).toContain(`email/forward-attempt:${RAW}:a@elsewhere.example`);
  // a delivery that did not take the claim cannot give it back
  expect(await emailForwardClaim(log.context, { ...claim, owner: "second", release: true })).toBe(
    true,
  );
  expect(await emailForwardClaim(log.context, { ...claim, owner: "second" })).toBe(false);
  expect(await emailForwardClaim(log.context, { ...claim, release: true })).toBe(true);
  expect(log).toMatchObject({ claimed: [] });
  expect(await emailForwardClaim(log.context, { ...claim, owner: "second" })).toBe(true);
});

test("when the time is up the mind closes the mail's requests with a fact, once for the mail, and answers null", async () => {
  const log = emailLog();
  expect(await emailForwardRequest(log.context, { raw: RAW, timeoutMs: 0 })).toBeNull();
  expect(log).toMatchObject({
    appended: [
      {
        type: "events.iterate.com/email/forward-requests-closed",
        platform: true,
        key: `email/forward-requests-closed:${RAW}`,
      },
    ],
  });
});

test("a request that landed before the closing fact is still handed over, and the answer after it is null", async () => {
  const log = emailLog({
    beforeTheClose: [{ offset: 5, to: "a@elsewhere.example", origin: "/" }],
  });
  const wait = { raw: RAW, afterOffset: 3, timeoutMs: 0 };
  expect(await emailForwardRequest(log.context, wait)).toMatchObject({ offset: 5 });
  expect(await emailForwardRequest(log.context, { ...wait, afterOffset: 5 })).toBeNull();
  expect(log.appended.map((event) => event.type)).toEqual([
    "events.iterate.com/email/forward-requests-closed",
    "events.iterate.com/email/forward-requests-closed",
  ]);
});

test("a mail whose requests are closed already (a redelivery) gets null at the closing fact, and nothing is appended", async () => {
  const log = emailLog({ closedAt: 9 });
  expect(await emailForwardRequest(log.context, { raw: RAW, timeoutMs: 50 })).toBeNull();
  expect(log).toMatchObject({ appended: [] });
});

test("any other failure of the log is thrown", async () => {
  await expect(
    emailForwardRequest(emailLog({ broken: "the log is paused" }).context, {
      raw: RAW,
      timeoutMs: 20,
    }),
  ).rejects.toThrow("the log is paused");
});

function mail(payload: Record<string, unknown> = {}): ReceivedEmail {
  return {
    events: [
      {
        type: "events.iterate.com/email/received",
        idempotencyKey: "email/received:key",
        payload,
      },
    ],
    files: [
      {
        path: RAW,
        contentType: "message/rfc822",
        size: 2,
        data: new Response("hi").body!,
      },
    ],
  };
}

/** A bucket that holds nothing yet and says which keys were put. workerd's stream of a known
 *  length, which Node lacks, passes its bytes on here. */
function bucket() {
  vi.stubGlobal(
    "FixedLengthStream",
    class extends TransformStream {
      constructor(_length: number) {
        super();
      }
    },
  );
  const put: string[] = [];
  return {
    put,
    // the cast: of the bucket, `receiveEmail` calls `head` and `put`
    bucket: {
      head: async () => null,
      put: async (key: string, data: ReadableStream) => {
        await data.cancel();
        put.push(key);
      },
    } as unknown as R2Bucket,
  };
}

/** The mind's email log: its appends, its waits for an event, and the keys that it holds. */
function emailLog(
  has: {
    /** The `email/received` that the log holds under the mail's key already. */
    held?: { offset: number; payload: Record<string, unknown> };
    requests?: { offset: number; to: unknown; origin: string }[];
    /** Requests that are on the log before the closing fact, and that a wait finds only then. */
    beforeTheClose?: { offset: number; to: unknown; origin: string }[];
    /** The mail's requests are closed already, by a fact at this offset. */
    closedAt?: number;
    /** The attempts to forward that are claimed already. */
    claimed?: string[];
    broken?: string;
  } = {},
) {
  const appended: { type: string; platform: boolean; key?: string }[] = [];
  const waits: { type: string[]; payload: unknown; afterOffset?: number }[] = [];
  const requests = [...(has.requests || [])];
  const claimed = [...(has.claimed || [])];
  const found = [...(has.beforeTheClose || [])];
  // the cast: of the context, these functions call `invoke` and the send rows
  const context = {
    sentBefore: async (key: string) => claimed.includes(key),
    releaseSend: async (key: string) => {
      if (claimed.includes(key)) claimed.splice(claimed.indexOf(key), 1);
    },
    reserveSend: async (key: string) => {
      if (claimed.includes(key)) return { reserved: false };
      claimed.push(key);
      return { reserved: true };
    },
    invoke: async (
      expression: [string, string, ...unknown[]],
      _args: unknown[],
      caller: { platform?: true },
    ) => {
      const step = expression.at(-1) as [string, ...unknown[]];
      if (step[0] === "enable") return;
      if (step[0] === "append") {
        const event = step[1] as { type: string; idempotencyKey?: string };
        if (has.held)
          throw codedError("IDEMPOTENCY_CONFLICT", "the key is on the log", {
            existingOffset: has.held.offset,
          });
        appended.push({ type: event.type, platform: !!caller.platform, key: event.idempotencyKey });
        return [{ ...event, offset: appended.length }];
      }
      if (step[0] === "readEvents") return { events: has.held ? [has.held] : [] };
      if (step[0] !== "waitForEvent") throw new Error(`unexpected call: ${step[0]}`);
      const filter = step[1] as { type: string[]; payload: unknown; afterOffset?: number };
      waits.push({ type: filter.type, payload: filter.payload, afterOffset: filter.afterOffset });
      if (has.broken) throw new Error(has.broken);
      if (has.closedAt)
        return {
          type: "events.iterate.com/email/forward-requests-closed",
          offset: has.closedAt,
          payload: { raw: RAW },
          source: { origin: "/integrations/email" },
        };
      const closed = appended.some((event) => event.type.endsWith("/forward-requests-closed"));
      const next = requests.shift() ?? (closed ? found.shift() : undefined);
      if (!next) throw codedError("WAIT_TIMEOUT", "waitForEvent: no event");
      return {
        type: "events.iterate.com/email/forward-requested",
        offset: next.offset,
        payload: { raw: RAW, to: next.to },
        source: { origin: next.origin },
      };
    },
  } as unknown as ReachableContext;
  return { context, appended, waits, claimed };
}
