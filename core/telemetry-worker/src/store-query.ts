// store-query.ts — A QUERY OVER CLOUDFLARE'S OWN DATASETS, cut to the mind's own rows. The caller
// writes Cloudflare's Analytics SQL with Cloudflare's names, and it runs on the Analytics SQL
// binding (./rpc.ts), which needs no token and reads the whole account. This file checks that the
// query is one SELECT over one dataset of `TELEMETRY_DATASETS`, and puts the cut into the caller's
// own text by position, so the rest reads as the caller wrote it:
//
//   WHERE (<worker column> IN ($itx_worker_0, …) AND <time column> >= $itx_since) AND (<theirs>)
//
// WHY THE CUT HOLDS: the cut and the caller's whole WHERE are two parenthesized operands of one
// AND, and the SQL that runs is parsed again to prove it. GROUP BY and HAVING act on the rows that
// WHERE keeps. There is no subquery, JOIN, UNION or CTE to read rows past it. The values are named
// parameters, and a caller's SQL may hold no `$`, so it can set none of them. Text where Cloudflare
// and this parser might read different statements is refused: a comment, a backslash, a backtick.
// An alias may not take a cut column's name. (Cloudflare refuses a derived table, so the cut cannot
// be one: "subqueries are not supported", 22 Nov 2026.)
import { parse, toSql, type Statement } from "pgsql-ast-parser";
import { TELEMETRY_DATASETS, type TelemetryDataset } from "iterate/api";
import { codedError } from "iterate/lib";
import { MAX_ROWS } from "./query.ts";

/** Each dataset's column that names the Worker, its time column, and the most hours back that one
 *  query reads: Cloudflare keeps 7 days of the logs, and of the 90 days it keeps of the others one
 *  query reads 2,764,800 seconds, 32 days (measured 22 Nov 2026). Every row of `metrics`, the
 *  stack's own Analytics Engine dataset, is the mind's. */
const DATASETS: Record<TelemetryDataset, { worker?: string; time: string; maxHours: number }> = {
  "logs.workersLogs": { worker: "scriptName", time: "timestamp", maxHours: 168 },
  "logs.traces": { worker: "serviceName", time: "startTime", maxHours: 168 },
  "logs.issues": { worker: "scriptName", time: "timestamp", maxHours: 168 },
  "events.workersInvocations": { worker: "scriptName", time: "timestamp", maxHours: 768 },
  metrics: { time: "timestamp", maxHours: 768 },
};

const SQL_MAX_CHARS = 20_000;

/** Marks that the caller's SQL may not hold anywhere, strings included: what each is, and what
 *  to write instead. */
const REFUSED_MARKS: [string, string, string?][] = [
  [";", "a `;` or a second statement"],
  ["--", "a comment"],
  ["/*", "a comment"],
  ["#", "a `#`", "Cloudflare may read it as a comment"],
  ["\\", "a backslash", "write a quote in a string twice ('')"],
  ["`", "a backtick", 'quote a name with ""'],
  ["$", "a parameter (`$`)", "write the value into the SQL; the `$itx_` parameters are the cut's"],
];

/** The node types a query may hold below its one SELECT (pgsql-ast-parser's syntax/ast.ts). A
 *  nested `select`, `union`, `with` or `statement` is a subquery, so it is not here. */
const ALLOWED = new Set([
  "table",
  "ref",
  "binary",
  "unary",
  "call",
  "cast",
  "case",
  "ternary",
  "extract",
  "member",
  "arrayIndex",
  "keyword",
  "substring",
  "overlay",
  "list",
  "array",
  "integer",
  "numeric",
  "string",
  "boolean",
  "null",
  "parameter",
]);

/** The SQL that runs on the Analytics SQL binding, its parameters, and the dataset it reads. */
export type StoreRun = {
  dataset: TelemetryDataset;
  query: string;
  params: Record<string, string>;
};

