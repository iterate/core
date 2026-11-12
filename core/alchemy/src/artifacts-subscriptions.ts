// artifacts-subscriptions.ts — THE CONFIG REPO'S ARTIFACTS SUBSCRIPTION: Cloudflare puts each
// push to the stack's `repos--config` on the stack's queue of Cloudflare events, and the boundary
// makes it a fact on `/repos/config` (core/boundary-worker/src/artifacts-events.ts), which
// publishes the mind. Alchemy's subscriptions do not know Artifacts as a source, so
// scripts/artifacts-subscriptions.ts runs this after a deploy and before a destroy.
//
// Cloudflare refuses a second subscription of one repo (405), to any queue. The stack's queue's
// subscriptions are read as every subscription of the stack is (./event-subscriptions.ts). Only
// after a 405 is the account read, newest first, to find the repo's subscription to another queue:
// so a stack heals after a destroy that left its subscription behind.
import { z } from "zod";
import { type Call, accountUrl } from "./cloudflare-call.ts";
import { resourceNamesOf } from "./config.ts";
import { type EventSubscriptionRow, findQueueEventSubscription } from "./event-subscriptions.ts";

/** The Artifacts name of `/repos/config` (core/mind-worker's `repoArtifactName`). */
const CONFIG_REPO = "repos--config";
/** What the stack asks Cloudflare for: pushes, and tokens made. A write token of the config
 *  repo lets its holder publish the mind with a `git push`, so its making is a fact; the boundary
 *  drops a read token's. Clones, fetches and revoked tokens are still not asked for: the mind's
 *  own git traffic makes them, and nothing follows them. The boundary has a row for each; name
 *  one here to get it, and the next deploy replaces the subscription. */
const EVENTS = ["pushed", "token.created"];
const PAGE = 100;
/** The scan after a 405 reads at most this many pages of 100, the newest first. */
const SCAN_PAGES = 100;

const Queue = z.object({ queue_id: z.string(), queue_name: z.string() });
const Subscriptions = z.object({
  result: z.array(
    z.object({
      id: z.string(),
      source: z
        .object({ type: z.string(), namespace: z.string(), repo_name: z.string() })
        .partial(),
      destination: z.object({ queue_id: z.string().optional() }).catch({}),
    }),
  ),
});

type Input = { accountId: string; name: string; call: Call };
type Outcome = { failed: boolean; lines: string[] };

/** Makes the config repo's subscription to the stack's queue when it is not there. One with the
 *  same events is left; one with other events, or one to another queue, is deleted and made
 *  again. Answers one line for what it did, or for what is missing. */
export async function ensureArtifactsSubscription(input: Input): Promise<Outcome> {
  const { call } = input;
  const names = resourceNamesOf(input.name);
  const api = `${accountUrl(input.accountId)}/event_subscriptions/subscriptions`;
  const queue = await stackQueue(input);
  if ("status" in queue)
    return refused(
      `Cloudflare answered ${queue.status} to GET the account's queues: the config repo has no subscription`,
    );
  if (!queue.found)
    return refused(
      `The account has no queue ${names.cloudflareEvents}: the config repo has no subscription`,
    );
  const queueId = queue.found.queue_id;
  const mine = await findQueueEventSubscription({
    ...input,
    queueId,
    matches: isConfigRepoOf(names.repos),
  });
  if (mine.refused) return refused(`${mine.unfound}: the config repo may have no subscription`);

  let replaced: string | null = null;
  if (mine.found) {
    if ([...mine.found.events].sort().join() === [...EVENTS].sort().join())
      return {
        failed: false,
        lines: [`Left: the config repo's subscription, to the queue ${names.cloudflareEvents}`],
      };
    const gone = await deleted(call, api, mine.found.id);
    if (gone) return gone;
    replaced = `Replaced: the config repo's subscription ${mine.found.id}, which had other events`;
  }

  const subscription = `${names.cloudflareEvents}-config-repo`;
  const create = () =>
    call("POST", api, {
      name: subscription,
      enabled: true,
      source: { type: "artifacts.repo", namespace: names.repos, repo_name: CONFIG_REPO },
      events: EVENTS,
      destination: { type: "queues.queue", queue_id: queueId },
    });
  let made = await create();
  if (made.status === 405) {
    const elsewhere = await scanned(input, api, names.repos);
    if ("line" in elsewhere)
      return refused(
        `Cloudflare answered 405 to POST the subscription ${subscription}: the repo ${CONFIG_REPO} of ${names.repos} has a subscription on another queue, and ${elsewhere.line}. Delete that subscription by hand (\`wrangler queues subscription delete\`, or DELETE ${api}/<id>), then deploy again`,
      );
    const gone = await deleted(call, api, elsewhere.found.id);
    if (gone) return gone;
    replaced = `Replaced: the config repo's subscription ${elsewhere.found.id}, on another queue (${elsewhere.found.destination.queue_id}). The stack may not have made it.`;
    made = await create();
  }
  if (made.status !== 200)
    return refused(
      `Cloudflare answered ${made.status} to POST the subscription ${subscription}: it was not made (${JSON.stringify(made.body).slice(0, 300)})`,
    );
  return {
    failed: false,
    lines: [
      replaced ||
        `Made: the subscription ${subscription} of the repo ${CONFIG_REPO} to the queue ${names.cloudflareEvents}`,
    ],
  };
}

