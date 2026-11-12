// How a stack finds its event subscription without reading every subscription of the account
// (event-subscriptions.ts), against a pretend Cloudflare and a pretend Alchemy provider.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type { Call } from "./cloudflare-call.ts";
import {
  EVENT_SUBSCRIPTION_PAGES,
  findQueueEventSubscription,
  NarrowEventSubscriptionProvider,
  narrowEventSubscriptionProvider,
} from "./event-subscriptions.ts";

const ACCOUNT = "a".repeat(32);
const QUEUE = "q".repeat(32);
const OTHER_QUEUE = "o".repeat(32);
const NAME = "iterate-one-cloudflare-events-mail";
const SOURCE = { type: "email.sending", zoneId: "zone-1", domain: "one.example" } as const;
const ours = (row: { name: string }) => row.name === NAME;

void test("the queue's own subscriptions come in one page, though Cloudflare counts the account's", async () => {
  const cloudflare = pretendCloudflare({
    onQueue: [row("sub-ours", NAME, QUEUE), row("sub-artifacts", "artifacts", QUEUE)],
    totalCount: 55_604,
  });
  const read = await findQueueEventSubscription({
    accountId: ACCOUNT,
    queueId: QUEUE,
    matches: ours,
    call: cloudflare.call,
  });
  assert.equal(read.found?.id, "sub-ours");
  assert.equal(cloudflare.reads.length, 1);
  assert.match(cloudflare.reads[0]!, /[?&]queue_id=q{32}(&|$)/);
  assert.match(cloudflare.reads[0]!, /[?&]per_page=100(&|$)/);
});

void test("when Cloudflare refuses the queue filter, newest first is read, and the read stops at ours", async () => {
  const cloudflare = pretendCloudflare({
    refuseQueueFilter: true,
    account: [...others(150), row("sub-ours", NAME, QUEUE), ...others(500)],
  });
  const read = await findQueueEventSubscription({
    accountId: ACCOUNT,
    queueId: QUEUE,
    matches: ours,
    call: cloudflare.call,
  });
  assert.equal(read.found?.id, "sub-ours");
  // the refused filtered read, then two pages of the account, newest first
  assert.equal(cloudflare.reads.length, 3);
  assert.match(cloudflare.reads[1]!, /order=created_at&direction=desc/);
});

void test("a subscription of our name on another queue is not ours", async () => {
  const cloudflare = pretendCloudflare({
    refuseQueueFilter: true,
    account: [row("sub-old", NAME, OTHER_QUEUE)],
  });
  const read = await findQueueEventSubscription({
    accountId: ACCOUNT,
    queueId: QUEUE,
    matches: ours,
    call: cloudflare.call,
  });
  assert.equal(read.found, undefined);
  assert.match(read.unfound!, /1 page/);
});

void test("past the page bound the read stops, and says how many pages it read and what to do", async () => {
  const cloudflare = pretendCloudflare({
    refuseQueueFilter: true,
    account: [...others(5_000), row("sub-ours", NAME, QUEUE)],
  });
  const read = await findQueueEventSubscription({
    accountId: ACCOUNT,
    queueId: QUEUE,
    matches: ours,
    call: cloudflare.call,
  });
  assert.equal(read.found, undefined);
  assert.equal(cloudflare.reads.length, 1 + EVENT_SUBSCRIPTION_PAGES);
  assert.match(read.unfound!, new RegExp(`${EVENT_SUBSCRIPTION_PAGES} pages`));
});

void test("an answer Cloudflare refuses ends the read with a line that says so", async () => {
  const cloudflare = pretendCloudflare({ refuseAll: 403 });
  const read = await findQueueEventSubscription({
    accountId: ACCOUNT,
    queueId: QUEUE,
    matches: ours,
    call: cloudflare.call,
  });
  assert.equal(read.found, undefined);
  assert.match(read.unfound!, /answered 403/);
});

