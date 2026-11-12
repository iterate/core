// What leaves a stack's data catalog after a destroy (telemetry-tables.ts), against a pretend
// Cloudflare that holds two stacks.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Call } from "./cloudflare-call.ts";
import { dropTelemetryTables } from "./telemetry-tables.ts";

const ACCOUNT = "a".repeat(32);
const ALL = ["events", "logs", "spans"];

void test("after a destroy, the stack's three tables and their namespace go, through a bucket made for it and removed again", async () => {
  // as a destroy leaves both: no Worker, no bucket, the catalog off, the tables kept
  const cloudflare = pretendCloudflare({
    catalogs: {
      "iterate-one-telemetry": { on: false, tables: [...ALL] },
      "iterate-two-telemetry": { on: true, tables: [...ALL] },
    },
    buckets: ["iterate-two-telemetry"],
    workers: ["iterate-two-boundary"],
  });

  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });

  assert.equal(failed, false);
  assert.deepEqual(lines, [
    "Dropped: table telemetry.events in the data catalog of iterate-one-telemetry",
    "Dropped: table telemetry.logs in the data catalog of iterate-one-telemetry",
    "Dropped: table telemetry.spans in the data catalog of iterate-one-telemetry",
    "Dropped: namespace telemetry in the data catalog of iterate-one-telemetry",
  ]);
  // the stack's catalog is empty and off again, and the bucket made to reach it is gone
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: false, tables: [] });
  assert.deepEqual(cloudflare.buckets, ["iterate-two-telemetry"]);
  // the other stack is as it was
  assert.deepEqual(cloudflare.catalogs["iterate-two-telemetry"], { on: true, tables: ALL });
  for (const written of cloudflare.writes) assert.match(written, /iterate-one-telemetry/);
  // a second run finds nothing, and says nothing was dropped
  assert.deepEqual(
    await dropTelemetryTables({
      accountId: ACCOUNT,
      name: "one",
      call: cloudflare.call,
      pause: async () => {},
    }),
    { failed: false, lines: ["the data catalog of iterate-one-telemetry has no telemetry tables"] },
  );
  assert.deepEqual(cloudflare.buckets, ["iterate-two-telemetry"]);
});

void test("a destroy that was cancelled drops nothing: a Worker of the stack is still deployed", async () => {
  const cloudflare = pretendCloudflare({
    catalogs: { "iterate-one-telemetry": { on: true, tables: [...ALL] } },
    buckets: ["iterate-one-telemetry"],
    workers: ["iterate-one-boundary", "iterate-one-telemetry"],
  });

  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });

  assert.equal(failed, false);
  assert.deepEqual(lines, [
    "The stack one is still deployed (the Worker iterate-one-boundary is there): no table is dropped.",
  ]);
  assert.deepEqual(cloudflare.writes, []);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: true, tables: ALL });
});

void test("a table that is not the stack's stays, and so does its namespace", async () => {
  const cloudflare = pretendCloudflare({
    catalogs: { "iterate-one-telemetry": { on: false, tables: ["events", "mine"] } },
  });

  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });

  assert.equal(failed, false);
  assert.deepEqual(lines, [
    "Dropped: table telemetry.events in the data catalog of iterate-one-telemetry",
    "Left: the namespace telemetry of iterate-one-telemetry, which also holds mine: not this stack's",
  ]);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"]?.tables, ["mine"]);
});

void test("a stack that never had telemetry has nothing to drop, and no bucket is made for it", async () => {
  const cloudflare = pretendCloudflare({});
  assert.deepEqual(
    await dropTelemetryTables({
      accountId: ACCOUNT,
      name: "one",
      call: cloudflare.call,
      pause: async () => {},
    }),
    {
      failed: false,
      lines: ["iterate-one-telemetry never had a data catalog: no table to drop"],
    },
  );
  assert.deepEqual(cloudflare.writes, []);
});

