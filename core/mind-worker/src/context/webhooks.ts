import { sha256Hex, type ItxHostRootContext } from "core-itx";
import { InvokeHandle, print } from "iterate/expression";
import { codedError } from "iterate/lib";
import { assertSecretPath } from "iterate/secret-placeholder";
import type { StreamEvent } from "iterate/stream/processor";
import { z } from "zod";
import { hopCaller } from "./hop-caller.ts";

export const WEBHOOKS_ROOT_DESCRIPTION =
  'an HTTP webhook as a fan-out row\'s target: `subscribe({ target: "itx.webhooks.get({ url, signingSecret? }).deliverEvent", ordered: false })` POSTs each event, signed with the secret when one is named (`iterate-signature: v1=<hex HMAC-SHA256 of "<iterate-timestamp>.<body>">`), a secret made with `operations: ["signHmac"]`';

const WebhookSpec = z.strictObject({
  url: z.url({ protocol: /^https?$/, error: "a webhook's url is an http(s) URL" }),
  signingSecret: z.string().transform(assertSecretPath).optional(),
});

/** Under the delivery watchdog (20 s), so the request is cancelled before the watchdog gives up. */
const WEBHOOK_TIMEOUT_MS = 15_000;

export function webhooksRoot(context: ItxHostRootContext, domain: string) {
  const ownContext = () => context.context(context.path);
  return {
    // An InvokeHandle, so across a `cd` hop the delivery's call reaches it whole, its authority carried.
    get: (spec: z.input<typeof WebhookSpec>) => {
      const { url, signingSecret } = WebhookSpec.parse(spec);
      return new InvokeHandle(async (methodSteps) => {
        const [call] = methodSteps;
        if (methodSteps.length !== 1 || !Array.isArray(call) || call[0] !== "deliverEvent")
          throw new Error(
            `webhooks.get(spec).${print(methodSteps)}: a webhook answers deliverEvent(event) alone`,
          );
        const [, event] = call as [string, StreamEvent];
        const body = JSON.stringify(event);
        await assertDeliveryCaller(
          context.caller().delivery,
          "webhooks.get(spec).deliverEvent",
          body,
        );
        const headers = new Headers({
          "content-type": "application/json",
          "iterate-event-id": `${domain}${event.path}@${event.offset}`,
        });
        if (signingSecret) {
          const timestamp = String(Math.floor(Date.now() / 1000));
          // its value never reaches this Worker
          const signature = (await ownContext().invoke(
            ["itx", "secrets", ["signHmac", signingSecret, { payload: `${timestamp}.${body}` }]],
            [],
            hopCaller(context),
          )) as string;
          headers.set("iterate-timestamp", timestamp);
          headers.set("iterate-signature", `v1=${signature}`);
        }
        // Through this context's own `itx.fetch`, so its rules apply. A followed redirect would
        // carry the event and its signature to another origin.
        const request = new Request(url, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        const response = (await ownContext().invoke(
          ["itx", "fetch"],
          [request],
          hopCaller(context),
        )) as Response;
        await response.body?.cancel();
        if (response.ok) return;
        if (response.status === 410)
          throw codedError(
            "GONE",
            `webhook ${url} answered 410 Gone: its row halts until an operator resumes it`,
          );
        throw new Error(`webhook ${url} answered ${response.status}`);
      });
    },
  };
}

// `Caller.delivery` is the SHA-256 of the event the delivery loop carries: anyone else could hand
// a subscriber an event no log holds.
export async function assertDeliveryCaller(
  delivery: string | undefined,
  what: string,
  eventJson: string,
) {
  if (!delivery || delivery !== (await sha256Hex(eventJson)))
    throw codedError("FORBIDDEN", `${what} is the delivery loop's own call`);
}
