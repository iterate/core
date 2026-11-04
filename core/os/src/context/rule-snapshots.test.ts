// context/rule-snapshots.test.ts — the rule snapshot cache and which commits wait out older
// snapshots; the same across real contexts is test/vitest/os-workers/rule-snapshots.test.ts.
import { expect, test, vi } from "vitest";
import { parseItxExpressionPrefix, print } from "iterate/expression";
import { codedError, withTimeout } from "iterate/lib";
import {
  implicitRootsAt,
  namesTakenAway,
  rulesChangeNeedsCommitWait,
  type ItxExpressionRewriteRule,
} from "./itx-expression-rewriting.ts";
import {
  MAX_HELD_SNAPSHOTS,
  RuleSnapshotCache,
  SNAPSHOT_TTL_MS,
  UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS,
  type RulesSnapshotAnswer,
} from "./rule-snapshots.ts";
import { rule } from "./test-support.ts";

test("a snapshot serves until SNAPSHOT_TTL_MS after its read, then is re-read by version: same keeps its rows, new brings its own", async () => {
  const { cache, clock, owner } = setup();
  owner.rules = [rule("itx.tool ⇒ itx.kv")];
  expect(await cache.get("/", owner.read)).toMatchObject({
    rules: owner.rules,
    expiresAt: SNAPSHOT_TTL_MS,
  });
  clock.now = SNAPSHOT_TTL_MS / 2 - 1; // past half its lifetime it is read behind (below)
  await cache.get("/", owner.read);
  clock.now = SNAPSHOT_TTL_MS;
  expect(await cache.get("/", owner.read)).toMatchObject({
    rules: [rule("itx.tool ⇒ itx.kv")],
    expiresAt: 2 * SNAPSHOT_TTL_MS,
  });
  owner.version = "v2";
  owner.rules = [rule("itx.tool ⇒ itx.r2")];
  clock.now = 2 * SNAPSHOT_TTL_MS;
  expect(await cache.get("/", owner.read)).toMatchObject({ rules: [rule("itx.tool ⇒ itx.r2")] });
  expect(owner).toMatchObject({ reads: [undefined, "v1", "v1"] });
});

test("a busy owner delays no call while the held snapshot lasts: past half its lifetime a call is answered from it at once, and one read behind it, kept alive, replaces it", async () => {
  const { cache, clock, owner } = setup();
  const keptAlive: Promise<unknown>[] = [];
  const keepAlive = (reading: Promise<unknown>) => keptAlive.push(reading);
  await cache.get("/", owner.read, keepAlive);
  owner.delayed = true; // from here the owner answers only on `answer()`, a second later
  const at = (now: number) => {
    clock.now = now;
    return withTimeout(cache.get("/", owner.read, keepAlive), 100, `the call at ${now} ms`);
  };
  const sentAt = SNAPSHOT_TTL_MS / 2 + 500;
  expect(await at(sentAt)).toMatchObject({ readAt: 0, expiresAt: SNAPSHOT_TTL_MS });
  expect(await at(sentAt + 500)).toMatchObject({ readAt: 0 }); // the one read out, shared
  expect(owner).toMatchObject({ reads: [undefined, "v1"] });
  expect(keptAlive).toHaveLength(1);
  clock.now = sentAt + 1_000;
  owner.answer();
  await keptAlive[0];
  // the first snapshot has expired; the one read behind it lasts from when it was sent
  expect(await at(SNAPSHOT_TTL_MS + 1)).toMatchObject({
    readAt: sentAt,
    expiresAt: sentAt + SNAPSHOT_TTL_MS,
  });
  expect(owner).toMatchObject({ reads: [undefined, "v1"] });
});

test("a read behind the held snapshot that fails costs no call and is made once: the snapshot serves out its lifetime, then the next call reads again", async () => {
  const { cache, clock, owner } = setup();
  vi.spyOn(console, "error").mockImplementation(() => {}); // the issue (below)
  await cache.get("/", owner.read);
  owner.fail = true;
  const kept: Promise<unknown>[] = [];
  for (let call = 0; call < 100; call++) {
    clock.now = SNAPSHOT_TTL_MS / 2 + call * 20;
    expect(await cache.get("/", owner.read, (reading) => kept.push(reading))).toMatchObject({
      readAt: 0,
    });
    await Promise.all(kept); // caught: no unhandled rejection, and no read out
  }
  expect(kept).toHaveLength(1);
  owner.fail = false;
  clock.now = SNAPSHOT_TTL_MS;
  expect(await cache.get("/", owner.read)).toMatchObject({ readAt: SNAPSHOT_TTL_MS });
  expect(owner).toMatchObject({ reads: [undefined, "v1", "v1"] });
});

