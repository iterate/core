// The cut of a query over Cloudflare's own datasets (./store-query.ts), with no network, and the
// `Telemetry` entrypoint (./rpc.ts) that runs it on a stand-in Analytics SQL binding. Every SQL
// shape asserted here was sent to Cloudflare's Analytics SQL API on 22 Nov 2026 and taken.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { errorCode } from "iterate/lib";
import { proveTheCut, storeQuery } from "./store-query.ts";

// rpc.ts extends `WorkerEntrypoint`, which only the Workers runtime serves
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "cloudflare:workers"
      ? {
          url: `data:text/javascript,export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`,
          shortCircuit: true,
        }
      : next(specifier, context),
});
const { Telemetry } = await import("./rpc.ts");

const OWN = ["iterate-example-com-mind", "iterate-example-com-boundary"];
// the cut's shape is the same for any list: most tests here give the logs the same two names
const scope = { own: OWN, logs: OWN, metricsDataset: "iterate_example_com_metrics" };
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const cut = (sql: string, hours?: number) => storeQuery(sql, scope, hours, NOW);

void test("WHOSE ROWS: the logs, issues and invocations of every Worker of the stack; the spans of the mind's own Workers alone", () => {
  const stack = [
    ...OWN,
    "iterate-example-com-auth",
    "iterate-example-com-secrets",
    "iterate-example-com-telemetry",
  ];
  const read = (sql: string) =>
    Object.entries(storeQuery(sql, { ...scope, logs: stack }, 24, NOW).params)
      .filter(([name]) => name.startsWith("itx_worker_"))
      .map(([, worker]) => worker);
  for (const dataset of ["logs.workersLogs", "logs.issues", "events.workersInvocations"])
    assert.deepEqual(read(`SELECT count() FROM ${dataset}`), stack, dataset);
  // a span of the vault's outbound fetch can hold a secret's value: the vault's spans stay out
  assert.deepEqual(read("SELECT count() FROM logs.traces"), OWN);
  assert.match(
    storeQuery("SELECT count() FROM logs.traces", { ...scope, logs: stack }, 24, NOW).query,
    /WHERE \(serviceName IN \(\$itx_worker_0, \$itx_worker_1\) AND startTime >= \$itx_since\) AND \(TRUE\)/,
  );
});

const refusedWith = (sql: string, words: RegExp, hours?: number) =>
  assert.throws(
    () => cut(sql, hours),
    (error: unknown) => errorCode(error) === "INVALID_INPUT" && words.test(String(error)),
  );

void test("the cut is the left side of an AND whose right side is the caller's whole WHERE, an OR in it", () => {
  const run = cut(
    "SELECT level, count() AS n FROM logs.workersLogs WHERE (level = 'error') OR (1 = 1) GROUP BY level HAVING count() > 0 ORDER BY n DESC",
  );
  assert.equal(
    run.query,
    `SELECT level, count() AS n FROM logs.workersLogs WHERE (scriptName IN ($itx_worker_0, $itx_worker_1) AND timestamp >= $itx_since) AND ((level = 'error') OR (1 = 1)) GROUP BY level HAVING count() > 0 ORDER BY n DESC LIMIT 1000`,
  );
  assert.deepEqual(run.params, {
    itx_since: "2026-11-21T12:00:00.000Z",
    itx_worker_0: "iterate-example-com-mind",
    itx_worker_1: "iterate-example-com-boundary",
  });
  assert.equal(run.dataset, "logs.workersLogs");
});

void test("a query with no WHERE gets one, the cut AND TRUE, before its GROUP BY, and the caller's text stays as written", () => {
  assert.equal(
    cut(
      "SELECT serviceName, quantileWeighted(0.95, durationMs, sampleInterval) AS p95 FROM logs.traces AS t GROUP BY serviceName HAVING count() >= 10 LIMIT 5",
    ).query,
    "SELECT serviceName, quantileWeighted(0.95, durationMs, sampleInterval) AS p95 FROM logs.traces AS t WHERE (serviceName IN ($itx_worker_0, $itx_worker_1) AND startTime >= $itx_since) AND (TRUE) GROUP BY serviceName HAVING count() >= 10 LIMIT 5",
  );
  assert.equal(
    cut("SELECT count() FROM logs.issues WHERE timestamp >= NOW() - INTERVAL '1' HOUR").query,
    "SELECT count() FROM logs.issues WHERE (scriptName IN ($itx_worker_0, $itx_worker_1) AND timestamp >= $itx_since) AND (timestamp >= NOW() - INTERVAL '1' HOUR) LIMIT 1000",
  );
});

