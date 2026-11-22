// page-speed.test.mjs — THE CHECKS OF page-speed.ts: `node --test apps/telemetry/*.test.mjs`.
// page-speed.ts takes its names from page-events.ts, which imports a folder and the platform's
// `iterate/lib`: the hooks hand over stand-ins, as in page-events.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "iterate/lib")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const forwardIssues = () => {}; export const errorCode = () => undefined;",
      };
    if (specifier === "./public/" && context.parentURL?.endsWith("/page-events.ts"))
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify({ "page.js": "" })};`)}`,
      };
    return next(specifier, context);
  },
});
const { pageSpeed, p75, ratingOf, THRESHOLDS, SPEED_NOTE } = await import("./page-speed.ts");

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
let offset = 0;
/** A first view's `page/left`, `hoursAgo` before NOW. */
const left = (app, pathname, load, { hoursAgo = 1, view = 1, marks, member } = {}) => ({
  type: "events.iterate.com/page/left",
  offset: (offset += 1),
  createdAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  // an event as the route writes it: no key for what a view did not have
  payload: {
    app,
    pathname,
    view,
    openMs: 1,
    seenMs: 1,
    // oxlint-disable-next-line iterate/simple-truthiness-check -- no key for a later view, which has no load
    ...(load && { load }),
    // oxlint-disable-next-line iterate/simple-truthiness-check -- no key for a view with no marks
    ...(marks && { marks }),
    ...(member && { member: true }),
  },
});
/** A root whose catalog lists /pages (unless `listed` is false), with `events` on it. It records
 *  each read. `pageCap` ends a read early, as the log does when a page's bytes are many; `count`
 *  is what the catalog says, when it is behind. */
function mindWith(events, { listed = true, pageCap = Infinity, count = events.length } = {}) {
  const reads = [];
  return {
    reads,
    itx: {
      contexts: {
        list: async () => (listed ? [{ path: "/pages", eventCount: count }] : []),
      },
      cd: (path) => ({
        readEvents: async (after = 0, limit = 1_000) => {
          reads.push({ path, after, limit });
          const page = events.filter((e) => e.offset > after).slice(0, Math.min(limit, pageCap));
          const through = page.at(-1)?.offset ?? after;
          return {
            events: page,
            scannedThroughOffset: through,
            atHead: through >= (events.at(-1)?.offset ?? 0),
          };
        },
      }),
    },
  };
}

test("p75: nearest rank; none for no values", () => {
  assert.equal(p75([]), undefined);
  assert.equal(p75([5]), 5);
  assert.equal(p75([4, 1, 3, 2]), 3);
  assert.equal(p75(Array.from({ length: 100 }, (_, i) => i + 1)), 75);
  assert.equal(p75([1, 2, 3, 4, 5]), 4);
});

test("ratingOf: Google's thresholds, the bounds themselves are the better rating", () => {
  assert.deepEqual(THRESHOLDS.lcp, { good: 2_500, poor: 4_000 });
  assert.equal(ratingOf("firstByte", 800), "good");
  assert.equal(ratingOf("firstByte", 801), "needs-improvement");
  assert.equal(ratingOf("fcp", 3_001), "poor");
  assert.equal(ratingOf("lcp", 4_000), "needs-improvement");
  assert.equal(ratingOf("inp", 200), "good");
  assert.equal(ratingOf("inp", 501), "poor");
  assert.equal(ratingOf("cls", 0.1), "good");
  assert.equal(ratingOf("cls", 0.25), "needs-improvement");
  assert.equal(ratingOf("cls", 0.26), "poor");
});

test("pageSpeed: a mind with no /pages reads nothing and answers one empty group", async () => {
  const mind = mindWith([], { listed: false });
  const answer = await pageSpeed(mind.itx, {}, NOW);
  assert.equal(mind.reads.length, 0, "a context the catalog does not list is never read");
  assert.equal(answer.note, SPEED_NOTE);
  assert.equal(answer.views, 0);
  assert.deepEqual(answer.groups, [
    { app: "*", pathname: "*", views: 0, outside: 0, vitals: {}, marks: {}, mind: true },
  ]);
});

