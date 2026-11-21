// telemetry.ts — THE MIND'S TELEMETRY TABLES, TURNED ON AND READ BY THE MIND ITSELF
// (onboarding/telemetry.md). A mind deployed with no telemetry token has a bucket and three
// streams, which keep every event, log and span they are sent, and no tables. With one API token
// of the account, kept as the secret below, the mind makes the tables and reads them:
//
//   telemetryToken    the two links a member needs to make the token and give it
//   telemetryTurnOn   the bucket's data catalog, and each table's sink and pipeline
//   telemetryQuery    `itx.telemetry.query`, sent with the token when the stack holds none
//
// The built-in query (`itx.telemetry.cut`) cuts each query to this mind's rows and, with no token in
// the stack, answers where the query would go (`send`). This file sends it. After the turn-on,
// `itx.telemetry.query` is this file's `telemetryQuery`. The token is the mind's own, so the cut is
// a convenience here, not a boundary. Every request goes through `itx.fetch`: each use of the
// secret is recorded, and an approval rule of the secret holds it.
import type { IterateContextApi } from "iterate/api";
import { errorCode } from "iterate/lib";
import { z } from "zod";

const TELEMETRY_SECRET = "/secrets/cloudflare-telemetry";
const BEARER = `Bearer getSecret("${TELEMETRY_SECRET}")`;
/** Cloudflare's form for a new API token of the account, with the five permissions of the whole
 *  account filled in by their permission group ids, which a template link for an account token
 *  takes (https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/).
 *  The sixth, "Workers R2 Storage Bucket Item Write", is a permission of a bucket: the form drops
 *  it from the link (seen on 21 Nov 2026), so a member adds it as a second policy, for the
 *  telemetry bucket alone. The Pipelines API asks for "Workers R2 Storage Write" beside
 *  "Pipelines Write" (measured on 20 Nov 2026); a member takes those two off the token once the
 *  tables are on. */
const TOKEN_LINK = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(
  JSON.stringify(
    [
      // allow-high-entropy-next-line: Cloudflare's public id of the permission group "Workers R2 Data Catalog Write"
      "d229766a2f7f4d299f20eaa8c9b1fde9",
      // allow-high-entropy-next-line: Cloudflare's public id of the permission group "Workers R2 SQL Read"
      "f45430d92e2b4a6cb9f94f2594c141b8",
      // allow-high-entropy-next-line: Cloudflare's public id of the permission group "Account Analytics Read"
      "b89a480218d04ceb98b4fe57ca29dc1f",
      // allow-high-entropy-next-line: Cloudflare's public id of the permission group "Pipelines Write"
      "e34111af393449539859485aa5ddd5bd",
      // allow-high-entropy-next-line: Cloudflare's public id of the permission group "Workers R2 Storage Write"
      "bf7481a1826f439697cb59a20b22293e",
    ].map((key) => ({ key, type: "edit" })),
  ),
)}&name=${encodeURIComponent("iterate telemetry")}`;

type TelemetryItx = Pick<
  IterateContextApi,
  "secrets" | "fetch" | "telemetry" | "cd" | "rewriteRules"
>;

/** `itx.config.telemetryToken({ again? })`: the two links a member needs, Cloudflare's form and
 *  the page of this mind that takes the token, with the `account` to pick and the `bucket` that
 *  the token's second policy names (onboarding/telemetry.md). No agent sees the token.
 *  `{ needed: false }` on a stack that holds its own telemetry token. Once it is set:
 *  `{ set: true, wide, bucket }`. As made, the token reads and writes every R2 bucket of the
 *  account, makes and deletes buckets and can set one public. `wide` says that it still reaches
 *  past the telemetry bucket: after the turn-on, ask a member to take "Pipelines Write" and
 *  "Workers R2 Storage Write" off, until `wide` is false. `again` collects it anew: the one way to replace a wrong token, since the Dash's secrets
 *  page would set it without the uses that the turn-on needs. */
export async function telemetryToken(
  itx: Pick<TelemetryItx, "secrets" | "telemetry" | "fetch">,
  options?: { again?: boolean },
) {
  const send = await whereTheTablesGo(itx);
  if (!send) return { needed: false as const };
  if (!options?.again && (await itx.secrets.describe(TELEMETRY_SECRET)).set) {
    // Two reads say how far the token still reaches: the Pipelines API
    // answers it while it holds its two wide permissions, and the mind's files bucket lists for
    // it when its bucket policy names more than the telemetry bucket.
    const reaches = async (path: string) => {
      const answer = await itx.fetch(
        new Request(`${accountUrl(send)}${path}`, {
          headers: { authorization: BEARER },
          redirect: "manual",
        }),
      );
      await answer.body?.cancel();
      // the mind's own secrets answered (a held approval, a refusal): that says nothing of reach
      const cloudflares = !answer.headers.has("x-iterate-vault-answer");
      if (cloudflares && (answer.status === 401 || answer.status === 403)) return false;
      // 404: a mind that runs elsewhere has no files bucket, and the token was let in to look
      if (cloudflares && (answer.ok || answer.status === 404)) return true;
      throw new Error(
        `telemetryToken: the token's reach is not known: ${path} answered ${answer.status}. Ask again.`,
      );
    };
    const files = send.bucket.replace(/-telemetry$/, "-files");
    const wide =
      (await reaches("/pipelines/v1/pipelines?per_page=1")) ||
      (await reaches(`/r2/buckets/${files}/objects?per_page=1`));
    return { set: true as const, wide, bucket: send.bucket };
  }
  const { url } = await itx.secrets.collectFromUser({
    path: TELEMETRY_SECRET,
    egress: { urls: ["https://api.cloudflare.com", "https://api.sql.cloudflarestorage.com"] },
    // the catalog and each sink keep the token: Cloudflare takes it as one field of these two
    // requests' JSON bodies, and it goes in no other body
    bodyFields: [
      {
        method: "POST",
        url: `${accountUrl(send)}/r2-catalog/${send.bucket}/enable`,
        field: "credential.token",
      },
      { method: "POST", url: `${accountUrl(send)}/pipelines/v1/sinks`, field: "config.token" },
    ],
    description:
      'A Cloudflare API token of the account, to make the mind\'s telemetry tables and read them. As made, it reads and writes every R2 bucket of the account, and the mind\'s own code can use it. Once the tables are on, narrow it in Cloudflare\'s dashboard: take "Pipelines Write" and "Workers R2 Storage Write" off.',
  });
  return {
    set: false as const,
    makeTheTokenAt: TOKEN_LINK,
    pasteItAt: url,
    account: send.accountId,
    bucket: send.bucket,
  };
}

