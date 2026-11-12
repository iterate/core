import { expect, test, vi } from "vitest";
import { artifactsRows, repoPathOf } from "./artifacts-events.ts";
import { cloudflareEvents } from "./cloudflare-events.ts";

const NAMESPACE = "iterate-one-repos";
const rows = artifactsRows({ namespace: NAMESPACE });
const BEFORE = "b".repeat(40);
const AFTER = "a".repeat(40);

test("a push to main becomes `repo/pushed` on the repo's own context, keyed by the message", () => {
  expect(made(pushedToMain())).toEqual({
    path: "/repos/config",
    event: {
      type: "events.iterate.com/repo/pushed",
      idempotencyKey: `repo/pushed:${NAMESPACE}/repos--config:2026-11-12T22:02:54.449Z:refs/heads/main:${AFTER}`,
      payload: {
        ref: "refs/heads/main",
        before: BEFORE,
        after: AFTER,
        commits: [
          {
            id: AFTER,
            message: "probe: one line, to see Cloudflare's pushed event",
            timestamp: "2026-11-12T22:02:53.000Z",
            author: { name: "probe", email: "probe@example.com" },
            committer: { name: "probe", email: "probe@example.com" },
            parents: [BEFORE],
          },
        ],
        totalCommitsCount: 1,
        commitsTruncated: false,
        forced: false,
      },
    },
  });
});

test("a force push of main says so and names the commit it left behind, so it can be pushed back", () => {
  // Cloudflare's own message for a force push of main back to an older commit (12 November 2026):
  // its commits are the new tip's history, and `before` is no parent of any of them
  const body = pushedToMain();
  const OLDER = "c".repeat(40);
  body.payload.after = OLDER;
  body.payload.commits = [commit(OLDER, ["d".repeat(40)], "an older commit")];
  expect(made(body)?.event.payload).toMatchObject({
    after: OLDER,
    forced: true,
    leftBehind: BEFORE,
  });
});

test("a push whose commits are cut, with `before` not among them, cannot say whether it was forced", () => {
  const body = pushedToMain();
  body.payload.commits = [commit(AFTER, ["d".repeat(40)], "the newest of many")];
  body.payload.commitsTruncated = true;
  expect(made(body)?.event.payload).toMatchObject({ forced: null });
  expect(made(body)?.event.payload).not.toHaveProperty("leftBehind");
});

test("a new branch and a delete are not force pushes", () => {
  expect(made(pushedNewBranch())?.event.payload).toMatchObject({ forced: false });
  const deleted = pushedToMain();
  deleted.payload.after = "0".repeat(40);
  deleted.payload.commits = [];
  expect(made(deleted)?.event.payload).toMatchObject({ forced: false });
});

test("a push of a new branch keeps each commit, and a truncated message says so", () => {
  const body = pushedNewBranch();
  body.payload.commits[1]!.messageTruncated = true;
  const event = made(body)!.event;
  expect(event).toMatchObject({
    idempotencyKey: `repo/pushed:${NAMESPACE}/repos--config:2026-11-12T22:02:55.382Z:refs/heads/probe-branch:${AFTER}`,
    payload: { ref: "refs/heads/probe-branch", before: "0".repeat(40), totalCommitsCount: 3 },
  });
  const commits = (event.payload as { commits: Record<string, unknown>[] }).commits;
  expect(commits.map((commit) => commit.messageTruncated)).toEqual([undefined, true, undefined]);
});

test("a push of more than 50 commits keeps the first 50 and Cloudflare's count", () => {
  const body = pushedToMain();
  body.payload.commits = Array.from({ length: 60 }, (_, at) => ({
    ...body.payload.commits[0]!,
    id: String(at).padStart(40, "0"),
  }));
  body.payload.totalCommitsCount = 60;
  expect(made(body)?.event.payload).toMatchObject({
    commits: expect.toSatisfy((commits: unknown[]) => commits.length === 50),
    totalCommitsCount: 60,
    commitsTruncated: true,
  });
});

test.for([
  ["cf.artifacts.repo.cloned", "events.iterate.com/repo/cloned", {}, {}],
  ["cf.artifacts.repo.fetched", "events.iterate.com/repo/fetched", {}, {}],
  [
    "cf.artifacts.repo.token.created",
    "events.iterate.com/repo/token-created",
    { tokenId: "token-1", scope: "write", expiresAt: "2026-11-12T22:17:42.653Z" },
    { tokenId: "token-1", scope: "write", expiresAt: "2026-11-12T22:17:42.653Z" },
  ],
  [
    "cf.artifacts.repo.token.revoked",
    "events.iterate.com/repo/token-revoked",
    { tokenId: "token-1" },
    { tokenId: "token-1" },
  ],
] as const)("%s becomes %s on the repo's own context", ([type, ours, payload, expected]) => {
  expect(made(message(type, payload))).toEqual({
    path: "/repos/config",
    event: {
      type: ours,
      idempotencyKey: `${ours.slice("events.iterate.com/".length)}:${NAMESPACE}/repos--config:2026-11-12T22:02:42.874Z`,
      payload: expected,
    },
  });
});

test.for([
  ["a read token", { tokenId: "token-1", scope: "read", expiresAt: "2026-11-12T22:17:42.653Z" }],
  ["a token with no scope", { tokenId: "token-1", expiresAt: "2026-11-12T22:17:42.653Z" }],
  ["a token of another scope", { tokenId: "token-1", scope: "admin" }],
] as const)("%s makes nothing: only a write token is a right to publish", ([, payload]) => {
  expect(made(message("cf.artifacts.repo.token.created", payload))).toBeNull();
});