test("pageSpeed: each group says how many views came from outside, and `members: true` reads members' views alone", async () => {
  const mind = mindWith([
    left("blog", "/", { firstByte: 100 }, { member: true }),
    left("blog", "/", { firstByte: 9_000 }),
    left("blog", "/", { firstByte: 9_500 }),
  ]);
  const all = await pageSpeed(mind.itx, {}, NOW);
  assert.deepEqual([all.groups[0].views, all.groups[0].outside], [3, 2]);
  assert.deepEqual([all.groups[1].views, all.groups[1].outside], [3, 2]);
  assert.equal(all.groups[1].vitals.firstByte.p75, 9_500, "anyone outside moves the percentile");
  const members = await pageSpeed(mind.itx, { members: true }, NOW);
  assert.deepEqual(
    [members.views, members.groups[1].outside, members.groups[1].vitals.firstByte.p75],
    [1, 0, 100],
  );
});

test("pageSpeed: one app, the 75th percentiles, the ratings and the marks; later views, old views and other events are left out", async () => {
  const views = [100, 200, 300, 900].map((firstByte, i) =>
    left(
      "blog",
      "/posts/a",
      {
        firstByte,
        fcp: firstByte + 1_000,
        largestPaint: firstByte + 2_000,
        inp: [50, 120, 220, 600][i],
        cls: [0, 0.05, 0.2, 0.3][i],
        shift: 1,
      },
      { marks: { "iterate:itx-open": [400, 500, 600, 700][i] } },
    ),
  );
  const events = [
    ...views,
    left("blog", "/posts/a", { firstByte: 0, largestPaint: 0 }), // an older event: no time is no sample
    left("blog", "/posts/a", { firstByte: 9_999 }, { hoursAgo: 8 * 24 }), // older than 7 days
    left("blog", "/posts/a", null, { view: 2 }), // a later view
    {
      type: "events.iterate.com/page/viewed",
      offset: (offset += 1),
      createdAt: new Date(NOW).toISOString(),
      payload: { app: "blog", pathname: "/posts/a", view: 1 },
    },
  ];
  const answer = await pageSpeed(mindWith(events).itx, {}, NOW);
  assert.equal(answer.views, 5);
  const [all, blog] = answer.groups;
  assert.equal(all.mind, true);
  assert.equal(answer.groups.length, 2);
  assert.deepEqual([blog.app, blog.pathname, blog.views], ["blog", "/posts/a", 5]);
  assert.deepEqual(blog.vitals, {
    firstByte: { p75: 300, rating: "good", samples: 4 },
    fcp: { p75: 1_300, rating: "good", samples: 4 },
    lcp: { p75: 2_300, rating: "good", samples: 4 },
    inp: { p75: 220, rating: "needs-improvement", samples: 4 },
    cls: { p75: 0.2, rating: "needs-improvement", samples: 4 },
  });
  assert.deepEqual(blog.marks, { "iterate:itx-open": { p75: 600, samples: 4 } });
  assert.deepEqual(all.vitals, blog.vitals);
});

test("pageSpeed: busiest first, at most `limit`, one app alone, and the whole mind over all", async () => {
  const events = [
    left("dash", "/", { firstByte: 900 }),
    left("blog", "/a", { firstByte: 100 }),
    left("blog", "/a", { firstByte: 200 }),
    left("blog", "/b", { firstByte: 2_000 }),
    left("blog", "/a", { firstByte: 300 }),
  ];
  const answer = await pageSpeed(mindWith(events).itx, { limit: 2 }, NOW);
  assert.deepEqual(
    answer.groups.map((g) => [g.app, g.pathname, g.views]),
    [
      ["*", "*", 5],
      ["blog", "/a", 3],
      ["blog", "/b", 1],
    ],
  );
  assert.deepEqual(answer.groups[0].vitals.firstByte, {
    p75: 900,
    rating: "needs-improvement",
    samples: 5,
  });
  const blog = await pageSpeed(mindWith(events).itx, { app: "blog" }, NOW);
  assert.equal(blog.views, 4);
  assert.deepEqual(
    blog.groups.map((g) => g.pathname),
    ["*", "/a", "/b"],
  );
});

