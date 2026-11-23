import { expect, test, vi } from "vitest";
import type { EmailHookArgs } from "iterate/email";
import { errorCode } from "iterate/lib";
import { receivedMail } from "./mail.ts";

const GROUP = "team@group.example";

/** The raw file of the one mail `delivered` makes: `/email/<its message key>/<its address>.eml`. */
const RAW = await (async () => {
  const mail = delivered();
  await receivedMail(mail.message, mail.env(), mail.mind);
  return (mail.hooked[0] as { raw: { path: string } }).raw.path;
})();

/** The idempotency key of the `email/received` of the mail `delivered` makes. */
const RECEIVED_KEY = `email/received:${RAW.split("/")[2]}:hello@mind.example`;

/** Cloudflare's record that the sender's domain signed the mail and its server handed it over. */
const PROVEN =
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sender.example; spf=pass smtp.mailfrom=ada@sender.example";

test("a mail's files go to the mind alone, then the mail to the config's hook, and with no forward address nowhere else", async () => {
  const mail = delivered({ hook: async ({ save }) => save() });
  await receivedMail(mail.message, mail.env(), mail.mind);
  expect(mail).toMatchObject({ did: ["the mind kept its files", "the hook ran"], appended: [] });
  // step 1 sends the raw file and no event; the save sends the event and no file
  expect(mail).toMatchObject({
    calls: [
      { events: [], files: [RAW] },
      { events: [RECEIVED_KEY], files: [] },
    ],
  });
  // the saved payload, and whether Cloudflare would forward it: unknown here, so the forward finds out
  expect(mail).toMatchObject({ hooked: [{ ...mail.received[0]!, canBeForwarded: true }] });
});

test("a hook that does not save leaves the mail off the log: its files are kept, no fact is appended, and the delivery stands", async () => {
  const mail = delivered();
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  expect(mail).toMatchObject({
    did: ["the mind kept its files", "the hook ran"],
    calls: [{ events: [], files: [RAW] }],
    received: [],
    appended: [],
  });
});

test("with a forward address the original is forwarded there, after the mind has it", async () => {
  const mail = delivered();
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({
    did: ["the mind kept its files", `forwarded to ${GROUP}`, "the hook ran"],
    appended: [
      {
        path: "/integrations/email",
        events: [
          {
            type: "events.iterate.com/email/forwarded",
            idempotencyKey: `email/forwarded:${RAW}:${GROUP}`,
            payload: { to: GROUP, raw: RAW, messageId: null },
          },
        ],
      },
    ],
  });
});

test("a mail that Cloudflare will not forward because nobody proved its sender is kept, and the delivery stands", async () => {
  const mail = delivered({ forward: "non-authenticated emails cannot be forwarded" });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({
    did: ["the mind kept its files", `forward to ${GROUP} refused`, "the hook ran"],
    appended: [
      {
        path: "/integrations/email",
        events: [
          {
            type: "events.iterate.com/email/forward-failed",
            idempotencyKey: `email/forward-failed:${RAW}:${GROUP}`,
            payload: {
              to: "hello@mind.example",
              forwardTo: GROUP,
              messageId: "<m1@sender.example>",
              error: "Error: non-authenticated emails cannot be forwarded",
            },
          },
        ],
      },
    ],
  });
});

test("any other failure of the forward fails the delivery, so that Cloudflare delivers the mail again", async () => {
  const mail = delivered({ forward: "destination address not verified" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind)).rejects.toThrow(
    "destination address not verified",
  );
  expect(mail).toMatchObject({
    did: ["the mind kept its files", `forward to ${GROUP} refused`],
    appended: [{ events: [{ payload: { error: "Error: destination address not verified" } }] }],
  });
});

