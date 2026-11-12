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
  expect(mail).toMatchObject({ did: ["the mind got it", `forward to ${GROUP} refused`] });
});

test("any other failure of the forward fails the delivery, so that Cloudflare delivers the mail again", async () => {
  const mail = delivered({ forward: "destination address not verified" });
  await expect(receivedMail(mail.message, mail.env(GROUP), mail.mind)).rejects.toThrow(
    "destination address not verified",
  );
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
function delivered(fails: { forward?: string; mind?: string } = {}) {
  const did: string[] = [];
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
    // The cast: of Cloudflare's message, the handler reads the envelope and the bytes and calls
    // `forward`.
    message: {
      from: "ada@sender.example",
      to: "hello@mind.example",
      raw: new Response(raw).body,
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
    },
  };
}
