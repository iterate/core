// platform-hook.ts — THE PLATFORM HOOK: the platform's own subscriber of a project context's
// durable events, handed them in batches by the context's ordered `platform` row (a deployment's
// birth events, project/context-birth-events.ts, which says why ordered and not fan-out). The
// built-in (context/built-ins.ts `platformHook`) answers the delivery loop alone and hands each
// batch to what its context built here, where a platform feature that reacts to a project's events
// starts. The first sends them to the account's `events` table (docs/telemetry.md), where the
// Worker binds `TELEMETRY_EVENTS`.
import type { StreamEvent } from "iterate/stream/processor";
import type { Pipeline } from "cloudflare:pipelines";

/** The most of a payload a row keeps, in UTF-8 bytes: escaped as JSON, at most 6 bytes each, so a
 *  cut payload stays far under the 1 MB a row may take (docs/telemetry.md#failures-and-limits). */
const EVENTS_PAYLOAD_MAX_BYTES = 96 * 1024;

/** A Basin Pipelines stream takes no row over 1 MB, and fails the whole send that carries one. The
 *  payload's cut keeps a row under it unless another field is that big (an event type, a path). */
const ROW_MAX_BYTES = 1_000_000;

/** Under the 5 MB a Basin Pipelines send takes, with room for the array around the rows. */
const SEND_MAX_BYTES = 4 * 1024 * 1024;

/**
 * SEND ONE BATCH of a context's durable events to the `events` table: a row each (`eventsRow`), in
 * sends of at most SEND_MAX_BYTES, one after another. The delivery loop awaits it. A send that fails
 * throws, and the loop delivers the whole batch again from the row's durable cursor on the long
 * ladder (stream/subscription-delivery.ts `#ladder`), so nothing is lost to an outage of hours or to
 * a context reset, and a row that landed before the failure lands twice (dedupe on the key). A row
 * over ROW_MAX_BYTES would fail its send every time and hold every later event back, so it is
 * dropped and counted instead.
 */
export async function sendEvents(
  env: { TELEMETRY_EVENTS: Pipeline<EventsRow>; WORKER_NAME: string },
  projectId: string,
  events: StreamEvent[],
): Promise<void> {
  const sends: EventsRow[][] = [[]];
  let sendBytes = 0;
  let dropped = 0;
  for (const event of events) {
    const row = eventsRow(event, { worker: env.WORKER_NAME, projectId });
    const bytes = new TextEncoder().encode(JSON.stringify(row)).length + 1; // and its comma
    if (bytes > ROW_MAX_BYTES) dropped++;
    else {
      if (sendBytes + bytes > SEND_MAX_BYTES && sends.at(-1)!.length > 0) {
        sends.push([]);
        sendBytes = 0;
      }
      sends.at(-1)!.push(row);
      sendBytes += bytes;
    }
  }
  if (dropped > 0)
    console.warn({
      event: "telemetry.events-dropped",
      message: "rows over 1 MB, which no stream takes, never reach the events table",
      projectId,
      count: dropped,
    });
  for (const rows of sends) if (rows.length > 0) await env.TELEMETRY_EVENTS.send(rows);
}

/** ONE `events` ROW (internal-packages/telemetry/schemas/events.json): the event, its actor (never
 *  an email) and cause, and its payload cut to EVENTS_PAYLOAD_MAX_BYTES, with its whole size. */
export function eventsRow(
  event: StreamEvent,
  { worker, projectId }: { worker: string; projectId: string },
) {
  // oxlint-disable-next-line iterate/simple-truthiness-check -- only an event with no payload gets {}: a falsy payload off the wire (0, false, "") is stored as itself
  const payload = JSON.stringify(event.payload === undefined ? {} : event.payload);
  const utf8 = new TextEncoder().encode(payload);
  const { principal, cause } = event.source;
  return {
    timestamp: event.createdAt,
    worker,
    project_id: projectId,
    path: event.path,
    offset: event.offset,
    type: event.type,
    actor: principal?.actor || null,
    cause_chain: cause?.chain || null,
    cause_depth: cause?.depth ?? null,
    cause_parent: cause?.parent || null,
    // Decoded, not sliced: a slice would keep the whole payload alive with the row. A cut that
    // splits a character decodes to U+FFFD.
    payload:
      utf8.length > EVENTS_PAYLOAD_MAX_BYTES
        ? new TextDecoder().decode(utf8.subarray(0, EVENTS_PAYLOAD_MAX_BYTES))
        : payload,
    payload_bytes: utf8.length,
  };
}

export type EventsRow = ReturnType<typeof eventsRow>;
