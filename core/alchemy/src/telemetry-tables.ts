// telemetry-tables.ts — THE STACK'S OWN TABLES IN ITS DATA CATALOG, and how they leave it: after a
// destroy (scripts/drop-telemetry-tables.ts says why and when), and at a deploy that turns
// telemetry on or off (scripts/deploy-stack.ts).
import { accountUrl, type Call, stillDeployed } from "./cloudflare-call.ts";
import { resourceNamesOf } from "./config.ts";

/** The Iceberg address of an account's data catalogs: the one place that drops a table. */
const CATALOG = "https://catalog.cloudflarestorage.com";
/** The tables a stack's sinks write, and their namespace (src/stack.ts `telemetryPart`). */
const TABLES = { namespace: "telemetry", names: ["events", "logs", "spans"] };

/** An object that says "this run made the bucket": a bucket is known by its name alone, and the
 *  catalog is tied to that name, so the mark is inside it. A later run that finds the mark
 *  finishes what the earlier one left. */
const MADE_HERE = "iterate-made-this-bucket-to-drop-its-tables";

/** Drops the stack's three tables, and their namespace when it then holds nothing, after a
 *  destroy; scripts/drop-telemetry-tables.ts says why then, and why nothing goes while a Worker of
 *  the stack is deployed. A destroy leaves no bucket and the catalog off, so this makes the bucket
 *  for a moment (with a mark in it), turns the catalog on, drops, and puts both back. Every answer
 *  is read: a step that Cloudflare refuses fails the run, with a line that says what may be left.
 *  Answers one line for each thing it did or left. `pause` waits between two reads of a catalog
 *  that is not on yet.
 *
 *  `when: "deploying"` is the same step for a stack that is deployed (scripts/deploy-stack.ts): a
 *  table goes only when no sink of the stack writes it. A sink is the one thing that writes a
 *  table, and Cloudflare refuses a new sink on a table that exists, so a table with no sink is
 *  left over from an earlier time telemetry was on, and nothing can write it again. A table whose
 *  sink is there stays, and so does the namespace that holds it. Such a table may hold rows (a
 *  turn-on that failed part-way, a sink that was deleted): they go with it, and the line that
 *  names the table says so. That is the price of a turn-on that works.
 *
 *  AT A DEPLOY THE MARK ALONE DOES NOT MAKE A BUCKET THIS STEP'S. A deploy with `--adopt` takes a
 *  bucket of the stack's name as the stack's own, the mark in it too, and a later run that
 *  believed the mark would empty a live bucket. So there a marked bucket is this step's only when
 *  no sink of the stack exists and it holds no table rows (`rowsIn`); else it is the stack's, and
 *  nothing in it goes. `bucketLeft` says that this step's bucket is still there: a deploy must
 *  not start then (scripts/deploy-stack.ts), or it would adopt it. */