export function storeQuery(
  sql: unknown,
  {
    own,
    logs,
    metricsDataset,
  }: { own: readonly string[]; logs: readonly string[]; metricsDataset: string },
  hours = 24,
  now = Date.now(),
): StoreRun {
  if (typeof sql !== "string" || sql.length > SQL_MAX_CHARS)
    throw refused(`a query is a string of at most ${SQL_MAX_CHARS} characters`);
  for (const [mark, what, hint] of REFUSED_MARKS) if (sql.includes(mark)) refuse(what, hint);
  const select = parsedSelect(sql);
  const [from] = select.from || [];
  const start = from?._location?.start ?? 0;
  const dataset = TELEMETRY_DATASETS.find((name) =>
    new RegExp(`^${name.replace(".", "\\.")}(?![\\w.])`).test(sql.slice(start)),
  );
  if (from?.type !== "table" || !dataset)
    throw refused(
      `the FROM names none of Cloudflare's datasets that a query reads (${TELEMETRY_DATASETS.join(", ")}), written as Cloudflare writes it`,
    );
  const { worker, time, maxHours } = DATASETS[dataset];
  if (!Number.isInteger(hours) || hours < 1 || hours > maxHours)
    throw refused(`hours over ${dataset} is a whole number from 1 to ${maxHours}`);
  if (!/^\w+$/.test(metricsDataset))
    throw new Error(`metricsDatasetName ${JSON.stringify(metricsDataset)} is not a plain name`);
  const cutColumns = [worker, time].flatMap((column) => (column ? [column.toLowerCase()] : []));
  const aliases = [
    from.name.alias,
    ...(select.columns || []).map((column) => column.alias?.name),
  ].filter((alias): alias is string => Boolean(alias));
  const shadow = aliases.find((alias) => cutColumns.includes(alias.toLowerCase()));
  if (shadow) refuse(`an alias named ${shadow}`, "the cut reads a column of that name");

  const params: Record<string, string> = {
    itx_since: new Date(now - hours * 3_600_000).toISOString(),
  };
  // WHOSE ROWS: of the spans, the mind's own Workers'; of every other dataset, the whole stack's
  // (./config.ts `workerNamesWhoseLogsQueriesRead` says why the spans stay out)
  const names = dataset === "logs.traces" ? own : logs;
  if (worker) names.forEach((name, index) => (params[`itx_worker_${index}`] = name));
  const ownList = names.map((_name, index) => `$itx_worker_${index}`).join(", ");
  const cut = worker
    ? `${worker} IN (${ownList}) AND ${time} >= $itx_since`
    : `${time} >= $itx_since`;

  // Edits by position on the caller's own text. The WHERE is always one AND of two operands: the
  // cut, and the caller's condition, or TRUE when there is none.
  const edits: { at: number; end: number; text: string }[] = [];
  const table = dataset === "metrics" ? `events.analyticsEngine."${metricsDataset}"` : dataset;
  if (dataset === "metrics") edits.push({ at: start, end: start + "metrics".length, text: table });
  const fromEnd = from._location!.end;
  let theirs = "TRUE";
  if (select.where) {
    const keyword = /^\s+WHERE\b/i.exec(sql.slice(fromEnd, select.where._location!.start));
    if (!keyword) refuse("a WHERE that reads back otherwise");
    const clauseStart = fromEnd + keyword[0].length;
    // The parser places `(a) OR (b)` at `a) OR (b`: the clause runs on to its last `)`.
    let clauseEnd = select.where._location!.end;
    while (depth(sql.slice(clauseStart, clauseEnd)) > 0) {
      const close = /^\s*\)/.exec(sql.slice(clauseEnd));
      if (!close) refuse("a WHERE whose parentheses do not close");
      clauseEnd += close[0].length;
    }
    theirs = sql.slice(clauseStart, clauseEnd).trim();
    edits.push({ at: clauseStart, end: clauseEnd, text: ` (${cut}) AND (${theirs})` });
  } else edits.push({ at: fromEnd, end: fromEnd, text: ` WHERE (${cut}) AND (${theirs})` });
  const limit = select.limit?.limit;
  if (!limit) edits.push({ at: sql.trimEnd().length, end: sql.length, text: ` LIMIT ${MAX_ROWS}` });
  else if (limit.type !== "integer") refuse("a LIMIT that is not a whole number");
  else if (limit.value > MAX_ROWS)
    edits.push({ at: limit._location!.start, end: limit._location!.end, text: `${MAX_ROWS}` });
  let query = sql;
  // from the last place; at one place, the later edit first, so the earlier one comes before it
  for (const edit of edits
    .map((e, order) => ({ ...e, order }))
    .sort((a, b) => b.at - a.at || b.order - a.order))
    query = query.slice(0, edit.at) + edit.text + query.slice(edit.end);

  // the table stands at `start` in the text that is sent too: every other edit comes after it
  proveTheCut(query, params, {
    cut,
    theirs: select.where ? toSql.expr(select.where) : "TRUE",
    table,
    tableAt: start,
  });
  return { dataset, query, params };
}

/** The one SELECT of `sql`, its subtree checked. Cloudflare writes `INTERVAL '1' HOUR`, which the
 *  parser does not read: it reads `INTERVAL '1 HOUR'`, and `'2' HOURS` as `'2 HOURS'`, the same
 *  length, so every place holds. */