test("a read behind the held snapshot that never answers is given up when its lifetime is over, as a call's is, and kept alive no longer: the next call reads again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { cache, clock, owner } = setup();
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cache.get("/", owner.read);
    owner.delayed = true; // never answered: the request that sent it is gone
    const sentAt = SNAPSHOT_TTL_MS / 2;
    clock.now = sentAt;
    let keptAlive = false;
    await cache.get("/", owner.read, (reading) => void reading.then(() => (keptAlive = true)));
    clock.now = sentAt + SNAPSHOT_TTL_MS;
    await vi.advanceTimersByTimeAsync(SNAPSHOT_TTL_MS);
    expect(keptAlive).toBe(true);
    expect(warns.mock.calls.map(([line]) => line)).toMatchObject([
      { event: "rule-snapshot.platform-failure-read-deadline", context: "/" },
    ]);
    owner.delayed = false;
    expect(await cache.get("/", owner.read)).toMatchObject({ readAt: sentAt + SNAPSHOT_TTL_MS });
    expect(owner).toMatchObject({ reads: [undefined, "v1", "v1"] });
  } finally {
    vi.useRealTimers();
  }
});

test.for([
  {
    failure: "an unexpected failure, an issue",
    error: new Error("owner down"),
    logged: { error: [{ event: "issue", failureSite: "rule-snapshot.read-behind", context: "/" }] },
  },
  {
    failure: "a refusal, at info",
    error: codedError("FORBIDDEN", "project prj_unit was deleted"),
    logged: { info: [{ event: "rule-snapshot.read-behind-refused", code: "FORBIDDEN" }] },
  },
  {
    failure: "a platform failure, by its retry alone",
    error: Object.assign(new Error("connection lost"), { retryable: true }),
    logged: {
      warn: [
        { event: "rule-snapshot.platform-failure-retry", kind: "disconnected" },
        { event: "rule-snapshot.platform-failure-gave-up", kind: "disconnected" },
      ],
    },
  },
])(
  "a read behind the held snapshot is logged, though no call waits on it: $failure",
  async ({ error, logged }) => {
    const { cache, clock, owner } = setup();
    const lines: Record<string, unknown[]> = { error: [], warn: [], info: [] };
    for (const level of ["error", "warn", "info"] as const)
      vi.spyOn(console, level).mockImplementation((line) => void lines[level]!.push(line));
    await cache.get("/", owner.read);
    owner.failWith = error;
    clock.now = SNAPSHOT_TTL_MS / 2;
    const kept: Promise<unknown>[] = [];
    expect(await cache.get("/", owner.read, (reading) => kept.push(reading))).toMatchObject({
      readAt: 0,
    });
    await Promise.all(kept);
    expect(lines).toMatchObject({ error: [], warn: [], info: [], ...logged });
  },
);

test("a read behind the held snapshot is used only within its own lifetime: one that answers as that ends is read again", async () => {
  const { cache, clock, owner } = setup();
  await cache.get("/", owner.read);
  owner.delayed = true;
  clock.now = SNAPSHOT_TTL_MS / 2;
  await cache.get("/", owner.read); // the read behind it, sent at TTL/2
  clock.now = SNAPSHOT_TTL_MS + SNAPSHOT_TTL_MS / 2; // it answers just as its own lifetime ends
  const next = cache.get("/", owner.read);
  owner.answer();
  await vi.waitFor(() => expect(owner.reads).toHaveLength(3));
  owner.answer();
  expect(await next).toMatchObject({ readAt: SNAPSHOT_TTL_MS + SNAPSHOT_TTL_MS / 2 });
});

test("a snapshot lasts the lifetime its owner answers, from its read: an unpublished root's is read again after UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS, by version", async () => {
  const { cache, clock, owner } = setup();
  owner.rules = [rule("itx.tool ⇒ itx.kv")];
  owner.ttlMs = UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS;
  expect(await cache.get("/", owner.read)).toMatchObject({
    readAt: 0,
    expiresAt: UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS,
  });
  clock.now = UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS;
  owner.ttlMs = undefined;
  expect(await cache.get("/", owner.read)).toMatchObject({
    rules: [rule("itx.tool ⇒ itx.kv")],
    readAt: UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS,
    expiresAt: UNPUBLISHED_ROOT_SNAPSHOT_TTL_MS + SNAPSHOT_TTL_MS,
  });
  expect(owner).toMatchObject({ reads: [undefined, "v1"] });
});