void test("a table that Cloudflare refuses to drop is said, the namespace is not asked, and the bucket is still put back", async () => {
  const cloudflare = pretendCloudflare(
    { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
    { refuse: "logs" },
  );

  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });

  assert.equal(failed, true);
  assert.match(lines[1]!, /^NOT dropped: table telemetry\.logs .* \(Cloudflare answered 403\)$/);
  assert.equal(
    cloudflare.writes.some((written) => written.includes('/namespaces/telemetry "')),
    false,
  );
  assert.deepEqual(cloudflare.buckets, []);
  assert.equal(cloudflare.catalogs["iterate-one-telemetry"]?.on, false);
});

void test("a catalog that cannot be turned on fails the step, says the tables may be left, and leaves no bucket", async () => {
  for (const refuse of ["enable", "never on"]) {
    const cloudflare = pretendCloudflare(
      { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
      { refuse },
    );
    const { failed, lines } = await dropTelemetryTables({
      accountId: ACCOUNT,
      name: "one",
      call: cloudflare.call,
      pause: async () => {},
    });
    assert.equal(failed, true, refuse);
    assert.match(lines.join(" "), /could not be turned on .*: its tables may be left/, refuse);
    assert.doesNotMatch(lines.join(" "), /no telemetry tables|Dropped/, refuse);
    assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"]?.tables, ALL, refuse);
    assert.deepEqual(cloudflare.buckets, [], refuse);
  }
});

void test("a bucket that Cloudflare refuses to make fails the step, and nothing is called dropped", async () => {
  const cloudflare = pretendCloudflare(
    { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
    { refuse: "bucket" },
  );
  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });
  assert.equal(failed, true);
  assert.match(lines[0]!, /answered 403 to the bucket .*: the tables may be left/);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"]?.tables, ALL);
});

void test("a bucket that could not be removed keeps its mark, and the next run finishes: it empties every page and removes it", async () => {
  for (const refuse of ["object", "remove"]) {
    const cloudflare = pretendCloudflare(
      { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
      { refuse },
    );
    const run = () =>
      dropTelemetryTables({
        accountId: ACCOUNT,
        name: "one",
        call: cloudflare.call,
        pause: async () => {},
      });

    const first = await run();
    // the tables went, and the run still fails: something of its own is left in the account
    assert.equal(first.failed, true, refuse);
    assert.match(
      first.lines.at(-1)!,
      /^NOT removed: the bucket iterate-one-telemetry, which this step made/,
    );
    assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: false, tables: [] });
    assert.ok(
      cloudflare
        .objectsOf("iterate-one-telemetry")
        ?.includes("iterate-made-this-bucket-to-drop-its-tables"),
      refuse,
    );

    cloudflare.allow();
    const second = await run();
    assert.deepEqual(second, {
      failed: false,
      lines: ["the data catalog of iterate-one-telemetry has no telemetry tables"],
    });
    assert.deepEqual(cloudflare.buckets, [], refuse);
  }
});

void test("a bucket whose mark is gone at the end is still removed", async () => {
  const cloudflare = pretendCloudflare(
    { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
    { refuse: "mark lost" },
  );
  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });
  assert.equal(failed, false);
  assert.equal(lines.length, 4);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: false, tables: [] });
  assert.deepEqual(cloudflare.buckets, []);
});

void test("a bucket that cannot be marked is removed at once, and the step fails before it drops anything", async () => {
  const cloudflare = pretendCloudflare(
    { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
    { refuse: "mark" },
  );
  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });
  assert.equal(failed, true);
  assert.deepEqual(lines, [
    "Cloudflare answered 403 to the mark in the bucket iterate-one-telemetry, made to reach its tables: the tables may be left",
    "Removed again: the bucket iterate-one-telemetry",
  ]);
  assert.deepEqual(cloudflare.buckets, []);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: false, tables: ALL });
});

void test("a bucket that can be neither marked nor removed is named as one to remove by hand", async () => {
  const cloudflare = pretendCloudflare(
    { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
    { refuse: "mark,remove" },
  );
  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });
  assert.equal(failed, true);
  assert.match(lines[1]!, /^NOT removed: the bucket iterate-one-telemetry, .* Remove it by hand/);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: false, tables: ALL });
});

