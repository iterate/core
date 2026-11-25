import { expect, test, vi } from "vitest";
import { receivedMail } from "./mail.ts";

const GROUP = "team@group.example";
const OTHER = "other@elsewhere.example";

/** Short limits: the wait for the mind's requests, for Cloudflare's answers, and for the facts. */
const LIMITS = { requestMs: 60, forwardAnswerMs: 100, factsMs: 100 };

/** The raw file of the one mail `delivered` makes: `/email/<its message key>/<its address>.eml`. */
const RAW = await (async () => {
  const mail = delivered();
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  return mail.asks[0]!.raw;
})();

/** The idempotency key of the `email/received` of the mail `delivered` makes. */
const RECEIVED_KEY = `email/received:${RAW.split("/")[2]}:hello@mind.example`;

/** Cloudflare's record that the sender's domain signed the mail and its server handed it over. */
const PROVEN =
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sender.example; spf=pass smtp.mailfrom=ada@sender.example";

test("every mail goes on the mind's log with its files, in one call, before anything else, and with no forward address nowhere else", async () => {
  const mail = delivered();
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail"],
    calls: [{ events: [RECEIVED_KEY], files: [RAW] }],
    received: [{ subject: "hello", raw: { path: RAW } }],
    appended: [],
  });
  // then the mind is asked for its requests to forward this mail, after the mail's own event
  expect(mail.asks[0]).toMatchObject({ raw: RAW, afterOffset: 7 });
});

test("with a forward address the original is forwarded there, after the mind has it", async () => {
  const mail = delivered();
  await receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail", `forwarded to ${GROUP}`],
    appended: [{ path: "/integrations/email", events: [forwarded(GROUP)] }],
  });
});

test("a mail that Cloudflare will not forward because nobody proved its sender is kept, and the delivery stands", async () => {
  const mail = delivered({ forward: "non-authenticated emails cannot be forwarded" });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail", `forward to ${GROUP} refused`],
    appended: [
      {
        path: "/integrations/email",
        events: [forwardFailed(GROUP, "Error: non-authenticated emails cannot be forwarded")],
      },
    ],
  });
});

test("any other failure of the stack's forward fails the delivery, so that Cloudflare delivers the mail again; the mail is on the log all the same", async () => {
  const mail = delivered({ forward: "destination address not verified" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS)).rejects.toThrow(
    "destination address not verified",
  );
  expect(mail).toMatchObject({
    did: ["the mind kept the mail", `forward to ${GROUP} refused`],
    received: [{ subject: "hello" }],
    appended: [{ events: [forwardFailed(GROUP, "Error: destination address not verified")] }],
  });
});

test("the stack's forward goes once for a mail over its deliveries: after a delivery that forwarded and then failed because the mind could not be asked, the next delivery forwards nothing more", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const first = delivered({ requests: "the mind is away" });
  await expect(receivedMail(first.message, first.env(GROUP), first.mind, LIMITS)).rejects.toThrow(
    "the mind is away",
  );
  expect(first).toMatchObject({ did: ["the mind kept the mail", `forwarded to ${GROUP}`] });
  const again = delivered({ claims: [...first.claims] });
  await receivedMail(again.message, again.env(GROUP), again.mind, LIMITS);
  expect(again).toMatchObject({ did: ["the mind kept the mail"], appended: [] });
  logged.mockRestore();
});

test("a stack's forward that Cloudflare refused gives its claim back, so the next delivery tries again; and a mind of an older build, which has no claim, is forwarded for all the same", async () => {
  const refused = delivered({ forward: "destination address not verified" });
  await expect(
    receivedMail(refused.message, refused.env(GROUP), refused.mind, LIMITS),
  ).rejects.toThrow("destination address not verified");
  expect([...refused.claims]).toEqual([]);
  const older = delivered({ claims: "none", offset: null });
  await receivedMail(older.message, older.env(GROUP), older.mind, LIMITS);
  expect(older).toMatchObject({ did: ["the mind kept the mail", `forwarded to ${GROUP}`] });
});