test("reads are single-flight per owner: concurrent resolutions share one read", async () => {
  const { cache, owner } = setup();
  await Promise.all([
    cache.get("/", owner.read),
    cache.get("/", owner.read),
    cache.get("/other", owner.read),
  ]);
  expect(owner).toMatchObject({ reads: [undefined, undefined] });
});

test("a read that answers after its snapshot's lifetime is never used, by the call that sent it or one that joined it: both read again", async () => {
  const { cache, clock, owner } = setup();
  owner.delayed = true;
  const sender = cache.get("/", owner.read);
  clock.now = SNAPSHOT_TTL_MS + 1;
  const joiner = cache.get("/", owner.read);
  owner.answer(); // the first read, sent at 0, answers at 5001
  await vi.waitFor(() => expect(owner.reads).toHaveLength(2));
  owner.answer(); // the second, sent at 5001
  expect(await Promise.all([sender, joiner])).toMatchObject([
    { expiresAt: 2 * SNAPSHOT_TTL_MS + 1 },
    { expiresAt: 2 * SNAPSHOT_TTL_MS + 1 },
  ]);
  expect(owner).toMatchObject({ reads: [undefined, "v1"] });
});

test("a read that never answers holds the calls that joined it only for its lifetime, then the table is read again", async () => {
  const { cache, clock, owner } = setup();
  const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
  owner.delayed = true;
  // Never answered: the request that sent it is gone
  // (test/vitest/os-workers/rule-snapshot-cut-off.test.ts).
  void cache.get("/", owner.read);
  owner.delayed = false;
  clock.now = SNAPSHOT_TTL_MS - 10;
  expect(await withTimeout(cache.get("/", owner.read), 1_000, "the next read")).toMatchObject({
    expiresAt: 2 * SNAPSHOT_TTL_MS - 10,
  });
  expect(owner).toMatchObject({ reads: [undefined, undefined] });
  expect(warns.mock.calls.map(([line]) => line)).toMatchObject([
    { event: "rule-snapshot.platform-failure-read-deadline", context: "/" },
  ]);
});