/** `itx.config.telemetryTurnOn()`: the catalog of the telemetry bucket, and for each table its
 *  sink and its pipeline. Safe to call again: what is there is not made twice. */
export async function telemetryTurnOn(itx: TelemetryItx) {
  const send = await whereTheTablesGo(itx);
  if (!send) return { on: true as const };
  if (!(await itx.secrets.describe(TELEMETRY_SECRET)).set)
    throw new Error(
      `telemetryTurnOn: ${TELEMETRY_SECRET} is not set. Call itx.config.telemetryToken() first, and give a member its two links.`,
    );
  const call = async (step: string, method: string, path: string, body?: unknown) => {
    const answer = await itx.fetch(
      new Request(`${accountUrl(send)}${path}`, {
        method,
        headers: { authorization: BEARER, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        // the token goes to Cloudflare's API alone
        redirect: "manual",
      }),
    );
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `telemetryTurnOn: ${step} was refused (${answer.status}): ${text.slice(0, 300)}. It is safe to call again.`,
      );
    const read = Answer.safeParse(jsonOrUndefined(text));
    return read.data?.result;
  };
  // the catalog is turned on with the token, which it keeps; turning it on again changes nothing
  await call("enable the data catalog", "POST", `/r2-catalog/${send.bucket}/enable`, {
    credential: { token: `getSecret("${TELEMETRY_SECRET}")` },
  });
  // as core/alchemy/src/stack.ts sets `TelemetryCatalog`
  await call(
    "set the catalog's maintenance",
    "POST",
    `/r2-catalog/${send.bucket}/maintenance-configs`,
    {
      compaction: { state: "enabled" },
      snapshot_expiration: { state: "enabled", max_snapshot_age: "1d", min_snapshots_to_keep: 5 },
    },
  );
  // The names start with the bucket's, `-` written `_`: core/alchemy/src/config.ts `namesOf` spells
  // them so. `name` is a case-insensitive substring filter: one list call finds all three.
  const tables = send.bucket.replaceAll("-", "_");
  const listed = async (kind: "sinks" | "pipelines") =>
    Listed.parse(
      await call(`list ${kind}`, "GET", `/pipelines/v1/${kind}?name=${tables}&per_page=100`),
    );
  const sinks = await listed("sinks");
  const pipelines = await listed("pipelines");
  const made: string[] = [];
  for (const table of ["events", "logs", "spans"] as const) {
    const [sink, pipeline] = [`${tables}_${table}_sink`, `${tables}_${table}`];
    if (!sinks.some(({ name }) => name === sink)) {
      // as core/alchemy/src/stack.ts makes each table's sink, with the token as a whole value
      await call(`make the sink ${sink}`, "POST", "/pipelines/v1/sinks", {
        name: sink,
        type: "r2_data_catalog",
        config: {
          bucket: send.bucket,
          namespace: "telemetry",
          table_name: table,
          token: `getSecret("${TELEMETRY_SECRET}")`,
          rolling_policy: { interval_seconds: 60 },
        },
        format: { type: "parquet", compression: "zstd", row_group_bytes: 32 * 1024 * 1024 },
      });
      made.push(sink);
    }
    if (!pipelines.some(({ name }) => name === pipeline)) {
      const created = await call(
        `make the pipeline ${pipeline}`,
        "POST",
        "/pipelines/v1/pipelines",
        {
          name: pipeline,
          sql: `INSERT INTO ${sink} SELECT * FROM ${tables}_${table}_stream`,
        },
      );
      pipelines.push(...Listed.parse([created]));
      made.push(pipeline);
    }
  }
  // From now on `itx.telemetry.query`, at every context that reaches the root's rules, is
  // `telemetryQuery` with the call's arguments. Set again when a member removed it.
  const root = itx.cd("/");
  if (!(await root.rewriteRules.get("itx.telemetry.query"))?.target)
    await root.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: "itx.telemetry.query",
        target: "itx.config.telemetryQuery",
        description:
          "the mind's telemetry as SQL, read by its own code from the tables it made (core/configs/default/telemetry.ts)",
      },
    });
  // a pipeline whose status is not running shows here, before any query finds no rows
  return {
    on: true as const,
    made,
    pipelines: pipelines.filter(({ name }) => name.startsWith(`${tables}_`)),
  };
}