test("a redelivered message gives the same key: the mind appends it once", () => {
  for (const body of [pushedToMain(), tokenCreated(), message("cf.artifacts.repo.cloned", {})])
    expect(made(body)).toEqual(made(structuredClone(body)));
});

test("with no event time, a push is keyed by its ref and oids and a token event by its token; a clone or fetch makes nothing", () => {
  const push = withoutTimestamp(pushedToMain());
  expect(made(push)?.event.idempotencyKey).toBe(
    `repo/pushed:${NAMESPACE}/repos--config:refs/heads/main:${BEFORE}:${AFTER}`,
  );
  expect(made(withoutTimestamp(tokenCreated()))?.event.idempotencyKey).toBe(
    `repo/token-created:${NAMESPACE}/repos--config:token-1`,
  );
  expect(made(withoutTimestamp(message("cf.artifacts.repo.cloned", {})))).toBeNull();
  expect(made(withoutTimestamp(message("cf.artifacts.repo.fetched", {})))).toBeNull();
});

test("a repo of another namespace is not this mind's: it makes nothing", () => {
  const body = pushedToMain();
  body.source.namespace = "iterate-other-repos";
  expect(made(body)).toBeNull();
});

test.for([
  ["nothing", undefined],
  ["a string", "cf.artifacts.repo.pushed"],
  ["no source", { type: "cf.artifacts.repo.pushed", payload: {} }],
  ["a source with no repo name", { ...tokenCreated(), source: { namespace: NAMESPACE } }],
  [
    "an account's event, which has no row",
    { ...tokenCreated(), type: "cf.artifacts.repo.created" },
  ],
  ["a repo name no path maps to", { ...tokenCreated(), source: repo("repos---config") }],
  ["a repo name that starts with a dot", { ...tokenCreated(), source: repo(".git--config") }],
] as const)(
  "a body the boundary does not understand (%s) makes nothing and does not throw",
  ([, body]) => {
    expect(made(body)).toBeNull();
  },
);

test("a repo's path is its Artifacts name with each `--` read as `/`", () => {
  expect(repoPathOf("repos--config")).toBe("/repos/config");
  expect(repoPathOf("repos--a.b--c-d")).toBe("/repos/a.b/c-d");
  for (const name of ["", "--config", "repos--", "repos----config", "repos---config", "re/pos"])
    expect(repoPathOf(name)).toBeNull();
});

test("the queue handler sends a push to the repo's context and acks it", async () => {
  const did: string[] = [];
  const appended: string[] = [];
  const batch = {
    queue: "cloudflare-events",
    messages: [
      {
        id: "a",
        body: pushedToMain(),
        attempts: 1,
        ack: () => did.push("a acked"),
        retry: () => did.push("a retried"),
      },
    ],
  } as unknown as MessageBatch;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await cloudflareEvents(batch, { append: async (path) => void appended.push(path) }, rows);
  expect({ did, appended }).toEqual({ did: ["a acked"], appended: ["/repos/config"] });
});

/** What the table makes of one message, as the queue handler looks it up. */
function made(body: unknown) {
  const type = String((body as { type?: unknown } | null)?.type);
  return Object.hasOwn(rows, type) ? rows[type]!(body) : null;
}

function repo(repoName: string) {
  return { type: "artifacts.repo", namespace: NAMESPACE, repoName };
}

function withoutTimestamp<Body extends { metadata: object }>(body: Body): Body {
  return { ...body, metadata: { eventSchemaVersion: 1 } };
}

// The bodies below are messages that Cloudflare put on a stack's queue on 12 November 2026, with
// the namespace, the ids, the oids and the people replaced by neutral ones.

function message<Payload>(
  type: string,
  payload: Payload,
  eventTimestamp = "2026-11-12T22:02:42.874Z",
) {
  return {
    type,
    source: repo("repos--config"),
    metadata: {
      accountId: "0".repeat(32),
      eventSubscriptionId: "0".repeat(32),
      eventSchemaVersion: 1,
      eventTimestamp,
    },
    payload,
  };
}

function tokenCreated() {
  return message("cf.artifacts.repo.token.created", {
    tokenId: "token-1",
    scope: "write",
    expiresAt: "2026-11-12T22:17:42.653Z",
  });
}

function commit(id: string, parents: string[], message: string) {
  return {
    id,
    message,
    messageTruncated: false,
    timestamp: "2026-11-12T22:02:53.000Z",
    author: { name: "probe", email: "probe@example.com" },
    committer: { name: "probe", email: "probe@example.com" },
    parents,
  };
}

function pushedToMain() {
  return message(
    "cf.artifacts.repo.pushed",
    {
      ref: "refs/heads/main",
      before: BEFORE,
      after: AFTER,
      commits: [commit(AFTER, [BEFORE], "probe: one line, to see Cloudflare's pushed event")],
      totalCommitsCount: 1,
      commitsTruncated: false,
    },
    "2026-11-12T22:02:54.449Z",
  );
}

function pushedNewBranch() {
  return message(
    "cf.artifacts.repo.pushed",
    {
      ref: "refs/heads/probe-branch",
      before: "0".repeat(40),
      after: AFTER,
      commits: [
        commit(AFTER, [BEFORE], "probe: one line, to see Cloudflare's pushed event"),
        commit(BEFORE, ["c".repeat(40)], "smoke: remove the file"),
        commit("c".repeat(40), [], "seed: core/configs/default"),
      ],
      totalCommitsCount: 3,
      commitsTruncated: false,
    },
    "2026-11-12T22:02:55.382Z",
  );
}
