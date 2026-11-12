// queue-consumers.ts — A QUEUE CONSUMER WHOSE QUEUE IS GONE IS GONE TOO.
//
// Alchemy's provider for `Cloudflare.Queues.Consumer` replaces a consumer whose queue changed by
// deleting it first, on the queue its state names. When that queue no longer exists (a stack
// whose queue was renamed, so Alchemy deleted the old one), Cloudflare answers `QueueNotFound`,
// the replace fails, and so does every later deploy of the stack. A consumer cannot outlive its
// queue, so that answer means the consumer is gone: the delete counts as done. Everything else is
// Alchemy's provider.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type Consumer = Cloudflare.Queues.Consumer;

/** Alchemy's provider `base`, except a delete on a queue that no longer exists. */
export function goneQueueConsumerProvider(
  base: Provider.ProviderService<Consumer>,
): Provider.ProviderService<Consumer> {
  return {
    ...base,
    delete: (input) =>
      base.delete(input).pipe(
        Effect.catchIf(
          (error: unknown) =>
            Boolean(error) &&
            typeof error === "object" &&
            "_tag" in error! &&
            error._tag === "QueueNotFound",
          () => Effect.void,
        ),
      ),
  };
}

/** The stack's provider of queue consumers: Alchemy's, with `goneQueueConsumerProvider`. */
export const GoneQueueConsumerProvider = () =>
  Provider.effect(
    Cloudflare.Queues.Consumer,
    Effect.gen(function* () {
      return goneQueueConsumerProvider(yield* Cloudflare.Queues.Consumer.Provider);
    }),
  ).pipe(Layer.provide(Cloudflare.Queues.ConsumerProviderLive()));