void test("a bucket that stays, with a mark that cannot be put back, is named as one to remove by hand", async () => {
  const cloudflare = pretendCloudflare(
    { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
    { refuse: "remove,second mark" },
  );
  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });
  assert.equal(failed, true);
  assert.match(lines.at(-1)!, /its mark could not be put back\. Remove it by hand/);
});

void test("a mark that cannot be read stops the step: the bucket is neither the stack's own nor this step's", async () => {
  const cloudflare = pretendCloudflare(
    {
      catalogs: { "iterate-one-telemetry": { on: true, tables: [...ALL] } },
      buckets: ["iterate-one-telemetry"],
    },
    { refuse: "mark read" },
  );
  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });
  assert.equal(failed, true);
  assert.match(lines[0]!, /answered 500 to GET the mark .* its tables may be left/);
  assert.deepEqual(cloudflare.writes, []);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: true, tables: ALL });
});

void test("a bucket with no mark is the stack's own: its tables go and the bucket stays", async () => {
  const cloudflare = pretendCloudflare({
    catalogs: { "iterate-one-telemetry": { on: true, tables: [...ALL] } },
    buckets: ["iterate-one-telemetry"],
  });
  const { failed, lines } = await dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
  });
  assert.equal(failed, false);
  assert.equal(lines.length, 4);
  assert.deepEqual(cloudflare.buckets, ["iterate-one-telemetry"]);
  assert.equal(cloudflare.catalogs["iterate-one-telemetry"]?.on, true);
});

const SINKS = ALL.map((table) => `iterate_one_telemetry_${table}_sink`);
const deploying = (cloudflare: ReturnType<typeof pretendCloudflare>) =>
  dropTelemetryTables({
    accountId: ACCOUNT,
    name: "one",
    call: cloudflare.call,
    pause: async () => {},
    when: "deploying",
  });

void test("at a deploy, the tables that a turn-off left go while the stack is deployed, and are named first", async () => {
  // as a deploy with telemetry off leaves a stack that had it: its Workers, no sink, no bucket,
  // the catalog off, the tables kept
  const cloudflare = pretendCloudflare({
    catalogs: { "iterate-one-telemetry": { on: false, tables: ["logs", "spans"] } },
    workers: ["iterate-one-boundary", "iterate-one-mind"],
    sinks: ["iterate_two_telemetry_logs_sink"],
  });

  const { failed, lines } = await deploying(cloudflare);

  assert.equal(failed, false);
  assert.deepEqual(lines, [
    "Left over from an earlier time telemetry was on: telemetry.logs, telemetry.spans in the data catalog of iterate-one-telemetry, with no log pipeline. Cloudflare lets no new pipeline write to a table that exists, so they go now, with the rows in them.",
    "Dropped: table telemetry.logs in the data catalog of iterate-one-telemetry",
    "Dropped: table telemetry.spans in the data catalog of iterate-one-telemetry",
    "Dropped: namespace telemetry in the data catalog of iterate-one-telemetry",
  ]);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: false, tables: [] });
  assert.deepEqual(cloudflare.buckets, []);
  // a second deploy finds none
  assert.deepEqual(await deploying(cloudflare), {
    failed: false,
    lines: ["the data catalog of iterate-one-telemetry has no table left over"],
  });
});

void test("at a deploy, a stack whose sinks write its tables is left as it is, after two reads", async () => {
  const cloudflare = pretendCloudflare({
    catalogs: { "iterate-one-telemetry": { on: true, tables: [...ALL] } },
    buckets: ["iterate-one-telemetry"],
    workers: ["iterate-one-boundary", "iterate-one-telemetry"],
    // the stack's three sinks are on the second page
    sinks: [...Array.from({ length: 50 }, (_, at) => `other_${at}_sink`), ...SINKS],
  });

  assert.deepEqual(await deploying(cloudflare), {
    failed: false,
    lines: ["The log pipelines of one write its three tables: none is left over."],
  });
  assert.deepEqual(cloudflare.writes, []);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: true, tables: ALL });
});