void test("`metrics` reads the stack's own Analytics Engine dataset, cut by time alone", () => {
  const run = cut("SELECT blob1 AS name, count() AS points FROM metrics GROUP BY name", 1);
  assert.equal(
    run.query,
    'SELECT blob1 AS name, count() AS points FROM events.analyticsEngine."iterate_example_com_metrics" WHERE (timestamp >= $itx_since) AND (TRUE) GROUP BY name LIMIT 1000',
  );
  assert.deepEqual(run.params, { itx_since: "2026-11-22T11:00:00.000Z" });
});

void test("at most 1,000 rows: a larger LIMIT comes down, a smaller one stays, none gets one", () => {
  const from = `FROM events.workersInvocations WHERE (scriptName IN ($itx_worker_0, $itx_worker_1) AND timestamp >= $itx_since) AND (TRUE)`;
  assert.equal(
    cut("SELECT status FROM events.workersInvocations LIMIT 5000 OFFSET 2").query,
    `SELECT status ${from} LIMIT 1000 OFFSET 2`,
  );
  assert.equal(
    cut("SELECT status FROM events.workersInvocations LIMIT 10").query,
    `SELECT status ${from} LIMIT 10`,
  );
  assert.equal(
    cut("SELECT status FROM events.workersInvocations OFFSET 3 ").query,
    `SELECT status ${from} OFFSET 3 LIMIT 1000`,
  );
});

void test("hours: whole, from 1 to 168 over the 7-day logs and to 768 over the rest", () => {
  for (const dataset of ["logs.workersLogs", "logs.traces", "logs.issues"]) {
    assert.ok(cut(`SELECT count() FROM ${dataset}`, 168));
    refusedWith(`SELECT count() FROM ${dataset}`, /from 1 to 168/, 169);
  }
  for (const dataset of ["events.workersInvocations", "metrics"]) {
    assert.ok(cut(`SELECT count() FROM ${dataset}`, 768));
    refusedWith(`SELECT count() FROM ${dataset}`, /from 1 to 768/, 769);
  }
  refusedWith("SELECT count() FROM logs.traces", /whole number/, 0);
  refusedWith("SELECT count() FROM logs.traces", /whole number/, 1.5);
});

