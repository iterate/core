import { setTimeout as sleep } from "node:timers/promises";
import { projectApiUrlOf } from "iterate/project-api";
import { attempt, type Check, projectRoot } from "./lib.ts";

/** Export batches, a stream's 60 s roll and a catalog commit come before a row can be read. */
const LANDING_MS = 240_000;

type Answer = { rows: Record<string, unknown>[]; sql: string };

export async function telemetryChecks(domain: string): Promise<Check[]> {
  const token = process.env.ITERATE_PROTOTYPE_TOKEN;
  if (!token) return [];
  const root = () => projectRoot(domain, token);
  const served = JSON.stringify(await root().rewriteRules.list()).includes('"itx.telemetry"');
  if (!served)
    return [
      {
        check: "telemetry: the warehouse, metrics and traces",
        pass: true,
        detail: "skipped: the stack has no telemetry part (no itx.telemetry)",
      },
    ];
  const query = (sql: string, hours = 1) =>
    (
      root() as unknown as { telemetry: { query(sql: string, o: object): Promise<Answer> } }
    ).telemetry.query(sql, { hours });
  const until = async (sql: string, done: (rows: Answer["rows"]) => boolean) => {
    const deadline = Date.now() + LANDING_MS;
    for (;;) {
      const { rows } = await query(sql);
      if (done(rows) || Date.now() > deadline) return rows;
      await sleep(10_000);
    }
  };
  const marker = crypto.randomUUID().slice(0, 8);
  const path = `/smoke/telemetry-${marker}`;
  await root().cd(path).append({ type: "smoke/telemetry", payload: { marker } });
  const webhook = await fetch(`${projectApiUrlOf(domain)}/webhooks/smoke-trace-${marker}`, {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    body: "{}",
  });
  await webhook.body?.cancel();

  return [
    await attempt("telemetry: SELECT count(*) FROM events answers", async () => {
      const { rows } = await query("SELECT count(*) AS n FROM events", 24);
      return { pass: rows.length === 1, detail: JSON.stringify(rows[0]) };
    }),
    await attempt("telemetry: an event appended now lands in events", async () => {
      const rows = await until(
        `SELECT type, path FROM events WHERE path = '${path}'`,
        (found) => found.length > 0,
      );
      return { pass: rows.length > 0, detail: `${rows.length} rows at ${path}` };
    }),
    await attempt("telemetry: a new context's size metric reads back from metrics", async () => {
      const rows = await until(
        `SELECT count() AS n FROM metrics WHERE blob1 = 'context.size' AND blob2 = '${path}'`,
        (found) => Number(found[0]?.n) > 0,
      );
      return { pass: Number(rows[0]?.n) > 0, detail: JSON.stringify(rows[0] ?? null) };
    }),
    await attempt("telemetry: one request across the boundary, project, door, vault", async () => {
      const rows = await until(
        `SELECT trace_id, worker, count(*) AS spans FROM spans WHERE trace_id IN (SELECT trace_id FROM spans WHERE url_path LIKE '%smoke-trace-${marker}%') GROUP BY trace_id, worker`,
        (found) => found.length > 0,
      );
      const traces = new Set(rows.map((row) => row.trace_id));
      const workers = [...new Set(rows.map((row) => String(row.worker)))].sort();
      return {
        pass: rows.length > 0,
        detail:
          rows.length === 0
            ? "no span of the request landed"
            : `${traces.size === 1 ? "ONE trace" : `${traces.size} traces`} (webhook ${webhook.status}), workers: ${workers.join(", ")}`,
      };
    }),
  ];
}