test("a claim that cannot be asked for is no claim: the stack's forward does not call Cloudflare, and the delivery fails so that the next one asks again", async () => {
  const mail = delivered({ claims: "none" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS)).rejects.toThrow(
    "the mind has no emailForwardClaim",
  );
  expect(mail).toMatchObject({ did: ["the mind kept the mail"], appended: [] });
});

test("a claim that is not answered in its time is no forward in flight: Cloudflare is not called, the delivery fails, and the claim that lands late is given back", async () => {
  const mail = delivered({ claims: "hangs" });
  await expect(
    receivedMail(mail.message, mail.env(GROUP), mail.mind, { ...LIMITS, factsMs: 30 }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(mail).toMatchObject({ did: ["the mind kept the mail"], appended: [] });
  // given back at once, and again when the late answer says that it was taken
  await vi.waitFor(() => expect(mail).toMatchObject({ released: [GROUP, GROUP] }));
  // one after the other: the second release never runs beside the first
  expect(mail.overlapped()).toBe(false);
});

test("a claim whose answer is lost may have landed: Cloudflare was not called, so it is given back, and the delivery fails", async () => {
  const mail = delivered({ claims: "answer lost" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS)).rejects.toThrow(
    "Network connection lost.",
  );
  expect(mail).toMatchObject({ did: ["the mind kept the mail"], released: [GROUP] });
});

test("a delivery whose claim call fails gives back nothing that it did not take: the claim of the delivery that forwarded stays, and no second copy goes", async () => {
  const first = delivered();
  await receivedMail(first.message, first.env(GROUP), first.mind, LIMITS);
  expect([...first.claims]).toEqual([GROUP]);
  // the second delivery shares the mind's claims, and its own claim call is lost
  const second = delivered({ claimCallFails: true });
  second.claims.add(GROUP);
  await expect(
    receivedMail(second.message, second.env(GROUP), second.mind, LIMITS),
  ).rejects.toThrow("Network connection lost.");
  expect(second).toMatchObject({ did: ["the mind kept the mail"] });
  expect([...second.claims]).toEqual([GROUP]);
});

test("the stack's forward does not cost the mind's requests their time: while Cloudflare answers it for longer than the wait, a request for another address is served", async () => {
  const mail = delivered({ requests: [{ to: OTHER, afterMs: 20 }], forwardAnswerMs: 90 });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail", `forwarded to ${GROUP}`, `forwarded to ${OTHER}`],
  });
  expect(mail.appended.flatMap((append) => append.events)).toEqual(
    expect.arrayContaining([forwarded(GROUP), forwarded(OTHER)]),
  );
});

test("a mail that was forwarded to this address before is not forwarded again: a forward address that comes back here ends at its second visit", async () => {
  // Email Routing writes `X-Forwarded-To` on what it forwards
  const mail = delivered({ forwardedTo: `Team@Group.Example` });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail"],
    // any sender can write the header, so the mind's log says that the mail was not forwarded
    appended: [{ events: [{ payload: { error: expect.stringContaining("forwarded to") } }] }],
  });
  // two header lines, the newest first: this forward address is in the older one
  const twice = delivered({ forwardedTo: ["next@other.example", GROUP] });
  await receivedMail(twice.message, twice.env(GROUP), twice.mind, LIMITS);
  expect(twice).toMatchObject({ did: ["the mind kept the mail"] });
  // a forward that went to another address is forwarded on: one that only ends in the same
  // letters, too
  for (const forwardedTo of ["someone@else.example", `the-${GROUP}`]) {
    const other = delivered({ forwardedTo });
    await receivedMail(other.message, other.env(GROUP), other.mind, LIMITS);
    expect(other).toMatchObject({ did: ["the mind kept the mail", `forwarded to ${GROUP}`] });
  }
});

test("a fact that the mind does not take is logged and changes nothing of the delivery: an unproved sender's mail still stands", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const mail = delivered({
    forward: "non-authenticated emails cannot be forwarded",
    append: "the email log is paused",
  });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS);
  expect(mail).toMatchObject({ did: ["the mind kept the mail", `forward to ${GROUP} refused`] });
  expect(logged).toHaveBeenCalledWith(
    expect.objectContaining({ event: "mail.forward-failed-not-recorded", forwardTo: GROUP }),
  );
  logged.mockRestore();
});