test("an owner whose snapshots keep arriving expired is UNAVAILABLE after three reads, never answered from them", async () => {
  const { cache, clock, owner } = setup();
  owner.onRead = () => (clock.now += SNAPSHOT_TTL_MS);
  await expect(cache.get("/", owner.read)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(owner.reads).toHaveLength(3);
});

test("the cache keeps at most its cap of contexts, the oldest read out first: an evicted context is read again, unconditionally", async () => {
  const { cache, owner } = setup();
  for (let n = 0; n <= MAX_HELD_SNAPSHOTS; n++) await cache.get(`/${n}`, owner.read);
  await cache.get("/1", owner.read); // still held
  await cache.get("/0", owner.read); // evicted by the last
  expect(owner).toMatchObject({ reads: Array(MAX_HELD_SNAPSHOTS + 2).fill(undefined) });
});

test("a read that fails is not kept: the next resolution reads again", async () => {
  const { cache, owner } = setup();
  owner.fail = true;
  await expect(cache.get("/", owner.read)).rejects.toThrow("owner down");
  owner.fail = false;
  expect(await cache.get("/", owner.read)).toMatchObject({ rules: [] });
  expect(owner).toMatchObject({ reads: [undefined, undefined] });
});

test("a read a deploy's reset fails is retried once at once and logged; failed twice it is UNAVAILABLE, kind deploy-reset", async () => {
  const { cache, clock, owner } = setup();
  const lines = vi.spyOn(console, "info").mockImplementation(() => {});
  owner.resets = 1;
  owner.onRead = () => (clock.now += 100);
  expect(await cache.get("/", owner.read)).toMatchObject({ expiresAt: SNAPSHOT_TTL_MS });
  expect(lines.mock.calls.map(([line]) => line.event)).toEqual([
    "rule-snapshot.deploy-reset-retry",
  ]);
  owner.resets = 2;
  await expect(cache.get("/other", owner.read)).rejects.toMatchObject({
    code: "UNAVAILABLE",
    data: { kind: "deploy-reset" },
  });
  expect(owner.reads).toHaveLength(4);
});

test.for([
  { name: "a new name answers at once", before: [], after: ["itx.tool ⇒ itx.kv"], waits: false },
  {
    name: "a description alone answers at once",
    before: ["itx.tool ⇒ itx.kv"],
    after: ["itx.tool ⇒ itx.kv — the store"],
    waits: false,
  },
  {
    name: "a grant re-pointed waits",
    before: ["itx.tool ⇒ itx.kv"],
    after: ["itx.tool ⇒ itx.r2"],
    waits: true,
  },
  { name: "a grant removed waits", before: ["itx.tool ⇒ itx.kv"], after: [], waits: true },
  {
    name: "a grant shadowing an implicit root waits",
    before: [],
    after: ["itx.ai ⇒ itx.tool"],
    at: "/",
    waits: true,
  },
  {
    name: "a project root's name at a child answers at once",
    before: [],
    after: ["itx.ai ⇒ itx.tool"],
    waits: false,
  },
  {
    name: "a name behind the parent link waits",
    before: ["itx ⇒ itx.cd('/')"],
    after: ["itx.ai ⇒ itx.tool", "itx ⇒ itx.cd('/')"],
    waits: true,
  },
  {
    name: "a longer row under a grant waits",
    before: ["itx.tool ⇒ itx.append"],
    after: ["itx.tool ⇒ itx.append", "itx.tool.x ⇒ itx.readEvents"],
    waits: true,
  },
  {
    name: "a new parent link answers at once",
    before: [],
    after: ["itx ⇒ itx.cd('/')"],
    waits: false,
  },
  { name: "a jail's bare null waits", before: [], after: ["itx ⇒ null"], waits: true },
  {
    name: "a name re-added while a pending fence holds it taken away waits",
    before: [],
    after: ["itx.tool.x ⇒ itx.r2"],
    takenAway: ["itx.tool"],
    waits: true,
  },
])("$name", ({ before, after, at = "/agents/a", takenAway = [], waits }) => {
  const taken = takenAway.map((match) => parseItxExpressionPrefix(match));
  const implicit = implicitRootsAt("prj_unit", at);
  expect(rulesChangeNeedsCommitWait(table(before), table(after), implicit, taken)).toBe(waits);
});

test("what a change takes away is every row removed or re-pointed but a mask and a row whose target lives in its context", () => {
  const before = table([
    "itx.kept ⇒ itx.kv",
    "itx.removed ⇒ itx.kv",
    "itx.repointed ⇒ itx.builtins.kv.get('a')",
    "itx.masked ⇒ null",
    "itx.lent ⇒ itx.builtins.rpcStubs.get('itx.lent')",
    "itx.reached ⇒ itx.builtins.cd('/b').tool",
  ]);
  const after = table(["itx.kept ⇒ itx.kv", "itx.repointed ⇒ itx.builtins.kv.get('b')"]);
  expect(namesTakenAway(before, after).map((match) => print(match))).toEqual([
    "itx.removed",
    "itx.repointed",
    "itx.reached",
  ]);
});

/** An owner answering `rulesSnapshot(ifVersion)`, recording each read's version, and a clock:
 *  `delayed` reads answer in order on `answer()`, `onRead` runs as one answers, `resets` fail first,
 *  `fail` and `failWith` fail each, `ttlMs` is the lifetime it answers. */
function setup() {
  const clock = { now: 0 };
  const pending: (() => void)[] = [];
  const owner = {
    version: "v1",
    rules: [] as ItxExpressionRewriteRule[],
    ttlMs: undefined as number | undefined,
    reads: [] as (string | undefined)[],
    fail: false,
    failWith: undefined as unknown,
    resets: 0,
    delayed: false,
    onRead: () => {},
    answer: () => pending.shift()?.(),
    read: async (ifVersion: string | undefined): Promise<RulesSnapshotAnswer> => {
      owner.reads.push(ifVersion);
      if (owner.delayed) await new Promise<void>((resolve) => pending.push(resolve));
      owner.onRead();
      if (owner.fail) throw new Error("owner down");
      if (owner.failWith !== undefined) throw owner.failWith;
      if (owner.resets-- > 0) throw new Error("Durable Object reset because its code was updated.");
      const ttl = owner.ttlMs === undefined ? {} : { ttlMs: owner.ttlMs };
      return ifVersion === owner.version
        ? { version: owner.version, ...ttl }
        : {
            version: owner.version,
            rules: owner.rules,
            routing: { fetchRoutes: {}, ingressTarget: null },
            ...ttl,
          };
    },
  };
  return { cache: new RuleSnapshotCache({ now: () => clock.now }), clock, owner };
}

/** A table by canonical match, as core state keeps it. */
const table = (rows: string[]): Record<string, ItxExpressionRewriteRule> =>
  Object.fromEntries(rows.map((spelled) => [spelled.split(" ⇒ ")[0], rule(spelled)]));
