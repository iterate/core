// exceptions.test.mjs — THE CHECKS OF exceptions.ts: `node --test apps/telemetry/`.
// The platform's `iterate/lib` is not installed beside this repo, so the one name exceptions.ts
// takes from it (`forwardIssues`) is a stand-in here, which keeps the forwarder for the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "iterate/lib")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const forwardIssues = (forward) => { globalThis.forwardIssue = forward; }; export const errorCode = (error) => (typeof error === 'object' %26%26 error %26%26 'code' in error ? error.code : undefined);",
      };
    return next(specifier, context);
  },
});
const {
  exceptionsEvent,
  exceptionSeen,
  scrub,
  fingerprintOf,
  allowed,
  EXCEPTIONS,
  OUTSIDE,
  EXCEPTION_SEEN,
} = await import("./exceptions.ts");

const DEAD_LETTER = "events.iterate.com/itx/subscription-delivery-failed";
/** A root that records each append, and refuses the ones to `refuse`. */
function recordingMind() {
  const appended = [];
  const mind = { appended, refuse: null };
  mind.itx = {
    cd: (path) => ({
      append: async (event) => {
        if (mind.refuse === path) throw new Error("append refused");
        appended.push({ path, ...event });
      },
    }),
  };
  return mind;
}

test("a delivery that failed for good becomes one exception/seen on /exceptions, from a handler", async () => {
  const mind = recordingMind();
  await exceptionsEvent(mind.itx, {
    type: DEAD_LETTER,
    path: "/repos/config",
    offset: 1930,
    payload: {
      name: "config",
      offset: 1891,
      attempts: 15,
      error: 'subscription "config", offset 1891: no answer in 20s',
    },
  });
  assert.equal(mind.appended.length, 1);
  const [event] = mind.appended;
  assert.equal(event.path, EXCEPTIONS);
  assert.equal(event.type, EXCEPTION_SEEN);
  assert.equal(event.idempotencyKey, "exception/seen:handler:/repos/config@1930");
  assert.equal(event.payload.kind, "dead-letter");
  assert.deepEqual(event.payload.source, { from: "handler", failureSite: "subscription config" });
  assert.deepEqual(event.payload.where, {
    path: "/repos/config",
    type: DEAD_LETTER,
    offset: 1930,
    failedOffset: 1891,
    attempts: 15,
  });
  assert.match(event.payload.fingerprint, /^[0-9a-z]{7,}$/);
});

test("a failed publish is an exception/seen of kind publish, with the commit", async () => {
  const mind = recordingMind();
  await exceptionsEvent(mind.itx, {
    type: "events.iterate.com/mind/worker-update-failed",
    path: "/",
    offset: 7,
    payload: { commitOid: "abc123", error: "worker.ts: Unexpected token" },
  });
  assert.equal(mind.appended[0].payload.kind, "publish");
  assert.equal(mind.appended[0].payload.source.build, "abc123");
  assert.equal(mind.appended[0].payload.source.failureSite, "publish");
});