test("a mail that the mind did not take is not forwarded: the next delivery does both", async () => {
  const mail = delivered({ mind: "the mind is away", requests: [{ to: OTHER }] });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS)).rejects.toThrow(
    "the mind is away",
  );
  expect(mail).toMatchObject({ did: [], asks: [] });
});

test("the mind's request to forward the mail sends the original on and is answered by email/forwarded", async () => {
  const mail = delivered({ requests: [{ to: OTHER }] });
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail", `forwarded to ${OTHER}`],
    appended: [{ path: "/integrations/email", events: [forwarded(OTHER)] }],
  });
  // the second ask is for the requests after the first one
  expect(mail.asks.map((ask) => ask.afterOffset)).toEqual([7, 8]);
});

test("a second request is taken while Cloudflare answers the first forward, and both are recorded", async () => {
  const mail = delivered({ requests: [{ to: OTHER }, { to: GROUP }], forwardAnswerMs: 80 });
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail", `forwarded to ${OTHER}`, `forwarded to ${GROUP}`],
  });
  expect(mail.appended.flatMap((append) => append.events)).toEqual(
    expect.arrayContaining([forwarded(OTHER), forwarded(GROUP)]),
  );
});

test("a request that an agent wrote is not served: only one written at the root counts, and the log says why", async () => {
  const mail = delivered({ requests: [{ to: OTHER, origin: "/agents/email/t5" }] });
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail"],
    appended: [
      {
        events: [
          {
            ...forwardFailed(
              OTHER,
              "not forwarded: only the mind's config, at /, asks for a forward, and /agents/email/t5 asked",
            ),
            // a key of the request's own: the config's request for this address keeps its answer
            idempotencyKey: `email/forward-failed:${RAW}:${OTHER}:request-8`,
          },
        ],
      },
    ],
  });
});

test("a request for an address that the mail went to in this delivery forwards nothing more: the stack's own forward, or an earlier request", async () => {
  const mail = delivered({
    requests: [{ to: GROUP }, { to: OTHER }, { to: ` ${OTHER.toUpperCase()}` }],
  });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail", `forwarded to ${GROUP}`, `forwarded to ${OTHER}`],
  });
  expect(mail.appended.flatMap((append) => append.events)).toHaveLength(2);
});

test("a requested forward that Cloudflare refuses is email/forward-failed with its words, and the delivery stands", async () => {
  const mail = delivered({
    requests: [{ to: OTHER }],
    forward: "destination address not verified",
  });
  await expect(receivedMail(mail.message, mail.env(), mail.mind, LIMITS)).resolves.toBeUndefined();
  expect(mail).toMatchObject({
    did: ["the mind kept the mail", `forward to ${OTHER} refused`],
    appended: [{ events: [forwardFailed(OTHER, "Error: destination address not verified")] }],
  });
});

test("a mail that Cloudflare says it cannot forward is not handed to Cloudflare: the request is answered at once", async () => {
  const mail = delivered({ requests: [{ to: OTHER }], canBeForwarded: false });
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(mail).toMatchObject({
    did: ["the mind kept the mail"],
    appended: [
      {
        events: [
          forwardFailed(
            OTHER,
            "not forwarded: Cloudflare forwards no mail whose sender it did not prove",
          ),
        ],
      },
    ],
  });
});

test("a forward whose answer does not come by the last deadline is email/forwarded with answered false, and the handler returns", async () => {
  const mail = delivered({ requests: [{ to: OTHER }], forwardAnswerMs: 5_000 });
  const started = Date.now();
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(mail).toMatchObject({ appended: [{ events: [forwarded(OTHER, { answered: false })] }] });
});

test("a request that comes after the wait is not served: the handler has returned", async () => {
  const mail = delivered({ requests: [{ to: OTHER, afterMs: 500 }] });
  const started = Date.now();
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(Date.now() - started).toBeLessThan(400);
  expect(mail).toMatchObject({ did: ["the mind kept the mail"], appended: [] });
});