export async function dropTelemetryTables(input: {
  accountId: string;
  name: string;
  call: Call;
  pause?: () => Promise<void>;
  when?: "destroyed" | "deploying";
}): Promise<{ failed: boolean; lines: string[]; bucketLeft?: boolean }> {
  const { accountId, name, call } = input;
  const pause = input.pause || (() => new Promise<void>((done) => setTimeout(done, 2_000)));
  const deploying = input.when === "deploying";
  if (!deploying) {
    const live = await stillDeployed(input);
    if (live.worker)
      return {
        failed: false,
        lines: [
          `The stack ${name} is still deployed (the Worker ${live.worker} is there): no table is dropped.`,
        ],
      };
    if (live.unread) return { failed: true, lines: [`${live.unread}: no table is dropped.`] };
  }

  const bucket = resourceNamesOf(name).telemetryBucket;
  const account = accountUrl(accountId);
  const catalogUrl = `${account}/r2-catalog/${bucket}`;
  const bucketUrl = `${account}/r2/buckets/${bucket}`;
  const markUrl = `${bucketUrl}/objects/${MADE_HERE}`;
  // The cast, here and below: Cloudflare's documented answer. Each field is checked where it is
  // read, and an answer without it counts as no answer.
  const catalogNow = async () => {
    const answer = await call("GET", catalogUrl);
    const found = (answer.body as { result?: { id?: string; status?: string } } | null)?.result;
    return { status: answer.status, id: found?.id, on: found?.status === "active" };
  };
  const catalog = await catalogNow();
  if (catalog.status === 404)
    return { failed: false, lines: [`${bucket} never had a data catalog: no table to drop`] };
  if (catalog.status !== 200 || !catalog.id)
    return {
      failed: true,
      lines: [
        `Cloudflare answered ${catalog.status} to GET the data catalog of ${bucket}: its tables may be left`,
      ],
    };

  // THE SINKS, at a deploy: a table that one of them writes is not left over.
  let written: string[] = [];
  if (deploying) {
    const sinks = await sinkNames(account, call);
    if ("unread" in sinks)
      return { failed: true, lines: [`${sinks.unread}: no table is dropped.`] };
    // The list is the ACCOUNT's, with the sinks of every stack in it: the exact name is what
    // keeps another stack's sink out.
    const prefix = resourceNamesOf(name).telemetryTables;
    written = TABLES.names.filter((table) => sinks.names.includes(`${prefix}_${table}_sink`));
    if (written.length === TABLES.names.length)
      return {
        failed: false,
        lines: [`The log pipelines of ${name} write its three tables: none is left over.`],
      };
  }

  const lines: string[] = [];
  let failed = false;
  // this step's own bucket is still there at the end
  let bucketLeft = false;
  const fail = (line: string) => {
    failed = true;
    lines.push(line);
  };
  const ok = (status: number) => status >= 200 && status < 300;

  // THE BUCKET: the stack's own when it is there with no mark, else one of this step's making.
  const there = await call("GET", bucketUrl);
  let madeHere = false;
  if (there.status === 404) {
    const made = await call("POST", `${account}/r2/buckets`, { name: bucket });
    if (!ok(made.status))
      return {
        failed: true,
        lines: [
          `Cloudflare answered ${made.status} to the bucket ${bucket}, made to reach its tables: the tables may be left`,
        ],
      };
    const marked = await call("PUT", markUrl, { madeBy: "drop-telemetry-tables" });
    if (!ok(marked.status)) {
      // A bucket with no mark reads as the stack's own to every later run, and it holds the name
      // against the next deploy: it goes now, while it is empty and known to be this run's.
      const undone = await call("DELETE", bucketUrl);
      return {
        failed: true,
        ...(ok(undone.status) ? {} : { bucketLeft: true }),
        lines: [
          `Cloudflare answered ${marked.status} to the mark in the bucket ${bucket}, made to reach its tables: the tables may be left`,
          ok(undone.status)
            ? `Removed again: the bucket ${bucket}`
            : `NOT removed: the bucket ${bucket}, which this step made and could not mark (Cloudflare answered ${undone.status}). Remove it by hand before the next deploy: no later run takes it as its own.`,
        ],
      };
    }
    madeHere = true;
  } else if (there.status === 200) {
    // an earlier run of this step that could not remove its bucket left the mark in it
    const mark = await call("GET", markUrl);
    if (mark.status !== 200 && mark.status !== 404)
      return {
        failed: true,
        lines: [
          `Cloudflare answered ${mark.status} to GET the mark in the bucket ${bucket}: whose bucket it is stays unknown, and its tables may be left`,
        ],
      };
    madeHere = mark.status === 200;
    if (madeHere && deploying) {
      // the mark alone is not enough here: see the head comment
      const rows = written.length > 0 ? false : await rowsIn(bucketUrl, call);
      if (rows === "unread")
        return {
          failed: true,
          lines: [
            `The bucket ${bucket} has this step's mark, and Cloudflare did not list what else it holds: whose bucket it is stays unknown, and nothing in it goes. Its tables may be left.`,
          ],
        };
      if (written.length > 0 || rows) {
        madeHere = false;
        lines.push(
          `The bucket ${bucket} has this step's mark in it, and ${written.length > 0 ? "a log pipeline of the stack writes to it" : "it holds table rows"}: it is the stack's bucket, and nothing in it goes.`,
        );
      }
    }
  } else
    return {
      failed: true,
      lines: [
        `Cloudflare answered ${there.status} to GET the bucket ${bucket}: its tables may be left`,
      ],
    };

  // THE CATALOG, on: the tables are read only then, so "no tables" is believed only then.
  let turnedOn = false;
  let on = catalog.on;
  if (!on) {
    const enabled = await call("POST", `${catalogUrl}/enable`);
    if (ok(enabled.status)) {
      turnedOn = true;
      for (let tries = 0; tries < 5 && !on; tries += 1) {
        on = (await catalogNow()).on;
        if (!on) await pause();
      }
    }
    if (!on)
      fail(
        `The data catalog of ${bucket} could not be turned on (Cloudflare answered ${enabled.status}): its tables may be left`,
      );
  }

  if (on) {
    const saidBefore = lines.length;
    const namespace = `${CATALOG}/${accountId}/${bucket}/v1/${catalog.id}/namespaces/${TABLES.namespace}`;
    const listed = await call("GET", `${catalogUrl}/namespaces/${TABLES.namespace}/tables`);
    if (listed.status === 200) {
      // The cast: Cloudflare's documented answer, a list of the namespace's tables by name; one
      // that is not there reads as no table.
      const identifiers =
        (listed.body as { result?: { identifiers?: { name: string }[] } } | null)?.result
          ?.identifiers ?? [];
      const inIt = identifiers.map((table) => table.name);
      const mine = TABLES.names.filter((own) => inIt.includes(own) && !written.includes(own));
      if (deploying && mine.length > 0)
        lines.push(
          `Left over from an earlier time telemetry was on: ${mine.map((table) => `${TABLES.namespace}.${table}`).join(", ")} in the data catalog of ${bucket}, with no log pipeline. Cloudflare lets no new pipeline write to a table that exists, so ${mine.length === 1 ? "it goes" : "they go"} now, with the rows in ${mine.length === 1 ? "it" : "them"}.`,
        );
      for (const table of mine) {
        const dropped = await call("DELETE", `${namespace}/tables/${table}`);
        if (ok(dropped.status) || dropped.status === 404)
          lines.push(
            `Dropped: table ${TABLES.namespace}.${table} in the data catalog of ${bucket}`,
          );
        else
          fail(
            `NOT dropped: table ${TABLES.namespace}.${table} in the data catalog of ${bucket} (Cloudflare answered ${dropped.status})`,
          );
      }
      const others = inIt.filter((other) => !TABLES.names.includes(other));
      if (others.length > 0)
        lines.push(
          `Left: the namespace ${TABLES.namespace} of ${bucket}, which also holds ${others.join(", ")}: not this stack's`,
        );
      // a table that a sink of the stack writes stays, and its namespace with it
      else if (!failed && !written.some((table) => inIt.includes(table))) {
        const gone = await call("DELETE", namespace);
        if (ok(gone.status))
          lines.push(`Dropped: namespace ${TABLES.namespace} in the data catalog of ${bucket}`);
        // 404: there was none, as after an earlier run of this step
        else if (gone.status !== 404)
          fail(
            `NOT dropped: namespace ${TABLES.namespace} of ${bucket} (Cloudflare answered ${gone.status})`,
          );
      }
      // with the catalog on, 404 says that the namespace is not there: no table of this stack
    } else if (listed.status !== 404)
      fail(
        `Cloudflare answered ${listed.status} to GET the tables in the catalog of ${bucket}: they may be left`,
      );
    if (lines.length === saidBefore)
      lines.push(
        deploying
          ? `the data catalog of ${bucket} has no table left over`
          : `the data catalog of ${bucket} has no telemetry tables`,
      );
  }

  // BACK AS IT WAS: the catalog off when this run turned it on, and the bucket gone when this
  // step made it, now or in an earlier run.
  if (turnedOn) {
    const disabled = await call("POST", `${catalogUrl}/disable`);
    if (!ok(disabled.status))
      fail(`The data catalog of ${bucket} is left on (Cloudflare answered ${disabled.status})`);
  }
  if (madeHere) {
    let emptied = true;
    // a catalog writes its tables' metadata into the bucket: every page of it, the mark last
    for (let page = 0; page < 50 && emptied; page += 1) {
      const objects = await call("GET", `${bucketUrl}/objects?per_page=1000`);
      // The cast: Cloudflare's documented answer, a page of the bucket's objects by key; one
      // that is not there reads as an empty page.
      const keys = ((objects.body as { result?: { key: string }[] } | null)?.result ?? [])
        .map((object) => object.key)
        .filter((key) => key !== MADE_HERE);
      if (!ok(objects.status)) emptied = false;
      if (keys.length === 0) break;
      for (const key of keys)
        if (!ok((await call("DELETE", `${bucketUrl}/objects/${encodeURIComponent(key)}`)).status))
          emptied = false;
    }
    // 404: the mark is gone already, and the bucket is still this step's to remove
    const mark = emptied ? (await call("DELETE", markUrl)).status : 0;
    const unmarked = ok(mark) || mark === 404;
    const removed = unmarked && ok((await call("DELETE", bucketUrl)).status);
    if (!removed) {
      bucketLeft = true;
      // the mark goes back, so that the next run knows the bucket is this step's to remove
      const marked =
        !unmarked || ok((await call("PUT", markUrl, { madeBy: "drop-telemetry-tables" })).status);
      fail(
        marked
          ? `NOT removed: the bucket ${bucket}, which this step made to reach the tables. Run the step again: it finishes this.`
          : `NOT removed: the bucket ${bucket}, which this step made to reach the tables, and its mark could not be put back. Remove it by hand before the next deploy: no later run takes it as its own.`,
      );
    }
  }
  return bucketLeft ? { failed, lines, bucketLeft } : { failed, lines };
}

