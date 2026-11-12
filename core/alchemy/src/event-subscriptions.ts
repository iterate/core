// event-subscriptions.ts — A STACK'S EVENT SUBSCRIPTION IS FOUND BY ITS QUEUE, never by reading
// every event subscription of the account.
//
// Alchemy's provider for `Cloudflare.Queues.Subscription`, with no id in the stack's state (a
// stack's first deploy), looks for one of its name in the account's whole list, 20 a page. An
// account that holds tens of thousands of old subscriptions makes that one step take most of a
// deploy's time. This provider is Alchemy's, except there: with no stored id it reports none and
// goes to create, and only when Cloudflare answers that the source already has a subscription does
// it read the queue's own subscriptions (`findQueueEventSubscription`). Once a deploy has stored the
// id, Alchemy's provider reads that id alone.
//
// What the list (`GET /accounts/{account_id}/event_subscriptions/subscriptions`) offers:
// https://developers.cloudflare.com/api/resources/queues/subresources/subscriptions/methods/list/
// documents `order` (created_at, name, enabled, source), `direction` (asc, desc), `page` and
// `per_page` (at most 100), and no filter. Cloudflare also takes `queue_id`, undocumented: it then
// answers the queue's subscriptions alone, but its `result_info.total_count` is still the
// account's. So the read stops at the first page that is not full, never by the count.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { type Call, CLOUDFLARE_API, accountUrl, callWithHeaders } from "./cloudflare-call.ts";

/** At most this many pages of `EVENT_SUBSCRIPTION_PAGE_ROWS` are read for one subscription. */
export const EVENT_SUBSCRIPTION_PAGES = 5;
/** The largest page Cloudflare answers. */
const EVENT_SUBSCRIPTION_PAGE_ROWS = 100;

/** One event subscription as Cloudflare's API answers it. */
export type EventSubscriptionRow = {
  id: string;
  name: string;
  enabled: boolean;
  events: string[];
  source: { type?: string };
  destination: { queue_id?: string };
  created_at: string;
  modified_at: string;
};

/** The subscription on `queueId` that `matches`, read with Cloudflare's `queue_id` filter. Only
 *  when Cloudflare refuses that filter (405) are the account's subscriptions read, newest first.
 *  Either way at most `EVENT_SUBSCRIPTION_PAGES` pages; `unfound` says why none was found. */
export async function findQueueEventSubscription(input: {
  accountId: string;
  queueId: string;
  matches: (row: EventSubscriptionRow) => boolean;
  call: Call;
}): Promise<{ found: EventSubscriptionRow; unfound?: never } | { found?: never; unfound: string }> {
  const list = `${accountUrl(input.accountId)}/event_subscriptions/subscriptions`;
  const order = `order=created_at&direction=desc&per_page=${EVENT_SUBSCRIPTION_PAGE_ROWS}`;
  let filter = `&queue_id=${encodeURIComponent(input.queueId)}`;
  let pages = 0;
  for (let page = 1; page <= EVENT_SUBSCRIPTION_PAGES; page++) {
    const answer = await input.call("GET", `${list}?${order}&page=${page}${filter}`);
    if (answer.status === 405 && filter) {
      filter = "";
      page = 0;
      continue;
    }
    if (answer.status !== 200)
      return {
        unfound: `Cloudflare answered ${answer.status} to the list of event subscriptions (page ${page})`,
      };
    pages++;
    // The cast: Cloudflare's documented answer, a page of subscriptions.
    const rows = (answer.body as { result?: EventSubscriptionRow[] } | null)?.result ?? [];
    const found = rows.find(
      (row) => row.destination?.queue_id === input.queueId && input.matches(row),
    );
    if (found) return { found };
    if (rows.length < EVENT_SUBSCRIPTION_PAGE_ROWS)
      return { unfound: `${pages} page${pages === 1 ? "" : "s"} of event subscriptions read` };
  }
  return {
    unfound:
      `${pages} pages of event subscriptions read, ${EVENT_SUBSCRIPTION_PAGES} at most: Cloudflare ` +
      "did not filter them by the queue",
  };
}