test("a request that names no address is passed over, and the next one is served", async () => {
  const mail = delivered({ requests: [{ to: 5 }, { to: " " }, { to: OTHER }] });
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(mail).toMatchObject({ did: ["the mind kept the mail", `forwarded to ${OTHER}`] });
});

test("a mind of an older build, which answers no offset and cannot be asked for requests, is logged, and its delivery stands", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const mail = delivered({ requests: "the mind has no emailForwardRequest", offset: null });
  await expect(receivedMail(mail.message, mail.env(), mail.mind, LIMITS)).resolves.toBeUndefined();
  expect(mail).toMatchObject({ did: ["the mind kept the mail"], appended: [] });
  expect(mail.asks.at(-1)).toEqual({ raw: RAW, afterOffset: undefined });
  expect(logged).toHaveBeenCalledWith(
    expect.objectContaining({ event: "mail.forward-requests-not-read", raw: RAW }),
  );
  logged.mockRestore();
});

test("a mind that could not be asked for its requests to the end closed nothing: it is asked again while the time lasts, and then the delivery fails, so the next delivery serves them", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const mail = delivered({ requests: "the mind is away" });
  await expect(receivedMail(mail.message, mail.env(), mail.mind, LIMITS)).rejects.toThrow(
    "the mind is away",
  );
  // once at the start, and once more when the time was up
  expect(mail.asks.length).toBeGreaterThan(1);
  logged.mockRestore();
});

test("an ask that fails once is made again, and the request is served", async () => {
  const mail = delivered({ requests: [{ to: OTHER }], asksFail: 1 });
  await receivedMail(mail.message, mail.env(), mail.mind, { ...LIMITS, requestMs: 700 });
  expect(mail).toMatchObject({ did: ["the mind kept the mail", `forwarded to ${OTHER}`] });
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
  await receivedMail(mail.message, mail.env(), mail.mind, LIMITS);
  expect(mail).toMatchObject({ received: [expected] });
});

/** Cloudflare's Authentication-Results field with these results, one folded line each. */
function cloudflareRecord(...results: string[]) {
  return `Authentication-Results: mx.cloudflare.net;${results.map((result) => `\r\n\t${result}`).join(";")}`;
}

function forwarded(to: string, more?: object) {
  return {
    type: "events.iterate.com/email/forwarded",
    idempotencyKey: `email/forwarded:${RAW}:${to}`,
    payload: { to, raw: RAW, messageId: "m1@sender.example", received: 7, ...more },
  };
}