void test("at a deploy, a table whose sink is there stays with its namespace, and one with no sink goes", async () => {
  // as a deploy that failed at two sinks leaves it: the bucket and the catalog on, one sink made
  const cloudflare = pretendCloudflare({
    catalogs: { "iterate-one-telemetry": { on: true, tables: [...ALL] } },
    buckets: ["iterate-one-telemetry"],
    sinks: ["iterate_one_telemetry_events_sink"],
  });

  const { failed, lines } = await deploying(cloudflare);

  assert.equal(failed, false);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^Left over .*: telemetry\.logs, telemetry\.spans in /);
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], { on: true, tables: ["events"] });
  assert.deepEqual(cloudflare.buckets, ["iterate-one-telemetry"]);
  assert.equal(
    cloudflare.writes.some((written) => written.includes('/namespaces/telemetry "')),
    false,
  );
});

void test("at a deploy, sinks that cannot be read stop the step before it writes", async () => {
  const cloudflare = pretendCloudflare(
    { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
    { refuse: "sinks" },
  );
  assert.deepEqual(await deploying(cloudflare), {
    failed: true,
    lines: [
      "Cloudflare answered 403 when asked for the account's pipeline sinks: no table is dropped.",
    ],
  });
  assert.deepEqual(cloudflare.writes, []);
});

void test("at a deploy, a stack that never had telemetry is left after one read", async () => {
  const cloudflare = pretendCloudflare({ workers: ["iterate-one-boundary"] });
  assert.deepEqual(await deploying(cloudflare), {
    failed: false,
    lines: ["iterate-one-telemetry never had a data catalog: no table to drop"],
  });
  assert.deepEqual(cloudflare.writes, []);
});

const MARK = "iterate-made-this-bucket-to-drop-its-tables";

void test("at a deploy, a marked bucket with a sink beside it is not emptied: it is the stack's bucket", async () => {
  // as a deploy with --adopt leaves a bucket that this step could not remove: the stack's own
  // now, the mark still in it, and one sink missing
  const cloudflare = pretendCloudflare({
    catalogs: { "iterate-one-telemetry": { on: true, tables: [...ALL] } },
    buckets: ["iterate-one-telemetry"],
    objects: { "iterate-one-telemetry": [MARK, "__r2_data_catalog/c/t/data/1.parquet"] },
    sinks: ["iterate_one_telemetry_events_sink", "iterate_one_telemetry_logs_sink"],
  });

  const answer = await deploying(cloudflare);

  assert.equal(answer.failed, false);
  assert.equal(answer.bucketLeft, undefined);
  assert.equal(
    answer.lines[0],
    "The bucket iterate-one-telemetry has this step's mark in it, and a log pipeline of the stack writes to it: it is the stack's bucket, and nothing in it goes.",
  );
  // the table with no sink goes, as at any deploy; the bucket and all it holds stay
  assert.deepEqual(cloudflare.catalogs["iterate-one-telemetry"], {
    on: true,
    tables: ["events", "logs"],
  });
  assert.deepEqual(cloudflare.objectsOf("iterate-one-telemetry"), [
    MARK,
    "__r2_data_catalog/c/t/data/1.parquet",
  ]);
  assert.equal(
    cloudflare.writes.some((written) => written.includes("/r2/buckets/")),
    false,
  );
});

void test("at a deploy, a marked bucket that holds table rows is not emptied, with no sink beside it", async () => {
  for (const rows of ["__r2_data_catalog/c/t/data/1.parquet", "a-file-of-the-stack"]) {
    const cloudflare = pretendCloudflare({
      catalogs: { "iterate-one-telemetry": { on: true, tables: [...ALL] } },
      buckets: ["iterate-one-telemetry"],
      objects: { "iterate-one-telemetry": [MARK, rows] },
    });

    const answer = await deploying(cloudflare);

    assert.equal(answer.failed, false, rows);
    assert.equal(answer.bucketLeft, undefined, rows);
    assert.equal(
      answer.lines[0],
      "The bucket iterate-one-telemetry has this step's mark in it, and it holds table rows: it is the stack's bucket, and nothing in it goes.",
    );
    assert.deepEqual(cloudflare.objectsOf("iterate-one-telemetry"), [MARK, rows]);
    assert.deepEqual(cloudflare.buckets, ["iterate-one-telemetry"]);
  }
});

void test("at a deploy, a marked bucket whose objects cannot be listed stops the step before it writes", async () => {
  const cloudflare = pretendCloudflare(
    {
      catalogs: { "iterate-one-telemetry": { on: true, tables: [...ALL] } },
      buckets: ["iterate-one-telemetry"],
      objects: { "iterate-one-telemetry": [MARK] },
    },
    { refuse: "list" },
  );
  const answer = await deploying(cloudflare);
  assert.equal(answer.failed, true);
  assert.match(answer.lines[0]!, /whose bucket it is stays unknown, and nothing in it goes/);
  assert.deepEqual(cloudflare.writes, []);
});

void test("at a deploy, the step's own bucket that could not be removed is said (bucketLeft), and the next run removes it", async () => {
  const cloudflare = pretendCloudflare(
    {
      catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } },
      workers: ["iterate-one-boundary"],
    },
    { refuse: "remove" },
  );

  const first = await deploying(cloudflare);
  assert.equal(first.failed, true);
  assert.equal(first.bucketLeft, true);
  assert.deepEqual(cloudflare.buckets, ["iterate-one-telemetry"]);

  // the bucket holds the mark and the catalog's own files, no sink is there: this step's still
  cloudflare.allow();
  assert.deepEqual(await deploying(cloudflare), {
    failed: false,
    lines: ["the data catalog of iterate-one-telemetry has no table left over"],
  });
  assert.deepEqual(cloudflare.buckets, []);
});