void test("a first deploy with no stored id creates the subscription and lists nothing", async () => {
  const cloudflare = pretendCloudflare({ onQueue: [] });
  const alchemy = pretendAlchemy({ exists: false });
  const provider = narrowEventSubscriptionProvider(
    alchemy.service,
    Effect.succeed({ accountId: ACCOUNT, call: cloudflare.call }),
  );

  const read = await Effect.runPromise(provider.read!(readInput(undefined)));
  assert.equal(read, undefined);
  const made = await Effect.runPromise(provider.reconcile(reconcileInput(undefined)));
  assert.equal(made.subscriptionId, "sub-new");
  assert.deepEqual(alchemy.calls, ["reconcile without id"]);
  assert.deepEqual(cloudflare.reads, []);
});

void test("when Cloudflare answers that it exists, the narrow read finds ours and nothing more is read", async () => {
  const cloudflare = pretendCloudflare({
    onQueue: [row("sub-ours", NAME, QUEUE)],
    totalCount: 55_604,
  });
  const alchemy = pretendAlchemy({ exists: true });
  const provider = narrowEventSubscriptionProvider(
    alchemy.service,
    Effect.succeed({ accountId: ACCOUNT, call: cloudflare.call }),
  );

  const made = await Effect.runPromise(provider.reconcile(reconcileInput(undefined)));
  assert.equal(made.subscriptionId, "sub-ours");
  assert.deepEqual(alchemy.calls, ["reconcile without id", "reconcile sub-ours"]);
  assert.equal(cloudflare.reads.length, 1);
});

void test("past the page bound the deploy fails with an error that says what to do", async () => {
  const cloudflare = pretendCloudflare({ refuseQueueFilter: true, account: others(5_000) });
  const alchemy = pretendAlchemy({ exists: true });
  const provider = narrowEventSubscriptionProvider(
    alchemy.service,
    Effect.succeed({ accountId: ACCOUNT, call: cloudflare.call }),
  );

  const exit = await Effect.runPromiseExit(provider.reconcile(reconcileInput(undefined)));
  assert.ok(Exit.isFailure(exit));
  const failure = JSON.stringify(exit.cause);
  assert.match(failure, /EventSubscriptionUnfound/);
  assert.match(failure, new RegExp(`${EVENT_SUBSCRIPTION_PAGES} pages`));
  assert.match(failure, /Delete the subscription of this source/);
  assert.equal(cloudflare.reads.length, 1 + EVENT_SUBSCRIPTION_PAGES);
  assert.deepEqual(alchemy.calls, ["reconcile without id"]);
});

void test("a later deploy with a stored id reads that id alone", async () => {
  const cloudflare = pretendCloudflare({ onQueue: [] });
  const alchemy = pretendAlchemy({ exists: true });
  const provider = narrowEventSubscriptionProvider(
    alchemy.service,
    Effect.succeed({ accountId: ACCOUNT, call: cloudflare.call }),
  );

  const read = await Effect.runPromise(provider.read!(readInput(attributes("sub-ours"))));
  assert.equal(read?.subscriptionId, "sub-ours");
  assert.deepEqual(alchemy.calls, ["read sub-ours"]);
  assert.deepEqual(cloudflare.reads, []);
});

void test("the stack's provider of event subscriptions is found before the one in Alchemy's collection", async () => {
  const alchemy = pretendAlchemy({ exists: false });
  const collection = Layer.succeed(Cloudflare.Providers, {
    kind: "ProviderCollection",
    get: (type: string) =>
      type === "Cloudflare.Queues.Subscription" ? alchemy.service : undefined,
    providers: { "Cloudflare.Queues.Subscription": alchemy.service },
  } as never);
  // The cast: the layer's type asks for what Alchemy's lifecycle calls use (the account, the
  // stage); building it uses none of them.
  const layer = NarrowEventSubscriptionProvider().pipe(
    Layer.provideMerge(collection),
  ) as Layer.Layer<Provider.Provider<Subscription>>;
  const found = await Effect.runPromise(
    Provider.findProviderByType<Subscription>("Cloudflare.Queues.Subscription").pipe(
      Effect.provide(layer),
    ),
  );
  assert.notEqual(found, alchemy.service);
  assert.equal(await Effect.runPromise(found.read!(readInput(undefined))), undefined);
  assert.deepEqual(alchemy.calls, []);
});

