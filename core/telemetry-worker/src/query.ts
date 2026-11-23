import { parse, toSql, type QNameMapped, type Statement } from "pgsql-ast-parser";
import { codedError } from "iterate/lib";

// Basin SQL bills the bytes it scans, and only `__ingest_ts`, the partition, narrows a scan.
const MAX_HOURS = 720;
/** The most rows one query answers. */
export const MAX_ROWS = 1_000;
const SQL_MAX_CHARS = 20_000;

/** The node types a query may hold (pgsql-ast-parser's syntax/ast.ts), checked on the parse and on
 *  the re-parse of what is printed. A node with no type is read through. */
const ALLOWED = new Set([
  "select",
  "table",
  "statement",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "CROSS JOIN",
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
]);

// An EXTRACT's, a SUBSTRING's or an OVERLAY's `from` is an expression, not a FROM item. The printer
// writes an EXTRACT field raw.
function check(node: Record<string, unknown>, parent: unknown, key: string | undefined) {
  const { type } = node;
  if (type === undefined) return;
  if (typeof type !== "string" || !ALLOWED.has(type)) refuse(String(type).toUpperCase());
  if (type === "call" && key === "from" && (parent as { type?: unknown })?.type === "select")
    refuse("a function in FROM");
  if (type === "extract" && !/^[a-z_]+$/i.test((node.field as { name?: unknown })?.name as string))
    refuse("an EXTRACT field that is not a word");
}

// The mind reads every log line of the stack's Workers (`logs`), and every span of its own
// (`own`); the spans of the stack's other Workers with the columns a request's detail rides in
// read as null (./config.ts says why).
const SPAN_SHAPE = [
  "timestamp",
  "worker",
  "path",
  "version_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "seq",
  "name",
  "kind",
  "status",
  "duration_ms",
  "cpu_time_ms",
  "wall_time_ms",
  "outcome",
  "entrypoint",
  "durable_object_id",
  "rpc_method",
  "http_status",
];
const SPAN_DETAIL = ["status_message", "url_path", "exception", "attributes", "attributes_bytes"];

const BASIN: Record<string, (names: { own: string; logs: string }, since: string) => string> = {
  events: (_names, since) => `SELECT * FROM telemetry.events WHERE __ingest_ts > ${since}`,
  spans: ({ own }, since) =>
    `SELECT ${SPAN_SHAPE.join(", ")}, ${SPAN_DETAIL.map((column) => `CASE WHEN worker IN (${own}) THEN ${column} END AS ${column}`).join(", ")} FROM telemetry.spans WHERE __ingest_ts > ${since}`,
  logs: ({ logs }, since) =>
    `SELECT * FROM telemetry.logs WHERE worker IN (${logs}) AND __ingest_ts > ${since}`,
};

/** Each table becomes the subquery of its cut. Cloudflare's own datasets, `metrics` among them,
 *  are ./store-query.ts's. */
export function scoped(
  sql: string,
  { own, logs }: { own: readonly string[]; logs: readonly string[] },
  hours = 24,
) {
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
    throw refused(`hours is a whole number from 1 to ${MAX_HOURS}`);
  // oxlint-disable-next-line iterate/simple-truthiness-check -- `sql` is the mind's word over RPC: a non-string is refused here, not parsed
  if (typeof sql !== "string" || sql.length > SQL_MAX_CHARS)
    throw refused(`a query is a string of at most ${SQL_MAX_CHARS} characters`);
  const since = `now() - interval '${hours} hours'`;
  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch (error) {
    throw refused(String(error instanceof Error ? error.message : error).split("\n")[0]!);
  }
  const [statement] = statements;
  if (statements.length !== 1 || statement?.type !== "select") throw refused("one SELECT only");
  const listOf = (names: readonly string[]) =>
    names.map((name) => `'${name.replaceAll("'", "''")}'`).join(", ");
  const lists = { own: listOf(own), logs: listOf(logs) };
  const inner = Object.fromEntries(
    Object.entries(BASIN).map(([table, rows]) => [table, parse(rows(lists, since))[0]!]),
  );
  // every property of every node, so no clause can hide a table
  const walk = (node: unknown, parent?: unknown, key?: string): unknown => {
    if (Array.isArray(node)) return node.map((child) => walk(child, parent, key));
    if (!(node instanceof Object)) return node;
    const { type, ...rest } = node as Record<string, unknown>;
    check(node as Record<string, unknown>, parent, key);
    if (type !== "table")
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, node, k)]));
    const { name, schema, alias, columnNames } = rest.name as QNameMapped;
    const table = !schema || schema === "telemetry" ? name : `${schema}.${name}`;
    const join = walk(rest.join, node, "join");
    if (!Object.hasOwn(inner, table)) throw refused(`no table ${table}: events, logs or spans`);
    return { type: "statement", statement: inner[table], alias: alias || name, columnNames, join };
  };
  const select = walk(statement) as Statement & { type: "select" };
  const limit = select.limit?.limit;
  const rows = limit?.type === "integer" ? Math.min(limit.value, MAX_ROWS) : MAX_ROWS;
  select.limit = { ...select.limit, limit: { type: "integer", value: rows } };
  const printed = toSql.statement(select);
  // The printer writes a few fields raw: the SQL that runs must re-parse to exactly the tree checked.
  const reread = parse(printed);
  if (reread.length !== 1 || sameTree(reread[0]) !== sameTree(select))
    throw refused("the query does not read back as written");
  const again = reread[0] as Statement & { type: "select" };
  const kept = again.limit?.limit;
  if (kept?.type !== "integer" || kept.value > MAX_ROWS) throw refused("the row limit was lost");
  const recheck = (node: unknown, parent?: unknown, key?: string): void => {
    if (Array.isArray(node)) return node.forEach((child) => recheck(child, parent, key));
    if (!(node instanceof Object)) return;
    check(node as Record<string, unknown>, parent, key);
    for (const [k, v] of Object.entries(node)) recheck(v, node, k);
  };
  recheck(again);
  const cuts = new Set(
    Object.values(inner).map((s) => JSON.stringify(parse(toSql.statement(s))[0])),
  );
  const read = tablesOutside(again, cuts);
  if (read.length > 0) throw refused(`cannot scope ${read.join(", ")}`);
  return { engine: "basin" as const, sql: printed };
}

const sameTree = (tree: unknown) =>
  JSON.stringify(tree, (_key, value: unknown) =>
    value instanceof Object && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );

function tablesOutside(node: unknown, cuts: Set<string>): string[] {
  if (!(node instanceof Object)) return [];
  const { type, name, statement, join } = node as Record<string, unknown>;
  if (type === "statement" && cuts.has(JSON.stringify(statement))) return tablesOutside(join, cuts);
  if (type === "table") return [(name as QNameMapped).name];
  return Object.values(node).flatMap((child) => tablesOutside(child, cuts));
}

function refuse(what: string): never {
  throw refused(`${what} is not supported`);
}

function refused(why: string) {
  return codedError(
    "INVALID_INPUT",
    `itx.telemetry.query: ${why} (one SELECT over events, logs and spans, or over one of Cloudflare's datasets; docs/telemetry.md)`,
  );
}