void test("at a deploy, a bucket that could be neither marked nor removed is said too (bucketLeft)", async () => {
  const cloudflare = pretendCloudflare(
    { catalogs: { "iterate-one-telemetry": { on: false, tables: [...ALL] } } },
    { refuse: "mark,remove" },
  );
  const answer = await deploying(cloudflare);
  assert.equal(answer.failed, true);
  assert.equal(answer.bucketLeft, true);
});

/** An account as Cloudflare answers for it: its Workers, its pipeline sinks, its R2 buckets with their objects, and
 *  each bucket name's data catalog, which outlives its bucket. A catalog that is turned on writes
 *  three objects into its bucket, and a bucket lists two objects at a time. `refuse` names what
 *  Cloudflare refuses: a table's drop, "sinks" (their list), "enable", "bucket" (its making), "mark" (the mark's
 *  writing), "second mark" (its second writing alone), "mark read", "list" (a bucket's objects), "object" (an object's delete), "remove" (the bucket's delete); "never on" enables and
 *  stays off, and "mark lost" answers 200 to the mark's writing and keeps no mark. Two of them at
 *  once are written with a comma. */
function pretendCloudflare(
  held: {
    catalogs?: Record<string, { on: boolean; tables: string[] }>;
    buckets?: string[];
    workers?: string[];
    sinks?: string[];
    /** what a bucket of `buckets` holds at the start */
    objects?: Record<string, string[]>;
  },
  options: { refuse?: string } = {},
) {
  const catalogs: Record<string, { on: boolean; tables: string[] } | undefined> = structuredClone(
    held.catalogs || {},
  );
  const objects = new Map<string, string[]>(
    (held.buckets || []).map((bucket) => [bucket, [...(held.objects?.[bucket] || [])]]),
  );
  const workers = held.workers || [];
  const writes: string[] = [];
  const namespaceGone = new Set<string>();
  const answer = (status: number, body: unknown = null) => ({ status, body });
  let markWrites = 0;
  const refuses = (what: string) => (options.refuse || "").split(",").includes(what);
  const call: Call = async (method, url, body) => {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split("/").filter(Boolean);
    if (method !== "GET") writes.push(`${method} ${pathname} ${JSON.stringify(body ?? "")}`);
    if (hostname !== "api.cloudflare.com") {
      // https://catalog.cloudflarestorage.com/<account>/<bucket>/v1/<id>/namespaces/telemetry[/tables/<table>]
      const [, bucket = "", , id, , , , table] = parts;
      const catalog = catalogs[bucket];
      assert.equal(id, `id-of-${bucket}`);
      // a catalog answers only while it is on and its bucket is there
      if (!catalog?.on || !objects.has(bucket)) return answer(404);
      if (table && refuses(table)) return answer(403);
      if (table) catalog.tables = catalog.tables.filter((name) => name !== table);
      // a namespace that is gone is not there to drop again
      else if (namespaceGone.has(bucket)) return answer(404);
      else namespaceGone.add(bucket);
      return answer(204);
    }
    // /client/v4/accounts/<account>/<product>/…
    const [product, ...rest] = parts.slice(4);
    if (product === "workers")
      return workers.includes(rest[1]!) ? answer(200, { success: true }) : answer(404);
    if (product === "pipelines") {
      if (refuses("sinks")) return answer(403);
      // 50 sinks at a time, as the step asks for them
      const page = Number(new URL(url).searchParams.get("page"));
      const sinks = (held.sinks || []).slice((page - 1) * 50, page * 50);
      return answer(200, { result: sinks.map((name) => ({ name })) });
    }
    if (product === "r2") {
      const [, bucket, , sent] = rest;
      const key = sent && decodeURIComponent(sent);
      if (!bucket) {
        if (refuses("bucket")) return answer(403);
        // the cast: this test's own call, which sends the bucket's name
        objects.set((body as { name: string }).name, []);
        return answer(200, { success: true });
      }
      const inIt = objects.get(bucket);
      if (!inIt) return answer(404);
      if (rest[2] === "objects" && !key && refuses("list")) return answer(500);
      if (rest[2] === "objects" && !key)
        return answer(200, { result: inIt.slice(0, 2).map((each) => ({ key: each })) });
      if (key) {
        if (method === "PUT") markWrites += 1;
        if (method === "PUT" && (refuses("mark") || (refuses("second mark") && markWrites === 2)))
          return answer(403);
        if (method === "GET" && refuses("mark read")) return answer(500);
        if (method === "PUT")
          return (inIt.includes(key) || refuses("mark lost") || inIt.push(key), answer(200));
        if (!inIt.includes(key)) return answer(404);
        if (method === "GET") return answer(200);
        if (refuses("object") && !key.startsWith("iterate-")) return answer(500);
        inIt.splice(inIt.indexOf(key), 1);
        return answer(200);
      }
      if (method === "DELETE") {
        if (refuses("remove") || inIt.length > 0) return answer(409);
        objects.delete(bucket);
      }
      return answer(200, { success: true });
    }
    // r2-catalog/<bucket>[/enable|/disable|/namespaces/telemetry/tables]
    const bucket = rest[0]!;
    const catalog = catalogs[bucket];
    if (!catalog) return answer(404);
    if (rest[1] === "enable" || rest[1] === "disable") {
      const inIt = objects.get(bucket);
      if (!inIt || (rest[1] === "enable" && refuses("enable"))) return answer(400);
      if (rest[1] === "enable" && !refuses("never on"))
        inIt.push("__r2_data_catalog/a", "__r2_data_catalog/b", "__r2_data_catalog/c");
      catalog.on = rest[1] === "enable" && !refuses("never on");
      return answer(200, { success: true });
    }
    if (rest.length === 1)
      return answer(200, {
        result: { id: `id-of-${bucket}`, status: catalog.on ? "active" : "inactive" },
      });
    if (!catalog.on || !objects.has(bucket)) return answer(404);
    return answer(200, { result: { identifiers: catalog.tables.map((name) => ({ name })) } });
  };
  return {
    call,
    catalogs,
    writes,
    get buckets() {
      return [...objects.keys()];
    },
    objectsOf: (bucket: string) => objects.get(bucket),
    allow: () => void (options.refuse = undefined),
  };
}
