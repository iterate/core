// artifacts-repo-subscription.ts — THE EVENTS OF ONE ARTIFACTS REPO, ON A QUEUE, AS A RESOURCE.
// Cloudflare's event subscriptions take an Artifacts repo as a source
// (https://developers.cloudflare.com/queues/event-subscriptions/), and so do the calls of the
// Cloudflare SDK under Alchemy, which this provider makes. Alchemy's own
// `Cloudflare.Queues.Subscription` does not list that source and reads none back
// (2.0.0-beta.85 and beta.87). When it does, this file goes.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as queues from "@distilled.cloud/cloudflare/queues";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export type ArtifactsRepoSubscription = Resource<
  "Iterate.ArtifactsRepoSubscription",
  {
    name: string;
    /** The repo `repo` of the Artifacts namespace `namespace`: fixed once the subscription is made. */
    namespace: string;
    repo: string;
    /** The repo's event types to deliver, as Cloudflare names them: `pushed`, `token.created`. */
    events: string[];
    queueId: string;
  },
  { subscriptionId: string },
  never,
  Cloudflare.Providers
>;
export const ArtifactsRepoSubscription = Resource<ArtifactsRepoSubscription>(
  "Iterate.ArtifactsRepoSubscription",
);

export const ArtifactsRepoSubscriptionProvider = () =>
  Provider.succeed(ArtifactsRepoSubscription, {
    stables: ["subscriptionId"],
    // a subscription's source is fixed once it is made
    diff: ({ olds, news }) =>
      Effect.succeed(
        isResolved(news) && (olds.namespace !== news.namespace || olds.repo !== news.repo)
          ? ({ action: "replace" } as const)
          : undefined,
      ),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      const wanted = {
        name: news.name,
        enabled: true,
        events: news.events,
        destination: { type: "queues.queue", queueId: news.queueId },
      };
      // The id in the state is a hint: a subscription that somebody deleted (404) is made again.
      // Any other failure of the read fails the deploy.
      const kept =
        output &&
        (yield* queues
          .getSubscription({ accountId, subscriptionId: output.subscriptionId })
          .pipe(Effect.catchTag("SubscriptionNotFound", () => Effect.undefined)));
      const observed =
        kept ||
        (yield* queues
          .createSubscription({
            ...wanted,
            accountId,
            source: { type: "artifacts.repo", namespace: news.namespace, repoName: news.repo },
          })
          .pipe(
            // Cloudflare takes one subscription for a repo, to any queue, and answers 405 to a
            // second. A create that was cut off before its id was stored left this stack's own:
            // the repo's subscription to this stack's queue. One to another queue is not ours.
            Effect.catchTag("SubscriptionAlreadyExists", (exists) =>
              Effect.gen(function* () {
                const ofTheRepo = yield* queues.listSubscriptions
                  .items({ accountId, order: "created_at", direction: "desc", perPage: 100 })
                  .pipe(
                    // the newest 5,000: an account can hold tens of thousands of old ones
                    Stream.take(5_000),
                    Stream.filter(
                      ({ source }) =>
                        source.type === "artifacts.repo" &&
                        source.namespace === news.namespace &&
                        source.repoName === news.repo,
                    ),
                    Stream.runHead,
                    Effect.map(Option.getOrUndefined),
                  );
                if (ofTheRepo?.destination.queueId === news.queueId) return ofTheRepo;
                return yield* Effect.die(
                  `The repo ${news.repo} of ${news.namespace} already has an event subscription` +
                    (ofTheRepo
                      ? ` (${ofTheRepo.id}, to the queue ${ofTheRepo.destination.queueId})`
                      : "") +
                    `, which this stack did not make. Delete it (DELETE /accounts/${accountId}/event_subscriptions/subscriptions/<id>), then deploy again. Cloudflare said: ${exists.message}`,
                );
              }),
            ),
          ));
      const differs =
        observed.name !== wanted.name ||
        !observed.enabled ||
        observed.destination.queueId !== news.queueId ||
        [...observed.events].sort().join() !== [...news.events].sort().join();
      if (differs)
        yield* queues.patchSubscription({ ...wanted, accountId, subscriptionId: observed.id });
      return { subscriptionId: observed.id };
    }),
    delete: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
      yield* queues
        .deleteSubscription({ accountId, subscriptionId: output.subscriptionId })
        .pipe(Effect.catchTag("SubscriptionNotFound", () => Effect.void));
    }),
  });
