import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { StreamEvent } from "iterate/stream/processor";
import { EmailContract } from "iterate/email";
import { projectApiUrlOf } from "iterate/project-api";
import { attempt, type Check, projectRoot } from "./lib.ts";

const MCP_INSTRUCTION_ROOTS = [
  "whoami",
  "rewriteRules",
  "cd",
  "repos",
  "waitForEvent",
  "workers",
  "kv",
  "url",
  "fetch",
];

const MAIL_ROUND_TRIP_MS = 120_000;

export async function integrationsChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token)
    return [
      {
        check: "integrations: mail, url, webhooks, MCP roots",
        pass: true,
        detail: "skipped: ITERATE_PROTOTYPE_TOKEN is not set",
      },
    ];
  const root = () => projectRoot(domain, token);
  const marker = crypto.randomUUID().slice(0, 8);
  const checks: Check[] = [];

  let sentAt = 0;
  checks.push(
    await attempt(
      "mail: itx.email.send to the project's own domain records email/sent",
      async () => {
        const sent = (await root().email.send({
          to: `smoke-${marker}@${domain}`,
          subject: `smoke ${marker}`,
          text: `A smoke check's message, ${marker}.`,
        })) as StreamEvent;
        sentAt = sent.offset;
        return {
          pass: sent.type === "events.iterate.com/email/sent",
          detail: `${sent.type} at ${sent.offset}`,
        };
      },
    ),
  );
  let received: StreamEvent | undefined;
  let deadLetter: StreamEvent | undefined;
  checks.push(
    await attempt("mail: it comes back as email/received, in the published contract", async () => {
      if (!sentAt) return { pass: false, detail: "nothing was sent" };
      const deadline = Date.now() + MAIL_ROUND_TRIP_MS;
      for (let after = sentAt; Date.now() < deadline && !received;) {
        const page = await root().cd("/integrations/email").readEvents(after, 200);
        for (const event of page.events) {
          if (
            event.type === "events.iterate.com/email/received" &&
            (event.payload as { subject?: string }).subject === `smoke ${marker}`
          )
            received = event;
          after = event.offset;
        }
        if (!received) await sleep(3_000);
      }
      if (!received) return { pass: false, detail: `not back within ${MAIL_ROUND_TRIP_MS} ms` };
      const parsed = EmailContract.events[
        "events.iterate.com/email/received"
      ].payloadSchema.safeParse(received.payload);
      return {
        pass: parsed.success,
        detail: parsed.success
          ? `offset ${received.offset}, from ${parsed.data.from}, raw ${parsed.data.raw?.path}`
          : parsed.error.message.slice(0, 300),
      };
    }),
    await attempt("mail: the message as it arrived is a project file", async () => {
      const path = (received?.payload as { raw?: { path: string } } | undefined)?.raw?.path;
      if (!path) return { pass: false, detail: "no message came back" };
      const head = await root().files.get(path).head();
      return { pass: Boolean(head), detail: `${path}: ${head ? "stored" : "missing"}` };
    }),
    await attempt("mail: the default config's handler took it (no dead letter)", async () => {
      if (!received) return { pass: false, detail: "no message came back" };
      await sleep(10_000);
      const page = await root().cd("/integrations/email").readEvents(received.offset, 500);
      deadLetter = page.events.find(
        (event) =>
          event.type === "events.iterate.com/itx/subscription-delivery-failed" &&
          (event.payload as { offset?: number }).offset === received!.offset,
      );
      return {
        pass: !deadLetter,
        detail: deadLetter ? JSON.stringify(deadLetter.payload).slice(0, 300) : "none after 10 s",
      };
    }),
  );

  checks.push(
    await attempt("url: the apex, and a routing key's host at a path", async () => {
      const [apex, keyed] = await Promise.all([
        root().url(),
        root().url({ routingSlug: "smoke", path: "/a?b=1" }),
      ]);
      const pass = apex === `https://${domain}/` && keyed === `https://smoke.${domain}/a?b=1`;
      return { pass, detail: `${apex} · ${keyed}` };
    }),
  );

  const name = `smoke-webhook-${marker}`;
  const material = crypto.randomUUID();
  const webhookUrl = `${projectApiUrlOf(domain)}/webhooks/${name}`;
  const body = JSON.stringify({ smoke: marker });
  const post = (signature: string) =>
    fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": marker,
      },
      body,
    });
  checks.push(
    await attempt("webhook: a good signature lands on /integrations/webhooks/<name>", async () => {
      // a webhook's secret is made to verify: a secret answers only the operations it was made with
      await root().secrets.set(`/secrets/${name}`, material, {
        urls: ["https://example.com"],
        operations: ["verifyHmac"],
      });
      const response = await post(
        `sha256=${createHmac("sha256", material).update(body).digest("hex")}`,
      );
      const answer = (await response.json().catch(() => null)) as { offset?: number } | null;
      return { pass: response.status === 200 && !!answer?.offset, detail: `${response.status}` };
    }),
    await attempt("webhook: a bad signature is refused", async () => {
      const response = await post(`sha256=${"0".repeat(64)}`);
      await response.body?.cancel();
      await root().secrets.delete(`/secrets/${name}`);
      return { pass: response.status === 401, detail: `${response.status}` };
    }),
  );

  checks.push(
    await attempt("mcp: rewriteRules.list() names every root the instructions name", async () => {
      const listed = JSON.stringify(await root().rewriteRules.list());
      const missing = MCP_INSTRUCTION_ROOTS.filter((name) => !listed.includes(`"itx.${name}"`));
      return { pass: missing.length === 0, detail: missing.length ? `missing ${missing}` : "all" };
    }),
  );
  return checks;
}
