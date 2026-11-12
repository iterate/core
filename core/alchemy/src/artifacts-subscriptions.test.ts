// The config repo's Artifacts subscription (artifacts-subscriptions.ts), against a pretend Cloudflare.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ensureArtifactsSubscription,
  removeArtifactsSubscription,
} from "./artifacts-subscriptions.ts";
import type { Call } from "./cloudflare-call.ts";

const ACCOUNT = "a".repeat(32);
const EVENTS = ["pushed", "token.created"];
const SOURCE = {
  type: "artifacts.repo",
  namespace: "iterate-one-repos",
  repo_name: "repos--config",
};
const SUBSCRIPTIONS = `/client/v4/accounts/${ACCOUNT}/event_subscriptions/subscriptions`;
const ORDER = "order=created_at&direction=desc&per_page=100";
// the stack's queue's subscriptions (event-subscriptions.ts), and a page of the account's
const OF_QUEUE = `GET ${SUBSCRIPTIONS}?${ORDER}&page=1&queue_id=queue-1`;
const scanned = (page: number) => `GET ${SUBSCRIPTIONS}?${ORDER}&page=${page}`;
const input = (call: Call, name = "one") => ({ accountId: ACCOUNT, name, call });

void test("a deploy lists the stack's queue's subscriptions alone, and makes the config repo's when it is not there", async () => {
  const cloudflare = pretendCloudflare([]);
  const { failed, lines } = await ensureArtifactsSubscription(input(cloudflare.call));
  assert.equal(failed, false);
  assert.deepEqual(lines, [
    "Made: the subscription iterate-one-events-config-repo of the repo repos--config to the queue iterate-one-events",
  ]);
  assert.deepEqual(cloudflare.calls, [
    `GET /client/v4/accounts/${ACCOUNT}/queues?per_page=100&page=1`,
    OF_QUEUE,
    `POST ${SUBSCRIPTIONS}`,
  ]);
  assert.deepEqual(cloudflare.posted, [
    {
      name: "iterate-one-events-config-repo",
      enabled: true,
      source: SOURCE,
      events: EVENTS,
      destination: { type: "queues.queue", queue_id: "queue-1" },
    },
  ]);
  // a second deploy finds it and leaves it
  cloudflare.calls.length = 0;
  assert.deepEqual(await ensureArtifactsSubscription(input(cloudflare.call)), {
    failed: false,
    lines: ["Left: the config repo's subscription, to the queue iterate-one-events"],
  });
  assert.deepEqual(cloudflare.calls, [
    `GET /client/v4/accounts/${ACCOUNT}/queues?per_page=100&page=1`,
    OF_QUEUE,
  ]);
});

void test("the config repo's subscription with other events is deleted and made again", async () => {
  const cloudflare = pretendCloudflare([
    { id: "old", queue: "queue-1", events: ["pushed", "cloned"] },
  ]);
  const { failed, lines } = await ensureArtifactsSubscription(input(cloudflare.call));
  assert.equal(failed, false);
  assert.deepEqual(lines, ["Replaced: the config repo's subscription old, which had other events"]);
  assert.deepEqual(cloudflare.calls.slice(2), [
    `DELETE ${SUBSCRIPTIONS}/old`,
    `POST ${SUBSCRIPTIONS}`,
  ]);
});

void test("a 405 means the repo is subscribed to another queue: only then the account is read, page by page", async () => {
  // a full first page of other stacks', then the config repo's to an old queue
  const others = Array.from({ length: 100 }, (_, at) => ({
    id: `other-${at}`,
    queue: "queue-other",
    events: EVENTS,
    source: { ...SOURCE, namespace: `iterate-other${at}-repos` },
  }));
  const cloudflare = pretendCloudflare([
    ...others,
    { id: "stale", queue: "queue-old", events: EVENTS },
  ]);
  const { failed, lines } = await ensureArtifactsSubscription(input(cloudflare.call));
  assert.equal(failed, false);
  assert.deepEqual(lines, [
    "Replaced: the config repo's subscription stale, on another queue (queue-old). The stack may not have made it.",
  ]);
  assert.deepEqual(cloudflare.calls.slice(2), [
    `POST ${SUBSCRIPTIONS}`,
    scanned(1),
    scanned(2),
    `DELETE ${SUBSCRIPTIONS}/stale`,
    `POST ${SUBSCRIPTIONS}`,
  ]);
});

void test("a scan that reaches its last page without the repo's subscription fails, and says what to do by hand", async () => {
  const others = Array.from({ length: 100 * 100 }, (_, at) => ({
    id: `other-${at}`,
    queue: "queue-other",
    events: EVENTS,
    source: { ...SOURCE, namespace: `iterate-other${at}-repos` },
  }));
  // the config repo's, older than the newest 100 pages
  const cloudflare = pretendCloudflare([
    ...others,
    { id: "old", queue: "queue-old", events: EVENTS },
  ]);
  const { failed, lines } = await ensureArtifactsSubscription(input(cloudflare.call));
  assert.equal(failed, true);
  assert.match(lines[0]!, /newest 100 pages .* do not hold it/);
  assert.match(lines[0]!, /wrangler queues subscription delete/);
  assert.equal(cloudflare.calls.at(-1), scanned(100));
});