test("what the SDK recorded of the config's code on / becomes one exception/seen of the code, named by its record, its texts scrubbed and its path cut", async () => {
  const mind = recordingMind();
  const failed = (offset, payload) =>
    exceptionsEvent(mind.itx, {
      type: "events.iterate.com/mind/code-failed",
      path: "/",
      offset,
      payload,
    });
  await failed(12, {
    where: "fetch",
    method: "POST",
    path: "/reset/abcdefghijklmnopqrstuvwxyz012345",
    error: {
      name: "TypeError",
      message: "bad token=abcdefghijklmnopqrstuvwxyz0123456789abcd",
      stack: "TypeError: bad\n    at Config.fetch (worker.ts:12:5)",
    },
  });
  await failed(13, {
    where: "waitUntil",
    error: { name: "Error", message: "rejected in waitUntil" },
  });
  // the same record delivered again: the same key, so the log keeps one
  await failed(12, { where: "fetch", error: { name: "TypeError", message: "x" } });
  const [fetchEvent, waitUntilEvent, again] = mind.appended;
  assert.equal(fetchEvent.path, EXCEPTIONS);
  assert.equal(fetchEvent.type, EXCEPTION_SEEN);
  assert.equal(fetchEvent.idempotencyKey, "exception/seen:code:/@12");
  assert.equal(again.idempotencyKey, fetchEvent.idempotencyKey);
  assert.equal(fetchEvent.payload.kind, "uncaught");
  assert.deepEqual(fetchEvent.payload.source, { from: "code", failureSite: "fetch" });
  assert.deepEqual(fetchEvent.payload.where, {
    path: "/",
    type: "events.iterate.com/mind/code-failed",
    offset: 12,
    errorName: "TypeError",
    method: "POST",
    pathname: "/reset/<id>",
  });
  assert.ok(!JSON.stringify(fetchEvent).includes("abcdefghijklmnopqrstuvwxyz0123456789abcd"));
  assert.match(fetchEvent.payload.stack, /at Config\.fetch \(worker\.ts:12:5\)/);
  assert.equal(waitUntilEvent.payload.kind, "rejection");
  assert.deepEqual(waitUntilEvent.payload.source, { from: "code", failureSite: "waitUntil" });
  assert.equal(waitUntilEvent.payload.message, "rejected in waitUntil");
  assert.ok(!("pathname" in waitUntilEvent.payload.where));
  // the type on any other context is no record of the SDK's
  const other = recordingMind();
  await exceptionsEvent(other.itx, {
    type: "events.iterate.com/mind/code-failed",
    path: "/agents/x",
    offset: 3,
    payload: { where: "fetch", error: { name: "Error", message: "x" } },
  });
  assert.equal(other.appended.length, 0);
});

test("the SDK's line for a caught rejection in waitUntil does not wait as an issue: its record on / is the exception", async () => {
  const mind = recordingMind();
  globalThis.forwardIssue({
    failureSite: "config.wait-until",
    caught: new Error("rejected in waitUntil"),
    attributes: {},
  });
  await exceptionsEvent(mind.itx, { type: "x/y", path: "/agents/x", offset: 5 });
  assert.equal(mind.appended.length, 0);
});

test("NO LOOP: a failed delivery under /exceptions, /pages or the old /errors is never turned into another exception", async () => {
  const mind = recordingMind();
  for (const path of [
    "/exceptions",
    "/pages",
    "/pages/blog",
    "/errors",
    "/errors/config",
    "/errors/pages/dash",
  ])
    await exceptionsEvent(mind.itx, {
      type: DEAD_LETTER,
      path,
      offset: 5,
      payload: { name: "config", offset: 4, error: "x" },
    });
  assert.equal(mind.appended.length, 0);
  // a path that only starts with the same letters is a source like any other
  await exceptionsEvent(mind.itx, {
    type: DEAD_LETTER,
    path: "/pagesmith",
    offset: 5,
    payload: { name: "config", error: "x" },
  });
  assert.equal(mind.appended.length, 1);
});

test("the hook never throws: a refused append and a broken itx are dropped", async () => {
  const mind = recordingMind();
  mind.refuse = EXCEPTIONS;
  await exceptionsEvent(mind.itx, {
    type: DEAD_LETTER,
    path: "/agents/x",
    offset: 9,
    payload: { name: "config", error: "boom" },
  });
  await exceptionsEvent(
    {
      cd() {
        throw new Error("no cd");
      },
    },
    { type: DEAD_LETTER, path: "/agents/x", offset: 9, payload: {} },
  );
  assert.equal(mind.appended.length, 0);
});

test("any other event, with nothing waiting, makes no call at all", async () => {
  let calls = 0;
  await exceptionsEvent(
    {
      cd: () => {
        calls++;
        return { append: async () => {} };
      },
    },
    {
      type: "events.iterate.com/agent/message-received",
      path: "/agents/x",
      offset: 3,
      payload: {},
    },
  );
  assert.equal(calls, 0);
});

test("what the code reports waits, at most 20, and lands scrubbed with the next event", async () => {
  const mind = recordingMind();
  for (let n = 0; n < 40; n++)
    globalThis.forwardIssue({
      failureSite: "config.something",
      caught: new Error("bad token=abcdefghijklmnopqrstuvwxyz0123456789abcd"),
      attributes: { path: "/x", n },
    });
  await exceptionsEvent(mind.itx, { type: "x/y", path: "/agents/x", offset: 4 });
  const issues = mind.appended.filter((event) => event.payload.source.from === "issue");
  assert.ok(issues.length > 0 && issues.length <= 20, `${issues.length} issues`);
  assert.ok(!JSON.stringify(issues).includes("abcdefghijklmnopqrstuvwxyz0123456789abcd"));
  assert.equal(issues[0].payload.kind, "issue");
  assert.equal(issues[0].payload.source.failureSite, "config.something");
  assert.deepEqual(issues[0].payload.attributes, { path: "/x", n: 0 });
});