/** Cloudflare says the source has a subscription, and the read by the queue found none of ours. */
class EventSubscriptionUnfound extends Data.TaggedError("EventSubscriptionUnfound")<{
  message: string;
}> {}

type Subscription = Cloudflare.Queues.Subscription;

/** Alchemy's provider `base`, except the read with no stored id and a create that Cloudflare
 *  refuses because the source already has a subscription (see the top of this file). */
export function narrowEventSubscriptionProvider<R>(
  base: Provider.ProviderService<Subscription>,
  cloudflareOf: Effect.Effect<{ accountId: string; call: Call }, unknown, R>,
): Provider.ProviderService<Subscription> {
  return {
    ...base,
    read: (input) => (input.output?.subscriptionId ? base.read!(input) : Effect.succeed(undefined)),
    reconcile: (input) =>
      base.reconcile(input).pipe(
        Effect.catchTag("SubscriptionAlreadyExists", (exists: { message: string }) =>
          Effect.gen(function* () {
            const { news } = input;
            const { accountId, call } = yield* cloudflareOf;
            const read = yield* Effect.promise(() =>
              findQueueEventSubscription({
                accountId,
                queueId: news.queueId,
                matches: (row) =>
                  row.source?.type === news.source.type && (!news.name || row.name === news.name),
                call,
              }),
            );
            if (!read.found)
              return yield* new EventSubscriptionUnfound({
                message:
                  `Cloudflare refused to create the event subscription ${news.name || input.id} ` +
                  `(${news.source.type}): the source already has one, and none of that name is on ` +
                  `the queue ${news.queueId} (${read.unfound}). Delete the subscription of this source ` +
                  "(the dashboard's Queues, Event subscriptions), then deploy again. Cloudflare " +
                  `said: ${exists.message}`,
              });
            const row = read.found;
            return yield* base.reconcile({
              ...input,
              output: {
                subscriptionId: row.id,
                accountId,
                name: row.name,
                source: news.source,
                events: row.events,
                queueId: news.queueId,
                enabled: row.enabled,
                createdAt: row.created_at,
                modifiedAt: row.modified_at,
              },
            });
          }),
        ),
      ),
    // The cast: the object above is Alchemy's own provider with two of its members replaced, and
    // the spread loses the service's type.
  } as Provider.ProviderService<Subscription>;
}

/** The deploy's account, and a call of Cloudflare's API with the credentials Alchemy's providers
 *  use. */
const cloudflareOfDeploy = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  const credentials = yield* yield* Cloudflare.Credentials;
  const authorization: Record<string, string> =
    credentials.type === "apiKey"
      ? { "x-auth-key": Redacted.value(credentials.apiKey), "x-auth-email": credentials.email }
      : {
          authorization: `Bearer ${Redacted.value(credentials.type === "apiToken" ? credentials.apiToken : credentials.accessToken)}`,
        };
  // accountUrl names Cloudflare's own API; the credentials may name another base
  const base = credentials.apiBaseUrl.replace(/\/$/, "");
  return {
    accountId,
    call: callWithHeaders(authorization, (url) => url.replace(CLOUDFLARE_API, base)),
  };
});

/** The provider layer: put it over `Cloudflare.providers()`; a provider of a resource's own type in
 *  the stack's context is found before the one in Alchemy's collection. */
export const NarrowEventSubscriptionProvider = () =>
  Provider.effect(
    Cloudflare.Queues.Subscription,
    Effect.gen(function* () {
      const base = yield* Cloudflare.Queues.Subscription.Provider;
      return narrowEventSubscriptionProvider(base, cloudflareOfDeploy);
    }),
  ).pipe(Layer.provide(Cloudflare.Queues.SubscriptionProvider()));