function parsedSelect(sql: string): Statement & { type: "select" } {
  const readable = sql.replace(
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|\b(INTERVAL\s+)'(\d+)'(\s+)((?:SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?)\b/gi,
    (match, keyword?: string, count?: string, space?: string, unit?: string) =>
      keyword ? `${keyword}'${count}${space}${unit}'` : match,
  );
  if (readable.length !== sql.length) throw new Error("the parser's reading changed the length");
  let statements: Statement[];
  try {
    statements = parse(readable, { locationTracking: true });
  } catch (error) {
    throw refused(String(error instanceof Error ? error.message : error).split("\n")[0]!);
  }
  const [statement] = statements;
  if (statements.length !== 1 || statement?.type !== "select")
    refuse(
      statement?.type === "union" || statement?.type === "union all"
        ? "a UNION"
        : "anything but one SELECT",
    );
  if ((statement.from?.length ?? 0) > 1 || statement.from?.[0]?.join) refuse("a JOIN");
  check(statement, true);
  return statement;
}

// every property of every node, so no clause can hide a subquery
function check(node: unknown, root = false): void {
  if (Array.isArray(node)) return node.forEach((child) => check(child));
  if (!(node instanceof Object)) return;
  const { type } = node as { type?: unknown };
  if (!root && type !== undefined) {
    if (type === "select" || type === "statement") refuse("a subquery");
    if (type === "union" || type === "union all") refuse("a UNION");
    if (type === "with" || type === "with recursive") refuse("a CTE (WITH)");
    if (typeof type !== "string" || !ALLOWED.has(type)) refuse(String(type).toUpperCase());
  }
  for (const [key, value] of Object.entries(node)) if (key !== "_location") check(value);
}

/** THE PROOF, ON THE TEXT THAT IS SENT. `query` is parsed as it goes to the binding. For the
 *  parser alone, two things are read otherwise, each by position and in the same number of
 *  characters, so every place in the parsed text is the same place in `query`: each `$itx_`
 *  parameter as `$1`…, in the order of `params` (a caller's SQL holds no `$`, so every `$` is the
 *  cut's), and the table at `tableAt`, which must be exactly `table` in `query`: the metrics
 *  dataset `events.analyticsEngine."…"` as `analyticsEngine."…"`, since the parser reads no
 *  three-part name. Nothing else is replaced, so a string that holds the dataset's name stays as
 *  written. It is refused unless the parsed FROM is the one table and starts at `tableAt`, its WHERE
 *  is one AND whose left operand is `cut` exactly and whose right operand is exactly the caller's
 *  own condition (`theirs`, as the parser prints it, or TRUE), with a LIMIT of at most MAX_ROWS. */
export function proveTheCut(
  query: string,
  params: Readonly<Record<string, string>>,
  { cut, theirs, table, tableAt }: { cut: string; theirs: string; table: string; tableAt: number },
) {
  const names = Object.keys(params).map((name) => `$${name}`);
  let unknown = false;
  const positional = (text: string, pad: boolean) =>
    text.replace(/\$itx_\w+/g, (name) => {
      const at = names.indexOf(name);
      if (at === -1) unknown = true;
      return `$${at + 1}`.padEnd(pad ? name.length : 0);
    });
  const tableEnd = tableAt + table.length;
  if (query.slice(tableAt, tableEnd) !== table || /[\w."]/.test(query[tableEnd] ?? ""))
    refuse("a query that does not read back with the cut in place");
  const metrics = /^events\.analyticsEngine\.("\w+")$/.exec(table);
  const standIn = (metrics ? `analyticsEngine.${metrics[1]}` : table).padEnd(table.length);
  const select = parsedSelect(
    positional(query.slice(0, tableAt) + standIn + query.slice(tableEnd), true),
  );
  const expr = (text: string) => toSql.expr(parse(positional(text, false), "expr"));
  const where = select.where;
  const from = select.from?.length === 1 ? select.from[0] : undefined;
  const read = from?.type === "table" ? from.name : undefined;
  const [schema, name] = metrics ? ["analyticsengine", metrics[1]!.slice(1, -1)] : table.split(".");
  const limit = select.limit?.limit;
  if (
    unknown ||
    read?._location?.start !== tableAt ||
    read.schema !== schema?.toLowerCase() ||
    read.name !== (metrics ? name : name?.toLowerCase()) ||
    where?.type !== "binary" ||
    where.op !== "AND" ||
    toSql.expr(where.left) !== expr(cut) ||
    toSql.expr(where.right) !== expr(theirs) ||
    limit?.type !== "integer" ||
    limit.value > MAX_ROWS
  )
    refuse("a query that does not read back with the cut in place");
}

/** How many parentheses `text` leaves open, outside its strings and quoted names. */
function depth(text: string) {
  let open = 0;
  for (const [token] of text.matchAll(/'(?:[^']|'')*'|"(?:[^"]|"")*"|[()]/g))
    open += token === "(" ? 1 : token === ")" ? -1 : 0;
  return open;
}

function refuse(what: string, hint?: string): never {
  throw refused(`${what} is not supported${hint ? `: ${hint}` : ""}`);
}

function refused(why: string) {
  return codedError(
    "INVALID_INPUT",
    `itx.telemetry.query: ${why} (one SELECT over one of Cloudflare's datasets, ${TELEMETRY_DATASETS.join(", ")}; docs/telemetry.md)`,
  );
}