function forwardFailed(forwardTo: string, error: unknown) {
  return {
    type: "events.iterate.com/email/forward-failed",
    idempotencyKey: `email/forward-failed:${RAW}:${forwardTo}`,
    payload: {
      to: "hello@mind.example",
      forwardTo,
      messageId: "<m1@sender.example>",
      raw: RAW,
      received: 7,
      error,
    },
  };
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
    /** Header lines above the mail's own. */
    headers?: string[];
    /** The envelope sender, if not the From address. */
    envelopeFrom?: string;
    /** How long Cloudflare takes to answer a forward that it makes. */
    forwardAnswerMs?: number;
    /** Cloudflare's `canBeForwarded`; absent as in a local runtime. */
    canBeForwarded?: boolean;
    /** The mind's requests to forward this mail, in their order: `origin` is "/" when absent, and
     *  `afterMs` how long after the ask the request comes. A string: the mind cannot be asked,
     *  with those words. */
    requests?: { to: unknown; origin?: string; afterMs?: number }[] | string;
    /** The claims that an earlier delivery left; "none": a mind of an older build, which has no
     *  such call; "hangs": the claim is answered, as taken, only after 200 ms; "answer lost": the claim
     *  lands and its answer does not come. */
    claims?: string[] | "none" | "hangs" | "answer lost";
    /** The claim call itself fails; a release still reaches the mind. */
    claimCallFails?: boolean;
    /** How many asks for the next request fail before one is answered. */
    asksFail?: number;
    /** The offset that the mind answers for the mail's `email/received`: 7 when absent; null
     *  for a mind of an older build, which answers nothing. */
    offset?: number | null;
  } = {},
) {
  const did: string[] = [];
  const calls: { events: unknown[]; files: string[] }[] = [];
  const received: unknown[] = [];
  const appended: { path: string; events: unknown[] }[] = [];
  const asks: { raw: string; afterOffset: number | undefined }[] = [];
  const requests = typeof fails.requests === "string" ? [] : [...(fails.requests || [])];
  let offset = fails.offset || 7;
  let asksFailing = fails.asksFail || 0;
  const claims = new Set(Array.isArray(fails.claims) ? fails.claims : []);
  const owners = new Map<string, string>();
  const released: string[] = [];
  let releasing = 0;
  let overlapped = false;
  const headers = new Headers({ "message-id": "<m1@sender.example>" });
  for (const address of [fails.forwardedTo || []].flat()) headers.append("x-forwarded-to", address);
  const raw = new TextEncoder().encode(
    [
      ...(fails.headers || []),
      "From: Ada <ada@sender.example>",
      "To: hello@mind.example",
      "Message-ID: <m1@sender.example>",
      "Subject: hello",
      "",
      "hi",
      "",
    ].join("\r\n"),
  );
  return {
    did,
    appended,
    /** The payload of each `email/received` the mind took. */
    received,
    /** Each call of `receiveEmail`: its events' keys and its files' paths. */
    calls,
    /** Each ask for the mind's next request to forward the mail. */
    asks,
    /** The addresses whose attempt is claimed. */
    claims,
    /** The claims given back on a mind whose claim hangs. */
    released,
    /** Whether two releases ever ran at the same time. */
    overlapped: () => overlapped,
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
        if (fails.mind) throw new Error(fails.mind);
        calls.push({
          events: mail.events.map((event) => event.idempotencyKey),
          files: mail.files.map((file) => file.path),
        });
        did.push("the mind kept the mail");
        received.push(...mail.events.map((event) => event.payload));
        return fails.offset === null ? undefined : { offset };
      },
      append: async (path: string, events: unknown[]) => {
        if (fails.append) throw new Error(fails.append);
        appended.push({ path, events });
      },
      // As the mind's claim of one attempt for a mail and an address.
      emailForwardClaim: async (claim: { to: string; owner: string; release?: true }) => {
        if (fails.claims === "none") throw new Error("the mind has no emailForwardClaim");
        if (fails.claims === "answer lost") {
          if (claim.release) released.push(claim.to);
          else throw new Error("Network connection lost.");
          return true;
        }
        if (fails.claims === "hangs") {
          if (!claim.release) await new Promise((resolve) => setTimeout(resolve, 200));
          else {
            // a release takes a while, and says how many were running with it
            releasing += 1;
            overlapped ||= releasing > 1;
            // longer than the claim's late answer takes, so an unchained second release would
            // start while the first still runs
            await new Promise((resolve) => setTimeout(resolve, 250));
            releasing -= 1;
            released.push(claim.to);
          }
          return true;
        }
        if (fails.claimCallFails && !claim.release) throw new Error("Network connection lost.");
        // as the mind: only the delivery that took a claim gives it back
        if (claim.release) {
          if (owners.get(claim.to) === claim.owner) claims.delete(claim.to);
          return true;
        }
        if (claims.has(claim.to)) return false;
        claims.add(claim.to);
        owners.set(claim.to, claim.owner);
        return true;
      },
      // As the mind waits for the next request on its email log: null when none came in time.
      emailForwardRequest: async (wait: {
        raw: string;
        afterOffset?: number;
        timeoutMs: number;
      }) => {
        asks.push({ raw: wait.raw, afterOffset: wait.afterOffset });
        if (typeof fails.requests === "string") throw new Error(fails.requests);
        if (asksFailing-- > 0) throw new Error("the link broke");
        const next = requests[0];
        const waitMs = Math.min(next?.afterMs ?? (next ? 0 : Infinity), wait.timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (!next || (next.afterMs ?? 0) > wait.timeoutMs) return null;
        requests.shift();
        return { offset: ++offset, to: next.to, origin: next.origin || "/" };
      },
    },
  };
}