test("a mail that was forwarded to this address before is not forwarded again: a forward address that comes back here ends at its second visit", async () => {
  // Email Routing writes `X-Forwarded-To` on what it forwards
  const mail = delivered({ forwardedTo: `Team@Group.Example` });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({
    did: ["the mind kept its files", "the hook ran"],
    // any sender can write the header, so the mind's log says that the mail was not forwarded
    appended: [{ events: [{ payload: { error: expect.stringContaining("forwarded to") } }] }],
  });
  // two header lines, the newest first: this forward address is in the older one
  const twice = delivered({ forwardedTo: ["next@other.example", GROUP] });
  await receivedMail(twice.message, twice.env(GROUP), twice.mind);
  expect(twice).toMatchObject({ did: ["the mind kept its files", "the hook ran"] });
  // a forward that went to another address is forwarded on: one that only ends in the same
  // letters, too
  for (const forwardedTo of ["someone@else.example", `the-${GROUP}`]) {
    const other = delivered({ forwardedTo });
    await receivedMail(other.message, other.env(GROUP), other.mind);
    expect(other).toMatchObject({
      did: ["the mind kept its files", `forwarded to ${GROUP}`, "the hook ran"],
    });
  }
});

test("a fact that the mind does not take changes nothing of the delivery: an unproved sender's mail still stands", async () => {
  const mail = delivered({
    forward: "non-authenticated emails cannot be forwarded",
    append: "the email log is paused",
  });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({
    did: ["the mind kept its files", `forward to ${GROUP} refused`, "the hook ran"],
  });
});

test("a mail that the mind did not take is not forwarded: the next delivery does both", async () => {
  const mail = delivered({ mind: "the mind is away" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind)).rejects.toThrow(
    "the mind is away",
  );
  expect(mail).toMatchObject({ did: [] });
});

test("the hook's forward sends the original and records it once for the mail and address; a second forward there in the same delivery is refused", async () => {
  const outcomes: unknown[] = [];
  const mail = delivered({
    hook: async ({ forward }) => {
      await forward("misha@elsewhere.example");
      outcomes.push(await forward("Misha@Elsewhere.Example").catch(codeOf));
    },
  });
  await receivedMail(mail.message, mail.env(), mail.mind);
  expect(mail).toMatchObject({
    did: ["the mind kept its files", "the hook ran", "forwarded to misha@elsewhere.example"],
    appended: [
      {
        events: [
          {
            type: "events.iterate.com/email/forwarded",
            idempotencyKey: `email/forwarded:${RAW}:misha@elsewhere.example`,
          },
        ],
      },
    ],
  });
  expect(outcomes).toEqual(["FORWARDED_BEFORE"]);
});

test("the hook's save is the one call that sends email/received to the mind, with no files, and two saves make one call", async () => {
  const mail = delivered({
    hook: async ({ save }) => {
      await save();
      await save();
    },
  });
  await receivedMail(mail.message, mail.env(), mail.mind);
  expect(mail).toMatchObject({
    did: ["the mind kept its files", "the hook ran"],
    appended: [],
    saves: [[RECEIVED_KEY]],
    received: [{ raw: { path: RAW } }],
  });
});

test("a save after the hook ended is EXPIRED, calls the mind not at all, and fails nothing", async () => {
  let kept: EmailHookArgs["save"] | undefined;
  const mail = delivered({
    hook: async ({ save }) => {
      kept = save;
    },
  });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  expect(await kept!().catch(codeOf)).toBe("EXPIRED");
  expect(mail).toMatchObject({ saves: [], received: [] });
});

test("a save that the mind refuses rejects in the hook, and fails the delivery after the hook, so Cloudflare delivers the mail again", async () => {
  const outcomes: unknown[] = [];
  const mail = delivered({
    save: "the mind refused it",
    hook: async ({ save, forward }) => {
      outcomes.push(await save().catch((error: unknown) => String(error)));
      await forward("a@elsewhere.example");
    },
  });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).rejects.toThrow(
    "the mind refused it",
  );
  expect(outcomes).toEqual(["Error: the mind refused it"]);
  // the hook ran on, and the forward's fact is on the log before the delivery fails
  expect(mail).toMatchObject({
    did: ["the mind kept its files", "the hook ran", "forwarded to a@elsewhere.example"],
    appended: [{ events: [{ type: "events.iterate.com/email/forwarded" }] }],
    received: [],
  });
});

test("a failed save that the hook does not catch fails the delivery too", async () => {
  const mail = delivered({ save: "the mind refused it", hook: async ({ save }) => save() });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).rejects.toThrow(
    "the mind refused it",
  );
  expect(mail).toMatchObject({ saves: [[RECEIVED_KEY]], received: [] });
});