test("pageSpeed: members first: 6,000 newer views from outside push out none of 10 members' views; each side keeps its newest 4,000", async () => {
  offset = 0;
  const events = [
    ...Array.from({ length: 10 }, () => left("blog", "/a", { firstByte: 50 }, { member: true })),
    ...Array.from({ length: 6_000 }, (_, i) => left("blog", "/a", { firstByte: i + 1 })),
  ];
  const mind = mindWith(events);
  const answer = await pageSpeed(mind.itx, {}, NOW);
  assert.equal(answer.views, 4_010);
  assert.equal(answer.groups[0].outside, 4_000);
  assert.equal(answer.groups[0].vitals.firstByte.samples, 4_010);
  const members = await pageSpeed(mindWith(events).itx, { members: true }, NOW);
  assert.deepEqual([members.views, members.groups[0].outside], [10, 0]);
  assert.equal(members.groups[0].vitals.firstByte.p75, 50);
  assert.ok(mind.reads.every((read) => read.limit === 1_000 && read.path === "/pages"));
});

test("pageSpeed: it reads newest first, 1,000 events a read, and stops when the members' window is full", async () => {
  offset = 0;
  const events = Array.from({ length: 41_000 }, () =>
    left("blog", "/a", { firstByte: 1 }, { member: true }),
  );
  const mind = mindWith(events);
  const answer = await pageSpeed(mind.itx, {}, NOW);
  assert.equal(answer.views, 4_000);
  assert.deepEqual(
    mind.reads.map((read) => read.after),
    [40_000, 39_000, 38_000, 37_000],
  );
});

test("pageSpeed: a flood from outside is read back 40,000 events at most", async () => {
  offset = 0;
  const events = [
    ...Array.from({ length: 10 }, () => left("blog", "/a", { firstByte: 50 }, { member: true })),
    ...Array.from({ length: 50_000 }, () => left("blog", "/a", { firstByte: 1 })),
  ];
  const mind = mindWith(events);
  const answer = await pageSpeed(mind.itx, {}, NOW);
  assert.equal(mind.reads.length, 40);
  assert.deepEqual([answer.views, answer.groups[0].outside], [4_000, 4_000]);
});

test("pageSpeed: the read stops at the first read that reaches back past the days asked", async () => {
  offset = 0;
  const events = [
    ...Array.from({ length: 9_000 }, () =>
      left("blog", "/old", { firstByte: 1 }, { hoursAgo: 240, member: true }),
    ),
    ...Array.from({ length: 100 }, () => left("blog", "/new", { firstByte: 1 }, { member: true })),
  ];
  const mind = mindWith(events);
  const answer = await pageSpeed(mind.itx, { days: 7 }, NOW);
  assert.equal(mind.reads.length, 1);
  assert.equal(answer.views, 100);
});

test("pageSpeed: a read that ends early, as the log ends one by its bytes, is followed to its interval's end", async () => {
  offset = 0;
  const events = Array.from({ length: 2_000 }, () =>
    left("blog", "/a", { firstByte: 1 }, { member: true }),
  );
  const mind = mindWith(events, { pageCap: 300 });
  const answer = await pageSpeed(mind.itx, {}, NOW);
  assert.equal(answer.views, 2_000);
  assert.ok(mind.reads.every((read) => read.limit === 1_000));
});

test("pageSpeed: a catalog count that is behind never takes the read past its budget", async () => {
  offset = 0;
  const events = Array.from({ length: 60_000 }, () => left("blog", "/a", { firstByte: 1 }));
  const mind = mindWith(events, { count: 0 });
  await pageSpeed(mind.itx, {}, NOW);
  assert.equal(mind.reads.length, 40);
  const small = mindWith(events, { count: 0, pageCap: 10 });
  await pageSpeed(small.itx, {}, NOW);
  assert.equal(small.reads.length, 100);
});