/** Deletes the config repo's subscription to the stack's queue, found by its repo: a queue that
 *  still has a subscription may refuse its delete. A subscription that answers 404 is gone
 *  already; with no queue, no subscription of this stack can be there. */
export async function removeArtifactsSubscription(input: Input): Promise<Outcome> {
  const names = resourceNamesOf(input.name);
  const queue = await stackQueue(input);
  if ("status" in queue)
    return refused(
      `Cloudflare answered ${queue.status} to GET the account's queues: the config repo's subscription may be left`,
    );
  if (!queue.found)
    return {
      failed: false,
      lines: [`The account has no queue ${names.cloudflareEvents}: no subscription to remove`],
    };
  const mine = await findQueueEventSubscription({
    ...input,
    queueId: queue.found.queue_id,
    matches: isConfigRepoOf(names.repos),
  });
  if (mine.refused) return refused(`${mine.unfound}: the config repo's subscription may be left`);
  if (!mine.found) return { failed: false, lines: [] };
  const gone = await input.call(
    "DELETE",
    `${accountUrl(input.accountId)}/event_subscriptions/subscriptions/${mine.found.id}`,
  );
  if (gone.status === 200 || gone.status === 404)
    return { failed: false, lines: [`Removed: the config repo's subscription ${mine.found.id}`] };
  return refused(
    `NOT removed: the config repo's subscription ${mine.found.id} (Cloudflare answered ${gone.status})`,
  );
}

const isConfigRepoOf =
  (namespace: string) =>
  ({ source }: Pick<EventSubscriptionRow, "source">) =>
    source.type === "artifacts.repo" &&
    source.namespace === namespace &&
    source.repo_name === CONFIG_REPO;

/** The config repo's subscription on any queue, in the account's newest `SCAN_PAGES` pages; else
 *  a line that says why it was not found. */
async function scanned(input: Input, api: string, namespace: string) {
  const matches = isConfigRepoOf(namespace);
  for (let page = 1; page <= SCAN_PAGES; page += 1) {
    const answer = await input.call(
      "GET",
      `${api}?order=created_at&direction=desc&per_page=${PAGE}&page=${page}`,
    );
    if (answer.status !== 200)
      return { line: `Cloudflare answered ${answer.status} to page ${page} of the account's list` };
    const rows = Subscriptions.safeParse(answer.body);
    const result = rows.success ? rows.data.result : [];
    const found = result.find(matches);
    if (found) return { found };
    if (result.length < PAGE) return { line: `the account's list does not hold it` };
  }
  return { line: `the newest ${SCAN_PAGES} pages of the account's list do not hold it` };
}

async function stackQueue(input: Input) {
  const name = resourceNamesOf(input.name).cloudflareEvents;
  const url = `${accountUrl(input.accountId)}/queues`;
  for (let page = 1; ; page += 1) {
    const answer = await input.call("GET", `${url}?per_page=${PAGE}&page=${page}`);
    if (answer.status !== 200) return { status: answer.status };
    const queues = z.object({ result: z.array(z.unknown()) }).safeParse(answer.body);
    const entries = queues.success ? queues.data.result : [];
    const found = entries.flatMap((entry) => {
      const parsed = Queue.safeParse(entry);
      return parsed.success && parsed.data.queue_name === name ? [parsed.data] : [];
    })[0];
    if (found || entries.length < PAGE) return { found };
  }
}

/** A failed outcome when Cloudflare refuses the delete; 404 is gone already. */
async function deleted(call: Call, api: string, id: string): Promise<Outcome | null> {
  const gone = await call("DELETE", `${api}/${id}`);
  if (gone.status === 200 || gone.status === 404) return null;
  return refused(
    `Cloudflare answered ${gone.status} to DELETE the config repo's subscription ${id}, which is not as the stack needs it: it was not made again`,
  );
}

const refused = (line: string): Outcome => ({ failed: true, lines: [line] });