void test("a refusal fails the step with a line that says what is missing", async () => {
  for (const refuse of ["queues", "list", "create"] as const) {
    const { failed, lines } = await ensureArtifactsSubscription(
      input(pretendCloudflare([], refuse).call),
    );
    assert.equal(failed, true, refuse);
    assert.match(lines.join(" "), /answered 403/, refuse);
    assert.match(lines.join(" "), /no subscription|not made/, refuse);
  }
  const { failed, lines } = await ensureArtifactsSubscription(
    input(pretendCloudflare([]).call, "two"),
  );
  assert.equal(failed, true);
  assert.deepEqual(lines, [
    "The account has no queue iterate-two-events: the config repo has no subscription",
  ]);
});

void test("a destroy removes the config repo's subscription from the stack's queue; a 404 is gone, and no queue is nothing to remove", async () => {
  const cloudflare = pretendCloudflare([
    { id: "named-otherwise", queue: "queue-1", events: EVENTS },
  ]);
  assert.deepEqual(await removeArtifactsSubscription(input(cloudflare.call)), {
    failed: false,
    lines: ["Removed: the config repo's subscription named-otherwise"],
  });
  const gone = pretendCloudflare([{ id: "gone", queue: "queue-1", events: EVENTS }], "delete-404");
  assert.deepEqual(await removeArtifactsSubscription(input(gone.call)), {
    failed: false,
    lines: ["Removed: the config repo's subscription gone"],
  });
  assert.deepEqual(await removeArtifactsSubscription(input(gone.call, "two")), {
    failed: false,
    lines: ["The account has no queue iterate-two-events: no subscription to remove"],
  });
});

void test("`pnpm run deploy` makes the subscription after the stack, and `destroy` removes it before Alchemy's destroy", () => {
  // The cast: this package's own package.json, which has the scripts.
  const { scripts } = JSON.parse(
    readFileSync(`${import.meta.dirname}/../package.json`, "utf8"),
  ) as { scripts: { deploy: string; destroy: string } };
  assert.ok(
    scripts.deploy.indexOf("deploy-stack.ts") <
      scripts.deploy.indexOf("artifacts-subscriptions.ts"),
    scripts.deploy,
  );
  const removed = scripts.destroy.indexOf("artifacts-subscriptions.ts --remove");
  assert.ok(removed >= 0 && removed < scripts.destroy.indexOf("cli.js destroy"), scripts.destroy);
});

/** An account as Cloudflare answers for it: the queue `iterate-one-events` (`queue-1`)
 *  and the subscriptions given (the config repo's unless `source` says otherwise), listed 100 to
 *  a page and filtered by `queue_id` alone. A second subscription of one source answers 405.
 *  `refuse` names the call that answers 403, or a delete that answers 404. */
function pretendCloudflare(
  held: { id: string; queue: string; events: string[]; source?: object }[],
  refuse?: "queues" | "list" | "create" | "delete-404",
) {
  const subscriptions = held.map(({ id, queue, events, source = SOURCE }) => ({
    id,
    source,
    destination: { type: "queues.queue", queue_id: queue },
    events,
  }));
  const calls: string[] = [];
  const posted: unknown[] = [];
  const answer = (status: number, body: unknown = null) => ({ status, body });
  const call: Call = async (method, url, body) => {
    const { pathname, search, searchParams } = new URL(url);
    calls.push(`${method} ${pathname}${search}`);
    const page = Number(searchParams.get("page"));
    const paged = (all: unknown[]) => all.slice((page - 1) * 100, page * 100);
    if (pathname.endsWith("/queues")) {
      if (refuse === "queues") return answer(403);
      return answer(200, {
        result: paged([{ queue_id: "queue-1", queue_name: "iterate-one-events" }]),
      });
    }
    if (method === "GET") {
      if (refuse === "list") return answer(403);
      const queue = searchParams.get("queue_id");
      return answer(200, {
        result: paged(
          subscriptions.filter((each) => !queue || each.destination.queue_id === queue),
        ),
      });
    }
    if (method === "POST") {
      if (refuse === "create") return answer(403, { errors: [{ message: "Forbidden" }] });
      // The cast: the request body this module sends, as the list answers it with an id.
      const made = {
        ...(body as Omit<(typeof subscriptions)[number], "id">),
        id: `made-${posted.length}`,
      };
      if (subscriptions.some((each) => JSON.stringify(each.source) === JSON.stringify(made.source)))
        return answer(405, {
          errors: [
            { message: "We currently do not support multiple subscriptions on the same resource." },
          ],
        });
      posted.push(body);
      subscriptions.push(made);
      return answer(200, { result: made });
    }
    const id = pathname.split("/").pop();
    if (refuse === "delete-404") return answer(404);
    subscriptions.splice(
      subscriptions.findIndex((each) => each.id === id),
      1,
    );
    return answer(200, { result: { id } });
  };
  return { call, calls, posted };
}