/** The account's address at Cloudflare's API. The token's two body fields name URLs under it
 *  exactly, so every request builds its URL from here. */
const accountUrl = (send: { accountId: string }) =>
  `https://api.cloudflare.com/client/v4/accounts/${send.accountId}`;

/** Where the tables go, as the built-in says it on a stack with no telemetry token; undefined on a
 *  stack that holds its token, which made the tables itself. */
async function whereTheTablesGo(itx: Pick<TelemetryItx, "telemetry">) {
  const cut = await itx.telemetry
    .cut("SELECT 1 FROM events LIMIT 1", { hours: 1 })
    .catch((error: unknown) => {
      if (errorCode(error) === "TELEMETRY_TOKEN_HELD") return undefined;
      throw error;
    });
  return cut?.send;
}

/** `itx.config.telemetryQuery(sql, { hours })`, which `itx.telemetry.query` is after the turn-on,
 *  on a mind whose stack holds no token. The built-in (`cut`) cuts `sql` to this mind's rows and
 *  says where to send it, and this sends it with the mind's token. */
export async function telemetryQuery(itx: TelemetryItx, sql: string, options?: { hours?: number }) {
  const { send, sql: cutSql } = await itx.telemetry.cut(sql, options);
  // as the built-in sends each: R2 SQL takes the query as JSON, Analytics Engine as the body's text
  const [url, body] =
    send.engine === "tables"
      ? [
          `https://api.sql.cloudflarestorage.com/api/v1/accounts/${send.accountId}/basin-sql/query/${send.bucket}`,
          JSON.stringify({ query: cutSql }),
        ]
      : [`${accountUrl(send)}/analytics_engine/sql`, cutSql];
  const request = new Request(url, {
    method: "POST",
    headers: { authorization: BEARER },
    body,
    redirect: "manual",
  });
  const sent = await itx.fetch(request);
  const text = await boundedText(sent);
  const read = (send.engine === "tables" ? TablesRows : MetricsRows).safeParse(
    sent.ok ? jsonOrUndefined(text) : undefined,
  );
  if (!read.success) {
    // R2 SQL's own codes (measured on 20 Nov 2026): 40006, the bucket has no catalog yet; 40010,
    // the table has no rows yet, in the first minutes after the turn-on
    const code = Refusal.safeParse(jsonOrUndefined(text)).data?.errors[0]?.code;
    if (sent.status === 404 && (code === 40006 || code === 40010))
      return {
        rows: [],
        sql: cutSql,
        notice:
          code === 40006
            ? "telemetry tables are not made yet: call itx.config.telemetryTurnOn()"
            : "this telemetry table has no rows yet: its first rows land a few minutes after the turn-on",
      };
    throw new Error(`telemetryQuery: Cloudflare answered ${sent.status}: ${text.slice(0, 300)}`);
  }
  const rows = "result" in read.data ? read.data.result.rows : read.data.data;
  // as the built-in says it: the cut holds every answer to 1,000 rows, and more may match
  return { rows, sql: cutSql, ...(rows.length >= 1000 && { truncated: true as const }) };
}

/** R2 SQL's refusal, as far as this file reads it. */
const Refusal = z.object({ errors: z.array(z.object({ code: z.number() })) });

// as the built-in reads an answer (core/telemetry-worker/src/rpc.ts)
const ANSWER_MAX_BYTES = 8 * 1024 * 1024;

async function boundedText(response: Response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let [text, bytes] = ["", 0];
  for (let next = await reader?.read(); next && !next.done; next = await reader!.read()) {
    bytes += next.value.byteLength;
    if (bytes > ANSWER_MAX_BYTES) {
      await reader!.cancel();
      throw new Error(
        `itx.telemetry.query: the answer is over ${ANSWER_MAX_BYTES} bytes: select fewer columns or rows`,
      );
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
}

function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Cloudflare's answer, as far as this file reads it. */
const Answer = z.object({ result: z.unknown() });
/** A list of sinks or pipelines; a sink has no status. */
const Listed = z.array(z.object({ name: z.string(), status: z.string().optional() }));
/** R2 SQL's rows (`result.rows`), and Analytics Engine's (`data`). */
const TablesRows = z.object({
  result: z.object({ rows: z.array(z.record(z.string(), z.unknown())) }),
});
const MetricsRows = z.object({ data: z.array(z.record(z.string(), z.unknown())) });
