import { expect, test } from "vitest";
import { receivedMail } from "./mail.ts";

const GROUP = "team@group.example";

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

/** One mail as Cloudflare hands it to the Worker, with a mind and a forward that say what they did,
 *  or fail with the words given. */
function delivered(
  fails: {
    forward?: string;
    mind?: string;
    /** One address, or one for each `X-Forwarded-To` line, the newest first. */
    forwardedTo?: string | string[];
    append?: string;
  } = {},
) {
  const did: string[] = [];
  const appended: { path: string; events: unknown[] }[] = [];
  const headers = new Headers({ "message-id": "<m1@sender.example>" });
  for (const address of [fails.forwardedTo || []].flat()) headers.append("x-forwarded-to", address);
  const raw = new TextEncoder().encode(
    [
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
    // The cast: of Cloudflare's message, the handler reads the envelope, the headers and the bytes and
    // calls `forward`.
    message: {
      from: "ada@sender.example",
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
      receiveEmail: async () => {
        if (fails.mind) throw new Error(fails.mind);
        did.push("the mind got it");
      },
      append: async (path: string, events: unknown[]) => {
        if (fails.append) throw new Error(fails.append);
        appended.push({ path, events });
      },
    },
  };
}