/** Whether a bucket holds table rows, or more than this step ever leaves in a bucket it made: an
 *  object outside the catalog's own folder, a table's data file, or a full page of objects.
 *  "unread" when Cloudflare did not list it. */
async function rowsIn(bucketUrl: string, call: Call) {
  const per = 1000;
  const objects = await call("GET", `${bucketUrl}/objects?per_page=${per}`);
  // The cast: Cloudflare's documented answer, a page of the bucket's objects by key, and whether
  // the bucket holds more than the page.
  const page = objects.body as {
    result?: { key: string }[];
    result_info?: { is_truncated?: boolean };
  } | null;
  if (objects.status !== 200 || !page?.result) return "unread" as const;
  const keys = page.result.map((object) => object.key).filter((key) => key !== MADE_HERE);
  // A table's files are __r2_data_catalog/<catalog>/<table>/metadata/… and …/data/…: the rows
  // are the data files.
  return (
    page.result_info?.is_truncated === true ||
    keys.length >= per - 1 ||
    keys.some((key) => !key.startsWith("__r2_data_catalog/") || key.includes("/data/"))
  );
}

/** The names of the account's pipeline sinks, every page, or a line that says why they could not
 *  be read. */
async function sinkNames(account: string, call: Call) {
  const names: string[] = [];
  const per = 50;
  let last = "";
  for (let page = 1; page <= 40; page += 1) {
    const answer = await call("GET", `${account}/pipelines/v1/sinks?page=${page}&per_page=${per}`);
    // The cast: Cloudflare's documented answer, a page of the account's sinks by name.
    const result = (answer.body as { result?: { name?: string }[] } | null)?.result;
    if (answer.status !== 200 || !result)
      return {
        unread: `Cloudflare answered ${answer.status} when asked for the account's pipeline sinks`,
      };
    const got = result.map((sink) => String(sink.name));
    // an address that ignores `page` gives the same page again: it has no more
    if (JSON.stringify(got) === last) break;
    last = JSON.stringify(got);
    names.push(...got);
    if (got.length < per) break;
  }
  return { names };
}