test("a storm stops: a source appends at most 30 events in a minute", async () => {
  const mind = recordingMind();
  for (let n = 0; n < 80; n++)
    await exceptionsEvent(mind.itx, {
      type: DEAD_LETTER,
      path: "/agents/y",
      offset: 100 + n,
      payload: { name: "storm", error: "storm" },
    });
  assert.equal(mind.appended.length, 30);
});

test("a page's errors from outside have their own minute: 40 of them leave a member's error of the same app its allowance", async () => {
  const mind = recordingMind();
  const page = (n, member) => ({
    kind: "uncaught",
    message: `outside ${n}`,
    source: { from: "page", app: "own-minute" },
    member,
  });
  // one minute, held still: the counts are the minute's
  const real = Date.now;
  const fixed = real();
  Date.now = () => fixed;
  try {
    let outside = 0;
    for (let n = 0; n < 40; n++)
      if (await exceptionSeen(mind.itx, `o${n}`, page(n, false))) outside++;
    assert.equal(outside, 30);
    for (let n = 0; n < 30; n++)
      assert.equal(await exceptionSeen(mind.itx, `m${n}`, page(n, true)), true, `member ${n}`);
    assert.equal(await exceptionSeen(mind.itx, "m30", page(30, true)), false);
  } finally {
    Date.now = real;
  }
  assert.deepEqual(
    [OUTSIDE, EXCEPTIONS].map((path) => mind.appended.filter((e) => e.path === path).length),
    [30, 30],
  );
});

test("allowed: each source counts its own minute", () => {
  for (let n = 0; n < 5; n++) assert.equal(allowed("test/a", 5), true);
  assert.equal(allowed("test/a", 5), false);
  assert.equal(allowed("test/b", 5), true);
});

test("exceptionSeen: one append, capped texts, no message given still says so", async () => {
  const mind = recordingMind();
  assert.equal(
    await exceptionSeen(mind.itx, "k1", {
      kind: "render",
      message: "",
      stack: "x".repeat(10_000),
      source: { from: "page", app: "seen-test" },
      where: { pathname: "/a" },
      actor: null,
    }),
    true,
  );
  const [event] = mind.appended;
  assert.equal(event.idempotencyKey, "exception/seen:k1");
  assert.equal(event.payload.message, "(no message)");
  assert.ok(event.payload.stack.length <= 4_000);
  assert.equal(event.payload.actor, null);
});

test("exceptionSeen says whether the event landed: false when the append failed or the minute is spent", async () => {
  const mind = recordingMind();
  const seen = {
    kind: "uncaught",
    message: "landed?",
    source: { from: "issue", failureSite: "landed-test" },
  };
  mind.refuse = EXCEPTIONS;
  assert.equal(await exceptionSeen(mind.itx, "l1", seen), false);
  mind.refuse = null;
  assert.equal(await exceptionSeen(mind.itx, "l1", seen), true);
  // a broken itx: still no throw
  assert.equal(
    await exceptionSeen(
      {
        cd() {
          throw new Error("no cd");
        },
      },
      "l2",
      seen,
    ),
    false,
  );
  for (let n = 3; n <= 30; n++) await exceptionSeen(mind.itx, `l${n}`, seen);
  assert.equal(await exceptionSeen(mind.itx, "l31", seen), false);
});

test("scrub cuts a URL to its path, a bearer, a named value and a long run; a frame keeps its line", () => {
  const text = scrub(
    // allow-high-entropy-next-line: a made-up token in the shape of a JWT, which the scrubber must cut
    "GET https://x.example/a/b?token=SECRET123&x=1#frag failed; Authorization: Bearer abc.def.ghi key=sk-12345 eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh at f (https://x.example/app.js?v=9:12:34)",
    500,
  );
  assert.ok(!/SECRET123|frag|abc\.def|sk-12345|eyJhbGci|v=9|x\.example/.test(text), text);
  // a URL keeps its path alone (./cut.ts, the platform's own rule), and a frame its line
  assert.ok(text.startsWith("GET /a/b failed;") && text.includes("at f (/app.js:12:34)"), text);
  assert.equal(scrub("x".repeat(50), 10).length <= 10, true);
  // a cookie header loses its whole value, every cookie after the first `;` too
  assert.equal(
    scrub("sent Cookie: a=b; sid=short\nnext line", 200),
    "sent Cookie: [cut]\nnext line",
  );
  assert.equal(scrub(`{"cookie": "a=b; sid=short", "n": 1}`, 200), `{"cookie": "[cut]", "n": 1}`);
});