void test("each refusal says what is not supported", () => {
  for (const [sql, words] of [
    ["SELECT 1 FROM logs.traces; SELECT 2 FROM logs.traces", /`;`/],
    ["SELECT 1 FROM logs.traces -- x", /a comment/],
    ["SELECT 1 /* x */ FROM logs.traces", /a comment/],
    ["SELECT 1 FROM logs.traces # x", /`#`/],
    ["SELECT 1 FROM logs.traces WHERE url = 'a\\'", /backslash/],
    ["SELECT `url` FROM logs.traces", /backtick/],
    ["SELECT url FROM logs.traces WHERE startTime >= $itx_since", /parameter/],
    ["SELECT url FROM logs.traces WHERE traceId = $1", /parameter/],
    ["SELECT t.url FROM logs.traces t JOIN logs.workersLogs l ON l.traceId = t.traceId", /a JOIN/],
    ["SELECT url FROM logs.traces, logs.workersLogs", /a JOIN/],
    ["SELECT url FROM logs.traces UNION SELECT url FROM logs.workersLogs", /a UNION/],
    [
      "SELECT url FROM logs.traces WHERE traceId IN (SELECT traceId FROM logs.issues)",
      /a subquery/,
    ],
    ["SELECT n FROM (SELECT count() AS n FROM logs.traces) AS t", /a subquery/],
    ["SELECT (SELECT 1 FROM logs.issues) AS x FROM logs.traces", /a subquery/],
    ["WITH x AS (SELECT 1 FROM logs.traces) SELECT * FROM x", /anything but one SELECT/],
    ["SELECT count() FROM events.httpRequests", /names none of Cloudflare's datasets/],
    ['SELECT count() FROM events.analyticsEngine."someone_elses"', /Syntax error/],
    ["SELECT count() FROM logs.workerslogs", /names none of Cloudflare's datasets/],
    ["SELECT 'x' AS scriptName FROM logs.workersLogs", /alias named scriptname/],
    ["SELECT now() AS StartTime FROM logs.traces", /alias named starttime/],
    ["SELECT 1 FROM logs.workersLogs AS timestamp", /alias named timestamp/],
    ["SELECT 1 FROM logs.traces LIMIT ALL", /Unexpected end of input/],
  ] as const)
    refusedWith(sql, words);
});

void test("the cut holds whatever the WHERE's parentheses: the clause runs to its last `)`", () => {
  assert.equal(
    cut("SELECT 1 FROM logs.traces WHERE ((spanName = 'a') OR (spanName = ')'))").query,
    "SELECT 1 FROM logs.traces WHERE (serviceName IN ($itx_worker_0, $itx_worker_1) AND startTime >= $itx_since) AND (((spanName = 'a') OR (spanName = ')'))) LIMIT 1000",
  );
});

void test("an INTERVAL with a plural unit keeps every place: the cut and the LIMIT land where they belong", () => {
  for (const unit of ["HOURS", "DAYS", "HOUR", "DAY"])
    assert.equal(
      cut(
        `SELECT level FROM logs.workersLogs WHERE timestamp >= NOW() - INTERVAL '2' ${unit} AND level = 'error' ORDER BY level LIMIT 5000`,
      ).query,
      `SELECT level FROM logs.workersLogs WHERE (scriptName IN ($itx_worker_0, $itx_worker_1) AND timestamp >= $itx_since) AND (timestamp >= NOW() - INTERVAL '2' ${unit} AND level = 'error') ORDER BY level LIMIT 1000`,
    );
});

void test("the proof reads the text that is sent: the right operand is the caller's condition, exactly", () => {
  const sql = "SELECT 1 FROM logs.traces WHERE ((spanName = 'a') OR (spanName = 'b'))";
  const run = cut(sql);
  const table = "logs.traces";
  const tableAt = sql.indexOf(table);
  const cutText = `serviceName IN ($itx_worker_0, $itx_worker_1) AND startTime >= $itx_since`;
  const theirs = "((spanName = 'a') OR (spanName = 'b'))";
  assert.doesNotThrow(() =>
    proveTheCut(run.query, run.params, { cut: cutText, theirs, table, tableAt }),
  );
  const notTheCut = (
    query: string,
    params = run.params,
    expected = { cut: cutText, theirs, table, tableAt },
  ) =>
    assert.throws(
      () => proveTheCut(query, params, expected),
      (error: unknown) =>
        errorCode(error) === "INVALID_INPUT" && /cut in place/.test(String(error)),
    );
  // a right operand that is not the caller's
  notTheCut(run.query.replace("spanName = 'b'", "TRUE"));
  // the caller's condition lifted beside the cut with an OR
  notTheCut(run.query.replace("since) AND (", "since) OR ("));
  // a parameter that the run does not set
  notTheCut(run.query.replace("$itx_worker_1", "$itx_worker_2"));
  // a parameter that the cut names and the run does not set
  notTheCut(run.query, { itx_since: "x", itx_worker_0: "x" });
  // another dataset
  notTheCut(run.query.replace("FROM logs.traces", "FROM logs.issues"));
  // the table one place off from where the FROM stands
  notTheCut(run.query, run.params, { cut: cutText, theirs, table, tableAt: tableAt + 1 });
  // with no condition the right operand is TRUE
  const bare = cut("SELECT 1 FROM logs.traces");
  assert.doesNotThrow(() =>
    proveTheCut(bare.query, bare.params, { cut: cutText, theirs: "TRUE", table, tableAt }),
  );
  notTheCut(bare.query.replace("AND (TRUE)", "AND (1 = 1)"), bare.params, {
    cut: cutText,
    theirs: "TRUE",
    table,
    tableAt,
  });
});

void test("`metrics`: the proof reads the exact final FROM, and a string that holds the dataset's name stays as written", () => {
  const physical = 'events.analyticsEngine."iterate_example_com_metrics"';
  const sql = "SELECT count() FROM metrics WHERE blob1 = 'iterate_example_com_metrics'";
  const run = cut(sql);
  assert.equal(
    run.query,
    `SELECT count() FROM ${physical} WHERE (timestamp >= $itx_since) AND (blob1 = 'iterate_example_com_metrics') LIMIT 1000`,
  );
  const expected = {
    cut: "timestamp >= $itx_since",
    theirs: "blob1 = 'iterate_example_com_metrics'",
    table: physical,
    tableAt: sql.indexOf("metrics"),
  };
  assert.doesNotThrow(() => proveTheCut(run.query, run.params, expected));
  const notTheCut = (query: string, table = expected.table, tableAt = expected.tableAt) =>
    assert.throws(
      () => proveTheCut(query, run.params, { ...expected, table, tableAt }),
      (error: unknown) => errorCode(error) === "INVALID_INPUT",
    );
  // the short name, with the qualifier gone from the FROM
  notTheCut(
    run.query.replace(`FROM ${physical}`, 'FROM analyticsEngine."iterate_example_com_metrics"'),
  );
  notTheCut(run.query.replace(`FROM ${physical}`, "FROM metrics"));
  // another dataset in the FROM, the stack's own name in a string beside it
  notTheCut(run.query.replace('iterate_example_com_metrics"', 'someone_elses_metrics"'));
  // the FROM read one place off, and a table name that runs on past the dataset's
  notTheCut(run.query, physical, expected.tableAt + 1);
  notTheCut(run.query.replace(`${physical} WHERE`, `${physical}.x WHERE`));
});

void test("Telemetry.query reads `metrics` on the binding with no token, and says Cloudflare's refusal in its own words", async () => {
  const calls: unknown[] = [];
  let answer: () => Promise<unknown> = async () => ({ data: [{ n: 3 }], rows: 1, statistics: {} });
  const env = {
    ...stackVariables(),
    ANALYTICS: {
      query: (request: unknown) => {
        calls.push(request);
        return answer();
      },
    },
  };
  const telemetry = new (Telemetry as any)({}, env);
  const read = await telemetry.query("SELECT count() AS n FROM metrics", 1);
  assert.deepEqual(read.rows, [{ n: 3 }]);
  assert.equal(read.dataset, "metrics");
  assert.match(read.sql, /FROM events\.analyticsEngine\."iterate_example_com_metrics" WHERE/);
  assert.equal(read.notice, undefined);
  assert.equal(calls.length, 1);

  // a table query with no token answers no rows and the notice, which names Cloudflare's own
  // datasets, and the binding is not asked
  const tables = await telemetry.query("SELECT count(*) FROM events", 1);
  assert.deepEqual(Object.keys(tables).sort(), ["notice", "rows", "sql"]);
  assert.deepEqual(tables.rows, []);
  assert.match(tables.notice, /telemetry tables are off on this stack: query Cloudflare's own/);
  assert.equal(calls.length, 1);

  answer = async () => ({ data: Array.from({ length: 1_000 }, (_, n) => ({ n })), rows: 1_000 });
  assert.equal((await telemetry.query("SELECT 1 AS n FROM logs.traces")).truncated, true);

  // over 8 MiB of JSON: refused, with no rows
  answer = async () => ({ data: [{ text: "x".repeat(8 * 1024 * 1024) }], rows: 1 });
  await assert.rejects(
    telemetry.query("SELECT message AS text FROM logs.workersLogs"),
    (error: unknown) =>
      errorCode(error) === "INVALID_INPUT" && /select fewer columns or rows/.test(String(error)),
  );

  const logged: unknown[] = [];
  const log = console.log;
  console.log = (line: unknown) => logged.push(line);
  try {
    // each refusal that the proofs met, in a fixed sentence; Cloudflare's own words never go on
    for (const [words, ours] of [
      [
        "Input was invalid: MAX is not supported on sampled datasets. Use APPROX_MAX",
        /use APPROX_MAX$/,
      ],
      [
        "Input was invalid: MIN is not supported on sampled datasets. Use APPROX_MIN",
        /use APPROX_MIN$/,
      ],
      [
        "Input was invalid: unknown column `someone_elses`",
        /a column that the dataset does not have/,
      ],
      ["Input was invalid: function `path` is not supported", /a function that Cloudflare's/],
      [
        "Resource limit: query time range exceeds the maximum duration of 2764800 seconds",
        /a time range over what one query of this dataset reads/,
      ],
      [
        "Input was invalid: subqueries are not supported; use a single-dataset query",
        /a subquery is not supported/,
      ],
      [
        "Input was invalid: iterate-other-com-mind did a thing",
        /refused the query \(Cloudflare's code 1234\)/,
      ],
    ] as const) {
      answer = async () => {
        throw Object.assign(new Error(words), { retryable: false, code: 1234 });
      };
      await assert.rejects(telemetry.query("SELECT 1 FROM logs.traces"), (error: unknown) => {
        const text = String((error as Error).message);
        return (
          errorCode(error) === "INVALID_INPUT" &&
          ours.test(text.replace(/ \(docs\/telemetry\.md\)$/, "")) &&
          !text.includes(words) &&
          !text.includes("someone_elses") &&
          !text.includes("iterate-other-com-mind")
        );
      });
    }
    // a failure that may pass asked again keeps workerd's stamp, and says no words of Cloudflare's
    answer = async () => {
      throw Object.assign(new Error("upstream iterate-other-com-mind is slow"), {
        retryable: true,
        code: 5678,
      });
    };
    await assert.rejects(
      telemetry.query("SELECT 1 FROM logs.traces"),
      (error: unknown) =>
        errorCode(error) === undefined &&
        (error as { retryable?: unknown }).retryable === true &&
        (error as Error).message ===
          "itx.telemetry.query: Cloudflare's Analytics SQL did not answer (Cloudflare's code 5678)",
    );
  } finally {
    console.log = log;
  }
  // the log line names the codes alone
  const lines = JSON.stringify(logged);
  assert.ok(!lines.includes("iterate-other-com-mind") && !lines.includes("someone_elses"));
  assert.deepEqual(
    logged.slice(-2).map((line) => {
      const { outcome, cloudflareCode } = line as { outcome: unknown; cloudflareCode: unknown };
      return { outcome, cloudflareCode };
    }),
    [
      { outcome: "INVALID_INPUT", cloudflareCode: 1234 },
      { outcome: "failed", cloudflareCode: 5678 },
    ],
  );
});

void test("Telemetry.query over the tables says R2 SQL's refusal in a fixed sentence: its status and code, none of its words", async () => {
  const env = { ...stackVariables(), ITERATE__CATALOG_TOKEN: "the-catalog-token" };
  const telemetry = new (Telemetry as any)({}, env);
  const words = "invalid query: column iterate-other-com-mind not found";
  const fetched = globalThis.fetch;
  const logged: unknown[] = [];
  const log = console.log;
  console.log = (line: unknown) => logged.push(line);
  try {
    for (const [status, ours, code] of [
      [
        400,
        /^itx\.telemetry\.query: R2 SQL refused the query \(HTTP 400, Cloudflare's code 40001\)/,
        "INVALID_INPUT",
      ],
      [
        503,
        /^itx\.telemetry\.query: R2 SQL did not answer \(HTTP 503, Cloudflare's code 40001\)$/,
        undefined,
      ],
    ] as const) {
      globalThis.fetch = async () =>
        Response.json({ success: false, errors: [{ code: 40001, message: words }] }, { status });
      await assert.rejects(
        telemetry.query("SELECT count(*) FROM events", 1),
        (error: unknown) =>
          errorCode(error) === code &&
          ours.test((error as Error).message) &&
          !(error as Error).message.includes("iterate-other-com-mind"),
      );
    }
  } finally {
    globalThis.fetch = fetched;
    console.log = log;
  }
  assert.ok(!JSON.stringify(logged).includes("iterate-other-com-mind"));
  assert.deepEqual(
    logged.map((line) => (line as { cloudflareCode?: unknown }).cloudflareCode),
    [40001, 40001],
  );
});

function stackVariables() {
  return {
    ITERATE: JSON.stringify({
      mindId: "a".repeat(64),
      controlPlaneHostname: "iterate.example.com",
      zones: ["example.com"],
      ownerEmails: ["ada@example.org"],
      topology: "full-cloudflare",
      accountId: "the-account-id",
      telemetryBucketName: "iterate-example-com-telemetry",
      metricsDatasetName: "iterate_example_com_metrics",
      workerNamesThatQueriesReadWhole: ["iterate-example-com-mind", "iterate-example-com-boundary"],
      workerNamesWhoseLogsQueriesRead: ["iterate-example-com-mind", "iterate-example-com-boundary"],
      eventsWriterName: "iterate-example-com-mind",
    }),
    ITERATE__OTLP_SECRET: "the-otlp-secret",
  };
}
