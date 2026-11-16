import { expect, test } from "vitest";
import { receivedMail } from "./mail.ts";

const GROUP = "team@group.example";

/** Cloudflare's record that the sender's domain signed the mail and its server handed it over. */
const PROVEN =
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sender.example; spf=pass smtp.mailfrom=ada@sender.example";

test("a mail goes to the mind and, with no forward address, nowhere else", async () => {
  const mail = delivered();
  await receivedMail(mail.message, mail.env(), mail.mind);
  expect(mail).toMatchObject({ did: ["the mind got it"] });
});

test("with a forward address the original is forwarded there, after the mind has it", async () => {
  const mail = delivered();
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({ did: ["the mind got it", `forwarded to ${GROUP}`] });
});

test("a mail that Cloudflare will not forward because nobody proved its sender is kept, and the delivery stands", async () => {
  const mail = delivered({ forward: "non-authenticated emails cannot be forwarded" });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({
    did: ["the mind got it", `forward to ${GROUP} refused`],
    appended: [
      {
        path: "/integrations/email",
        events: [
          {
            type: "events.iterate.com/email/forward-failed",
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
    did: ["the mind got it", `forward to ${GROUP} refused`],
    appended: [{ events: [{ payload: { error: "Error: destination address not verified" } }] }],
  });
});

test("a mail that was forwarded to this address before is not forwarded again: a forward address that comes back here ends at its second visit", async () => {
  // Email Routing writes `X-Forwarded-To` on what it forwards
  const mail = delivered({ forwardedTo: `Team@Group.Example` });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({
    did: ["the mind got it"],
    // any sender can write the header, so the mind's log says that the mail was not forwarded
    appended: [{ events: [{ payload: { error: expect.stringContaining("forwarded to") } }] }],
  });
  // two header lines, the newest first: this forward address is in the older one
  const twice = delivered({ forwardedTo: ["next@other.example", GROUP] });
  await receivedMail(twice.message, twice.env(GROUP), twice.mind);
  expect(twice).toMatchObject({ did: ["the mind got it"] });
  // a forward that went to another address is forwarded on: one that only ends in the same
  // letters, too
  for (const forwardedTo of ["someone@else.example", `the-${GROUP}`]) {
    const other = delivered({ forwardedTo });
    await receivedMail(other.message, other.env(GROUP), other.mind);
    expect(other).toMatchObject({ did: ["the mind got it", `forwarded to ${GROUP}`] });
  }
});

test("a fact that the mind does not take changes nothing of the delivery: an unproved sender's mail still stands", async () => {
  const mail = delivered({
    forward: "non-authenticated emails cannot be forwarded",
    append: "the email log is paused",
  });
  await receivedMail(mail.message, mail.env(GROUP), mail.mind);
  expect(mail).toMatchObject({ did: ["the mind got it", `forward to ${GROUP} refused`] });
});

test("a mail that the mind did not take is not forwarded: the next delivery does both", async () => {
  const mail = delivered({ mind: "the mind is away" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind)).rejects.toThrow(
    "the mind is away",
  );
  expect(mail).toMatchObject({ did: [] });
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
  expect(mail).toMatchObject({ received: [expected] });
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
    /** Header lines above the mail's own. */
    headers?: string[];
    /** The envelope sender, if not the From address. */
    envelopeFrom?: string;
  } = {},
) {
  const did: string[] = [];
  const received: unknown[] = [];
  const appended: { path: string; events: unknown[] }[] = [];
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
    /** The payload of each `email/received` the mind got. */
    received,
    // The cast: of Cloudflare's message, the handler reads the envelope, the headers and the bytes and
    // calls `forward`.
    message: {
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
      },
    } as unknown as ForwardableEmailMessage,
    env: (forwardTo?: string) => ({
      AUTH: { isMember: async () => false },
      MAIL_FORWARD_TO: forwardTo,
    }),
    mind: {
      receiveEmail: async (mail: { events: { payload?: unknown }[] }) => {
        if (fails.mind) throw new Error(fails.mind);
        did.push("the mind got it");
        received.push(...mail.events.map((event) => event.payload));
      },
      append: async (path: string, events: unknown[]) => {
        if (fails.append) throw new Error(fails.append);
        appended.push({ path, events });
      },
    },
  };
}