test("fingerprintOf: the same error from another build, line or id is the same; another message is not", () => {
  const base = { from: "page", site: "blog", kind: "uncaught" };
  const a = fingerprintOf({
    ...base,
    // allow-high-entropy-next-line: a made-up UUID, which the fingerprint must take out
    message: "Cannot read 'x' of user 3f2b8c1e-9a4d-4b7e-8f21-0c6d5e4a3b2f",
    stack: "Error\n    at f (https://blog.example.com/app-abc123def.js:10:5)",
  });
  const b = fingerprintOf({
    ...base,
    // allow-high-entropy-next-line: a made-up UUID, which the fingerprint must take out
    message: "Cannot read 'x' of user 0c6d5e4a-9a4d-4b7e-8f21-3f2b8c1e3b2f",
    stack: "Error\n    at g (https://blog.example.com/app-99zz88yy.js:99:1)",
  });
  const c = fingerprintOf({ ...base, message: "Something else", stack: "" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(
    a,
    fingerprintOf({
      ...base,
      site: "docs",
      // allow-high-entropy-next-line: a made-up UUID, which the fingerprint must take out
      message: "Cannot read 'x' of user 3f2b8c1e-9a4d-4b7e-8f21-0c6d5e4a3b2f",
      stack: "",
    }),
  );
});

test("WHERE: a page's error whose sender is no member lands on /exceptions/outside, signed in or not; a handler, an issue and a member's page on /exceptions", async () => {
  const mind = recordingMind();
  await exceptionSeen(mind.itx, "w1", {
    kind: "uncaught",
    message: "words from outside",
    source: { from: "page", app: "where-test" },
    actor: null,
  });
  await exceptionSeen(mind.itx, "w2", {
    kind: "uncaught",
    message: "a member's page",
    source: { from: "page", app: "where-test" },
    actor: { userId: "u1", email: "m@example.com" },
    member: true,
  });
  await exceptionSeen(mind.itx, "w3", {
    kind: "uncaught",
    message: "signed in, no member",
    source: { from: "page", app: "where-test" },
    actor: { userId: "u2", email: "s@example.com" },
    member: false,
  });
  await exceptionsEvent(mind.itx, {
    type: DEAD_LETTER,
    path: "/agents/where",
    offset: 1,
    payload: { name: "where", error: "x" },
  });
  globalThis.forwardIssue({
    failureSite: "where.issue",
    caught: new Error("reported"),
    attributes: {},
  });
  await exceptionsEvent(mind.itx, { type: "x/y", path: "/agents/where", offset: 2 });
  assert.equal(OUTSIDE, "/exceptions/outside");
  assert.deepEqual(
    mind.appended.map((event) => [event.payload.source.from, event.path]),
    [
      ["page", OUTSIDE],
      ["page", EXCEPTIONS],
      ["page", OUTSIDE],
      ["handler", EXCEPTIONS],
      ["issue", EXCEPTIONS],
    ],
  );
  assert.ok(mind.appended.every((event) => event.type === EXCEPTION_SEEN));
});

test("scrub cuts a sent text to twice its bound before any pattern runs: 64,000 characters cost little", () => {
  // the URL patterns cost the square of a long run: unbounded, these took seconds of CPU
  for (const [text, max] of [
    ["a".repeat(64_000), 1_000],
    ["a/".repeat(32_000), 1_000],
    ["a.".repeat(32_000), 300],
  ]) {
    const started = performance.now();
    const kept = scrub(text, max);
    assert.ok(performance.now() - started < 250, `${text.slice(0, 4)}… took too long`);
    assert.ok(kept.length <= max);
  }
  assert.equal(scrub({ toString: 1 }, 80), "");
  assert.equal(scrub(42, 80), "42");
});