test("a save still in flight when the hook ends is awaited before the handler returns", async () => {
  const unawaited: Promise<void>[] = [];
  const mail = delivered({
    saveMs: 40,
    hook: async ({ save }) => {
      unawaited.push(save());
    },
  });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  expect(mail).toMatchObject({ received: [{ raw: { path: RAW } }] });
  await Promise.all(unawaited);
});

test("a save that the mind does not answer by its bound is logged and fails the delivery", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const unawaited: Promise<void>[] = [];
  const mail = delivered({
    saveHangs: true,
    hook: async ({ save }) => {
      unawaited.push(save());
    },
  });
  await expect(
    receivedMail(mail.message, mail.env(), mail.mind, {
      hookMs: 50,
      forwardAnswerMs: 50,
      factsMs: 20,
    }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(errors).toHaveBeenCalledWith(
    expect.objectContaining({ event: "mail.save-not-answered", raw: RAW }),
  );
  expect(mail).toMatchObject({ saves: [[RECEIVED_KEY]], received: [] });
  errors.mockRestore();
  expect(unawaited).toHaveLength(1);
});

test("a hook that saves and forwards does both: the mail is on the log, and so is its forward", async () => {
  const mail = delivered({
    hook: async ({ save, forward }) => {
      await save();
      await forward("a@elsewhere.example");
    },
  });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  expect(mail).toMatchObject({
    did: ["the mind kept its files", "the hook ran", "forwarded to a@elsewhere.example"],
    received: [{ raw: { path: RAW } }],
    appended: [
      {
        events: [
          {
            type: "events.iterate.com/email/forwarded",
            idempotencyKey: `email/forwarded:${RAW}:a@elsewhere.example`,
          },
        ],
      },
    ],
  });
});

test("the stack's fixed forward runs first, through the same forward: the hook's forward of the mail to that address is refused, and one to another goes", async () => {
  const outcomes: unknown[] = [];
  const mail = delivered({
    hook: async ({ forward }) => {
      outcomes.push(await forward(GROUP).catch(codeOf));
      await forward("misha@elsewhere.example");
    },
  });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({
    did: [
      "the mind kept its files",
      `forwarded to ${GROUP}`,
      "the hook ran",
      "forwarded to misha@elsewhere.example",
    ],
  });
  expect(outcomes).toEqual(["FORWARDED_BEFORE"]);
});

test.for([
  {
    name: "a mail that Cloudflare says it cannot forward is NOT_FORWARDABLE, and Cloudflare is not asked",
    fails: { canBeForwarded: false },
    expected: { code: "NOT_FORWARDABLE", did: [] },
  },
  {
    name: "Cloudflare's refusal of an unproven sender is NOT_FORWARDABLE",
    fails: { forward: "non-authenticated emails cannot be forwarded" },
    expected: { code: "NOT_FORWARDABLE", did: ["forward to a@elsewhere.example refused"] },
  },
  {
    name: "any other refusal is REFUSED, with Cloudflare's words",
    fails: { forward: "destination address not verified" },
    expected: {
      code: "REFUSED",
      message: "destination address not verified",
      did: ["forward to a@elsewhere.example refused"],
    },
  },
  {
    name: "an address that the mail's X-Forwarded-To names is FORWARDED_BEFORE",
    fails: { forwardedTo: "a@elsewhere.example" },
    expected: { code: "FORWARDED_BEFORE", did: [] },
  },
])("$name; the hook catches it, and the delivery stands", async ({ fails, expected }) => {
  let caught: unknown;
  const mail = delivered({
    ...fails,
    hook: async ({ forward }) => {
      caught = await forward("a@elsewhere.example").catch((error: unknown) => error);
    },
  });
  await receivedMail(mail.message, mail.env(), mail.mind);
  expect({
    code: errorCode(caught),
    ...(expected.message && { message: (caught as Error).message }),
    did: mail.did.slice(2),
  }).toEqual(expected);
  expect(mail).toMatchObject({ appended: [] });
});

test("a hook that runs past the limit is a timeout fact, the delivery stands, and a forward after it is EXPIRED", async () => {
  let late: Promise<unknown> = Promise.resolve();
  const mail = delivered({
    hook: async ({ forward }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      late = forward("a@elsewhere.example").catch(codeOf);
    },
  });
  await receivedMail(mail.message, mail.env(), mail.mind, { hookMs: 5, forwardAnswerMs: 5 });
  expect(mail).toMatchObject({
    appended: [
      {
        path: "/integrations/email",
        events: [
          {
            type: "events.iterate.com/email/hook-failed",
            idempotencyKey: `email/hook-failed:timeout:${RAW}`,
            payload: {
              why: "timeout",
              error: "the hook did not end within 5 ms of its own",
              raw: RAW,
            },
          },
        ],
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(await late).toBe("EXPIRED");
  expect(mail).toMatchObject({ did: ["the mind kept its files", "the hook ran"] });
});

test("the config's clock stops while Cloudflare answers its forward: a forward answered after the config's limit is email/forwarded, and no timeout", async () => {
  // as Cloudflare does: the copy goes at once, the answer comes seconds later
  const mail = delivered({
    forwardAnswerMs: 150,
    hook: async ({ forward }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await forward("a@elsewhere.example");
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  await receivedMail(mail.message, mail.env(), mail.mind, { hookMs: 100, forwardAnswerMs: 400 });
  expect(mail).toMatchObject({
    did: ["the mind kept its files", "the hook ran", "forwarded to a@elsewhere.example"],
    appended: [
      {
        events: [
          {
            type: "events.iterate.com/email/forwarded",
            idempotencyKey: `email/forwarded:${RAW}:a@elsewhere.example`,
            payload: { to: "a@elsewhere.example", raw: RAW },
          },
        ],
      },
    ],
  });
});

test("a forward that the config did not await is still waited for when the hook returns, and recorded", async () => {
  const mail = delivered({
    forwardAnswerMs: 60,
    hook: async ({ forward }) => {
      void forward("a@elsewhere.example").catch(() => {});
    },
  });
  await receivedMail(mail.message, mail.env(), mail.mind, { hookMs: 20, forwardAnswerMs: 400 });
  expect(mail.appended).toMatchObject([
    {
      events: [
        { type: "events.iterate.com/email/forwarded", payload: { to: "a@elsewhere.example" } },
      ],
    },
  ]);
});

test("a forward whose answer does not come by the last deadline is ONE fact: email/forwarded with answered false, and no timeout", async () => {
  const mail = delivered({
    forwardAnswerMs: 2_000,
    hook: async ({ forward }) => {
      await forward("a@elsewhere.example");
    },
  });
  await receivedMail(mail.message, mail.env(), mail.mind, { hookMs: 20, forwardAnswerMs: 60 });
  // one fact, with every field: toMatchObject holds an array to its length
  expect(mail).toMatchObject({
    appended: [
      {
        path: "/integrations/email",
        events: [
          {
            type: "events.iterate.com/email/forwarded",
            idempotencyKey: `email/forwarded:${RAW}:a@elsewhere.example`,
            payload: {
              to: "a@elsewhere.example",
              raw: RAW,
              messageId: null,
              answered: false,
            },
          },
        ],
      },
    ],
  });
});

test("the forward is dead the instant the deadline wins: a forward after it, while the hook-failed append never answers, is EXPIRED and reaches no Cloudflare", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  let late: Promise<unknown> | undefined;
  const mail = delivered({
    appendHangs: true,
    hook: async ({ forward }) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      late = forward("a@elsewhere.example").catch(codeOf);
    },
  });
  const delivery = receivedMail(mail.message, mail.env(), mail.mind, {
    hookMs: 5,
    forwardAnswerMs: 5,
    factsMs: 100,
  });
  await vi.waitFor(() => expect(late).toBeDefined(), { interval: 5 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(mail).toMatchObject({ did: ["the mind kept its files", "the hook ran"] });
  expect(await late).toBe("EXPIRED");
  // the append that never answers holds the handler for its bound, and is a log line
  await expect(delivery).resolves.toBeUndefined();
  expect(logged.mock.calls.map(([line]) => line)).toContainEqual(
    expect.objectContaining({
      event: "mail.hook-failed-not-recorded",
      appendError: "the mind did not answer within 100 ms",
    }),
  );
  logged.mockRestore();
});

test.for([
  ["the last deadline", { hookMs: 1_000, forwardAnswerMs: 1_000 }],
  ["the config's own time", { hookMs: 1_000, forwardAnswerMs: 100_000 }],
] as const)(
  "a forward after %s has passed BY THE CLOCK, before its timer has run, is EXPIRED and reaches no Cloudflare",
  async ([, limits]) => {
    let late: Promise<unknown> | undefined;
    const mail = delivered({
      hook: async ({ forward }) => {
        // the clock passes the limit at once; no timer of the boundary's has run
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
        late = forward("a@elsewhere.example").catch(codeOf);
        clock.mockRestore();
      },
    });
    await receivedMail(mail.message, mail.env(), mail.mind, limits);
    expect(await late).toBe("EXPIRED");
    expect(mail).toMatchObject({ did: ["the mind kept its files", "the hook ran"] });
  },
);

test("a forward's fact is on the mind's log before the handler returns, also when Cloudflare answers after the hook returned and the append is slow", async () => {
  const mail = delivered({
    forwardAnswerMs: 30,
    appendMs: 50,
    hook: async ({ forward }) => {
      void forward("a@elsewhere.example").catch(() => {});
    },
  });
  await receivedMail(mail.message, mail.env(), mail.mind, {
    hookMs: 20,
    forwardAnswerMs: 400,
    factsMs: 1_000,
  });
  expect(mail.appended).toMatchObject([
    {
      events: [
        { type: "events.iterate.com/email/forwarded", payload: { to: "a@elsewhere.example" } },
      ],
    },
  ]);
});

test("a mind that cannot be reached for the hook is an unreachable fact, the boundary records the mail, and the delivery stands", async () => {
  const infos = vi.spyOn(console, "info").mockImplementation(() => {});
  const mail = delivered({ hook: "This mind runs elsewhere and is not connected right now." });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  expect(infos).toHaveBeenCalledWith(
    expect.objectContaining({ event: "mail.saved-by-the-boundary", raw: RAW, why: "unreachable" }),
  );
  infos.mockRestore();
  expect(mail).toMatchObject({
    saves: [[RECEIVED_KEY]],
    received: [{ raw: { path: RAW } }],
    appended: [
      {
        path: "/integrations/email",
        events: [
          {
            type: "events.iterate.com/email/hook-failed",
            idempotencyKey: `email/hook-failed:unreachable:${RAW}`,
            payload: {
              why: "unreachable",
              error: "Error: This mind runs elsewhere and is not connected right now.",
              raw: RAW,
            },
          },
        ],
      },
    ],
  });
});

test("a hook fact that the mind does not take is logged, and the delivery stands", async () => {
  const infos = vi.spyOn(console, "info").mockImplementation(() => {});
  const mail = delivered({ hook: "the mind is away", append: "the email log is paused" });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  infos.mockRestore();
});

test("a mind that the link loses after the hook's save was taken: one record, the delivery stands, and the fact says unreachable", async () => {
  const mail = delivered({ hook: async ({ save }) => save(), lostAfterHook: "the link broke" });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  expect(mail).toMatchObject({
    saves: [[RECEIVED_KEY]],
    received: [{ raw: { path: RAW } }],
    appended: [{ events: [{ payload: { why: "unreachable", raw: RAW } }] }],
  });
});

/** Each end of a hook in which nobody chose to leave the mail off the log, with the `why` of the
 *  boundary's record. */
const NOBODY_CHOSE = [
  {
    name: "the hook threw",
    why: "threw",
    fails: {
      hook: async () => {
        throw new Error("the config broke");
      },
    },
  },
  { name: "the config has no email", why: "missing", fails: { answer: "missing" as const } },
  { name: "the mind is of an older build", why: "no answer", fails: { answer: "none" as const } },
  { name: "the mind cannot be reached", why: "unreachable", fails: { hook: "the mind is away" } },
  {
    name: "the mind's call never answers within the limits",
    why: "unanswered",
    fails: { hook: () => new Promise<void>(() => {}) },
  },
];
const SHORT = { hookMs: 10, forwardAnswerMs: 10, factsMs: 50 };

test.for(NOBODY_CHOSE)(
  "$name: the boundary records the mail once, and the delivery stands",
  async ({ why, fails }) => {
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});
    const mail = delivered(fails);
    await expect(receivedMail(mail.message, mail.env(), mail.mind, SHORT)).resolves.toBeUndefined();
    expect(mail).toMatchObject({ saves: [[RECEIVED_KEY]], received: [{ raw: { path: RAW } }] });
    expect(infos).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mail.saved-by-the-boundary", raw: RAW, why }),
    );
    infos.mockRestore();
  },
);

test.for(NOBODY_CHOSE)(
  "$name: a record that the mind refuses fails the delivery",
  async ({ fails }) => {
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});
    const mail = delivered({ ...fails, save: "the mind refused it" });
    await expect(receivedMail(mail.message, mail.env(), mail.mind, SHORT)).rejects.toThrow(
      "the mind refused it",
    );
    infos.mockRestore();
  },
);

test("a hook that returned without saving chose: nothing is recorded, and the delivery stands", async () => {
  const infos = vi.spyOn(console, "info");
  const mail = delivered();
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  expect(mail).toMatchObject({ saves: [], received: [] });
  expect(infos).not.toHaveBeenCalledWith(
    expect.objectContaining({ event: "mail.saved-by-the-boundary" }),
  );
  infos.mockRestore();
});

test("a hook that saved and then threw makes one record, the hook's", async () => {
  const infos = vi.spyOn(console, "info");
  const mail = delivered({
    hook: async ({ save }) => {
      await save();
      throw new Error("the config broke after it saved");
    },
  });
  await expect(receivedMail(mail.message, mail.env(), mail.mind)).resolves.toBeUndefined();
  expect(mail).toMatchObject({ saves: [[RECEIVED_KEY]], received: [{ raw: { path: RAW } }] });
  expect(infos).not.toHaveBeenCalledWith(
    expect.objectContaining({ event: "mail.saved-by-the-boundary" }),
  );
  infos.mockRestore();
});

test("a stack with a fixed forward records the mail in step 1, with its files; a hook that does not save changes nothing, and one that saves calls the mind no more", async () => {
  for (const hook of [undefined, async ({ save }: EmailHookArgs) => save()]) {
    const mail = delivered({ hook });
    await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind)).resolves.toBeUndefined();
    expect(mail).toMatchObject({
      calls: [{ events: [RECEIVED_KEY], files: [RAW] }],
      received: [{ raw: { path: RAW } }],
      saves: [],
    });
  }
});

test("a stack whose fixed forward is refused has the mail recorded all the same, though the delivery fails", async () => {
  const mail = delivered({ forward: "destination address not verified" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind)).rejects.toMatchObject({
    code: "REFUSED",
  });
  expect(mail).toMatchObject({ received: [{ raw: { path: RAW } }], saves: [] });
});

test("a fixed forward that fails the delivery runs no hook: the next delivery does", async () => {
  const mail = delivered({ forward: "destination address not verified" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind)).rejects.toMatchObject({
    code: "REFUSED",
  });
  expect(mail).toMatchObject({ did: ["the mind kept its files", `forward to ${GROUP} refused`] });
});

/** An envelope sender whose quoted local part holds a `)`, `;` and words that read as results. */
const QUOTED_ENVELOPE =
  '"x);dkim=pass header.d=sender.example;spf=pass smtp.mailfrom=ada@sender.example;y"@outside.example';

test.for([
  {
    name: "a proven mail with a hop count is another mind's mail, and is still automated",
    headers: [PROVEN, "Auto-Submitted: auto-generated", "X-Iterate-Mail-Hops: 3"],
    expected: { mind: { hops: 3 }, automated: true, sender: { verified: true } },
  },
  {
    name: "an unproven mail's hop count is not read: anyone can write the header",
    headers: ["Auto-Submitted: auto-generated", "X-Iterate-Mail-Hops: 3"],
    expected: { mind: null, automated: true, sender: { verified: false } },
  },
  {
    name: "a hop count of zero is no hop count",
    headers: [PROVEN, "Auto-Submitted: auto-generated", "X-Iterate-Mail-Hops: 0"],
    expected: { mind: null, automated: true },
  },
  {
    name: "a hop count that is not a whole number is no hop count",
    headers: [PROVEN, "Auto-Submitted: auto-generated", "X-Iterate-Mail-Hops: three"],
    expected: { mind: null, automated: true },
  },
  {
    name: "a proven person's mail is no mind's mail, and not automated",
    headers: [PROVEN],
    expected: { mind: null, automated: false, sender: { verified: true } },
  },
  {
    name: "a mail from the sender's own mail server, signed, as Cloudflare records it (a Gmail or Workspace sender) is verified and direct",
    headers: [
      cloudflareRecord(
        "dkim=pass header.d=sender.example header.s=s1 header.b=AbCd+eFg",
        "dmarc=pass header.from=sender.example policy.dmarc=reject",
        "spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail.sender.example) smtp.helo=mail.sender.example",
        "spf=pass (mx.cloudflare.net: domain of ada@sender.example designates 2001:db8::1 as permitted sender) smtp.mailfrom=ada@sender.example",
        'arc=none smtp.remote-ip="2001:db8::1"',
      ),
    ],
    expected: { sender: { verified: true, direct: true }, authentication: { dmarc: "pass" } },
  },
  {
    name: "a mail that a mailing service sent for the sender, with its own signature and envelope too, is verified and not direct",
    envelopeFrom: "bounces+1@em.service.example",
    headers: [
      cloudflareRecord(
        "dkim=pass header.d=sender.example header.s=s1",
        "dkim=pass header.d=service.example header.s=s2",
        "dmarc=pass header.from=sender.example policy.dmarc=reject",
        "spf=none smtp.helo=o1.service.example",
        "spf=pass smtp.mailfrom=bounces+1@em.service.example",
      ),
    ],
    expected: { sender: { verified: true, direct: false } },
  },
  {
    name: "a quoted envelope local part is one value: the semicolons and results in it are no results of the record",
    envelopeFrom: QUOTED_ENVELOPE,
    headers: [
      cloudflareRecord(
        "dmarc=none header.from=sender.example policy.dmarc=none",
        "spf=none smtp.helo=mail.outside.example",
        `spf=pass (mx.cloudflare.net: domain of ${QUOTED_ENVELOPE} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${QUOTED_ENVELOPE}`,
      ),
    ],
    expected: { sender: { verified: false, direct: false } },
  },
  {
    name: "an aligned SPF pass does not verify a mail that DMARC fails: only a DKIM or DMARC pass proves the From",
    envelopeFrom: "ada@mail.sender.example",
    headers: [
      cloudflareRecord(
        "dmarc=fail header.from=sender.example policy.dmarc=reject",
        "spf=none smtp.helo=mail.sender.example",
        "spf=pass smtp.mailfrom=ada@mail.sender.example",
      ),
    ],
    expected: { sender: { verified: false } },
  },
])("$name", async ({ headers, envelopeFrom, expected }) => {
  const mail = delivered({ headers, envelopeFrom });
  await receivedMail(mail.message, mail.env(), mail.mind);
  expect(mail).toMatchObject({ hooked: [expected] });
});

/** Cloudflare's Authentication-Results field with these results, one folded line each. */
function cloudflareRecord(...results: string[]) {
  return `Authentication-Results: mx.cloudflare.net;${results.map((result) => `\r\n\t${result}`).join(";")}`;
}

/** One mail as Cloudflare hands it to the Worker, with a mind and a forward that say what they did,
 *  or fail with the words given. */
function delivered(
  fails: {
    forward?: string;
    mind?: string;
    /** One address, or one for each `X-Forwarded-To` line, the newest first. */
    forwardedTo?: string | string[];
    append?: string;
    /** The mind takes no fact and never answers an append. */
    appendHangs?: boolean;
    /** How long the mind takes to answer an append. */
    appendMs?: number;
    /** Header lines above the mail's own. */
    headers?: string[];
    /** The envelope sender, if not the From address. */
    envelopeFrom?: string;
    /** How long Cloudflare takes to answer a forward that it makes. */
    forwardAnswerMs?: number;
    /** Cloudflare's `canBeForwarded`; absent as in a local runtime. */
    canBeForwarded?: boolean;
    /** What the config's `email` hook does, in the mind; a string: the mind cannot be reached for
     *  it, with those words. */
    hook?: ((args: EmailHookArgs) => Promise<void>) | string;
    /** The mind refuses the hook's save, with these words. */
    save?: string;
    /** How long the mind takes to answer the hook's save. */
    saveMs?: number;
    /** The mind never answers the hook's save. */
    saveHangs?: boolean;
    /** What the mind's `email` answers when the hook did not throw: "returned" when absent;
     *  "missing" for a config with no `email`; "none" for a mind of an older build, which answers
     *  nothing. */
    answer?: "returned" | "missing" | "none";
    /** The link to the mind breaks after the hook ran: its `email` rejects with these words. */
    lostAfterHook?: string;
  } = {},
) {
  const did: string[] = [];
  const saves: unknown[] = [];
  const calls: { events: unknown[]; files: string[] }[] = [];
  const received: unknown[] = [];
  const appended: { path: string; events: unknown[] }[] = [];
  const hooked: unknown[] = [];
  const headers = new Headers({ "message-id": "<m1@sender.example>" });
  for (const address of [fails.forwardedTo || []].flat()) headers.append("x-forwarded-to", address);
  const raw = new TextEncoder().encode(
    [
      ...(fails.headers || []),
      "From: Ada <ada@sender.example>",
      "To: hello@mind.example",
      "Subject: hello",
      "",
      "hi",
      "",
    ].join("\r\n"),
  );
  return {
    did,
    appended,
    /** The payload of each `email/received` the mind took: only a save sends one. */
    received,
    /** The mail that the config's hook was handed. */
    hooked,
    /** The idempotency keys of each call of the mind that the hook's save made. */
    saves,
    /** Each call of `receiveEmail`: its events' keys and its files' paths. */
    calls,
    // The cast: of Cloudflare's message, the handler reads the envelope, the headers and the bytes and
    // calls `forward`.
    message: {
      canBeForwarded: fails.canBeForwarded,
      from: fails.envelopeFrom || "ada@sender.example",
      to: "hello@mind.example",
      raw: new Response(raw).body,
      headers,
      forward: async (to: string) => {
        if (fails.forward) {
          did.push(`forward to ${to} refused`);
          throw new Error(fails.forward);
        }
        did.push(`forwarded to ${to}`);
        if (fails.forwardAnswerMs)
          await new Promise((resolve) => setTimeout(resolve, fails.forwardAnswerMs));
      },
    } as unknown as ForwardableEmailMessage,
    env: (forwardTo?: string) => ({
      AUTH: { isMember: async () => false },
      MAIL_FORWARD_TO: forwardTo,
    }),
    mind: {
      receiveEmail: async (mail: {
        events: { idempotencyKey?: string; payload?: unknown }[];
        files: { path: string }[];
      }) => {
        calls.push({
          events: mail.events.map((event) => event.idempotencyKey),
          files: mail.files.map((file) => file.path),
        });
        // a call with no files is the record: the hook's save or the boundary's own
        if (mail.files.length === 0) {
          saves.push(mail.events.map((event) => event.idempotencyKey));
          if (fails.saveHangs) return new Promise<void>(() => {});
          if (fails.saveMs) await new Promise((resolve) => setTimeout(resolve, fails.saveMs));
          if (fails.save) throw new Error(fails.save);
          received.push(...mail.events.map((event) => event.payload));
          return;
        }
        if (fails.mind) throw new Error(fails.mind);
        did.push("the mind kept its files");
        // a stack with a fixed forward records the mail with its files
        received.push(...mail.events.map((event) => event.payload));
      },
      append: async (path: string, events: unknown[]) => {
        if (fails.appendHangs) return new Promise<void>(() => {});
        if (fails.appendMs) await new Promise((resolve) => setTimeout(resolve, fails.appendMs));
        if (fails.append) throw new Error(fails.append);
        appended.push({ path, events });
      },
      // As the mind runs the hook: a throw of the config's is the answer "threw", not this call's
      // failure; a string hook is a mind that cannot be reached.
      email: async (args: EmailHookArgs): Promise<"returned" | "threw" | "missing" | undefined> => {
        if (typeof fails.hook === "string") throw new Error(fails.hook);
        did.push("the hook ran");
        hooked.push(args.mail);
        const threw = await (fails.hook?.(args) ?? Promise.resolve()).then(
          () => false,
          () => true,
        );
        if (fails.lostAfterHook) throw new Error(fails.lostAfterHook);
        if (threw) return "threw";
        if (fails.answer === "none") return undefined;
        return fails.answer || "returned";
      },
    },
  };
}

function codeOf(error: unknown) {
  return errorCode(error);
}