type Row = ReturnType<typeof row>;

function row(id: string, name: string, queueId: string) {
  return {
    id,
    name,
    enabled: true,
    events: ["message.bounced"],
    source: { type: "email.sending", zone_id: "zone-1", domain: "one.example" },
    destination: { type: "queues.queue", queue_id: queueId },
    created_at: "2026-11-12T00:00:00Z",
    modified_at: "2026-11-12T00:00:00Z",
  };
}

function others(count: number) {
  return Array.from({ length: count }, (_, at) => row(`sub-${at}`, `other-${at}`, OTHER_QUEUE));
}

/** Cloudflare's list of event subscriptions: `onQueue` answers a read filtered by `queue_id`,
 *  `account` (newest first) one that is not. */
function pretendCloudflare(given: {
  onQueue?: Row[];
  account?: Row[];
  totalCount?: number;
  refuseQueueFilter?: boolean;
  refuseAll?: number;
}) {
  const reads: string[] = [];
  const call: Call = async (method, url) => {
    assert.equal(method, "GET");
    const at = new URL(url);
    assert.equal(at.pathname, `/client/v4/accounts/${ACCOUNT}/event_subscriptions/subscriptions`);
    reads.push(`${at.pathname}${at.search}`);
    if (given.refuseAll) return { status: given.refuseAll, body: { success: false } };
    const filtered = at.searchParams.has("queue_id");
    if (filtered && given.refuseQueueFilter) return { status: 405, body: { success: false } };
    const all = (filtered ? given.onQueue : given.account) ?? [];
    const page = Number(at.searchParams.get("page") ?? 1);
    const perPage = Number(at.searchParams.get("per_page") ?? 20);
    const result = all.slice((page - 1) * perPage, page * perPage);
    return {
      status: 200,
      body: {
        success: true,
        result,
        result_info: {
          page,
          per_page: perPage,
          count: result.length,
          total_count: given.totalCount ?? all.length,
        },
      },
    };
  };
  return { call, reads };
}

type Subscription = Cloudflare.Queues.Subscription;
type Service = Provider.ProviderService<Subscription>;

function attributes(subscriptionId: string): Subscription["Attributes"] {
  return {
    subscriptionId,
    accountId: ACCOUNT,
    name: NAME,
    source: SOURCE,
    events: ["message.bounced"],
    queueId: QUEUE,
    enabled: true,
    createdAt: "2026-11-12T00:00:00Z",
    modifiedAt: "2026-11-12T00:00:00Z",
  };
}

/** Alchemy's own provider: its create answers that the subscription exists when `exists`. */
function pretendAlchemy(given: { exists: boolean }) {
  const calls: string[] = [];
  const service = {
    read: ({ output }) =>
      Effect.sync(() => {
        calls.push(output ? `read ${output.subscriptionId}` : "read without id");
        return output ? attributes(output.subscriptionId) : undefined;
      }),
    reconcile: ({ output }) =>
      Effect.suspend(() => {
        calls.push(output ? `reconcile ${output.subscriptionId}` : "reconcile without id");
        if (output) return Effect.succeed(attributes(output.subscriptionId));
        if (given.exists)
          return Effect.fail({
            _tag: "SubscriptionAlreadyExists" as const,
            code: 0,
            message: "do not support multiple subscriptions",
          });
        return Effect.succeed(attributes("sub-new"));
      }),
    delete: () => Effect.void,
    list: () => Effect.die("an account-wide list"),
  } satisfies Partial<Service> as unknown as Service;
  return { service, calls };
}

const props = { name: NAME, source: SOURCE, events: ["message.bounced"], queueId: QUEUE };

function readInput(output: Subscription["Attributes"] | undefined) {
  return {
    id: "MailEventsSubscription",
    fqn: "MailEventsSubscription",
    instanceId: "i",
    olds: props,
    output,
  };
}

function reconcileInput(output: Subscription["Attributes"] | undefined) {
  return {
    ...readInput(output),
    news: props,
    olds: undefined,
    session: undefined as never,
    bindings: [],
  };
}
