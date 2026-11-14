// The order in which a deploy makes the stack's mail (mail.ts): Alchemy makes a resource after the
// resources whose outputs its props hold.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import { StackContext } from "alchemy/StackContext";
import * as Effect from "effect/Effect";
import { mailEvents, mailOnZone } from "./mail.ts";

const ZONE = { id: "zone-1", name: "one.example" };

void test("the mail events subscription is made after Email Sending: Cloudflare refuses it for a domain that is not a sending subdomain yet", async () => {
  const stack = { name: "one", stage: "one", resources: {}, bindings: {}, actions: {} };
  const resources = await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Cloudflare.Queues.Queue("CloudflareEvents", { name: "one-events" });
      const sending = yield* mailOnZone(ZONE, "one-boundary");
      yield* mailEvents({ sending, queueId: queue.queueId, name: "one-events-mail" });
      // the stack's resources by id, each with the props it was declared with
      return stack.resources as Record<string, { Props: unknown }>;
    }).pipe(
      Effect.provideService(StackContext, stack),
      // a declaration reads no provider (a deploy does), so the test gives an empty one
      Effect.provideService(Cloudflare.Providers, {} as never),
    ),
  );
  const after = (id: string) => Object.keys(Output.upstreamAny(resources[id]!.Props)).sort();
  assert.deepEqual(after("MailEventsSubscription"), ["CloudflareEvents", "EmailSending"]);
  // Email Sending itself waits for nothing of the stack
  assert.deepEqual(after("EmailSending"), []);
});
