// events-row.ts — ONE STREAM EVENT AS A ROW OF THE EVENTS TABLE (./otlp.ts has the rows of the logs
// and spans tables).
import type { StreamEvent } from "iterate/stream/processor";

// escaped as JSON, at most 6 bytes each: far under the 1 MB a row may take
const EVENTS_PAYLOAD_MAX_BYTES = 96 * 1024;

// its actor, never an email
export function eventsRow(event: StreamEvent, worker: string) {
  // oxlint-disable-next-line iterate/simple-truthiness-check -- only an event with no payload gets {}: a falsy payload off the wire (0, false, "") is stored as itself
  const payload = JSON.stringify(event.payload === undefined ? {} : event.payload);
  const utf8 = new TextEncoder().encode(payload);
  const { principal, cause } = event.source;
  return {
    timestamp: event.createdAt,
    worker,
    path: event.path,
    offset: event.offset,
    type: event.type,
    actor: principal?.actor || null,
    cause_chain: cause?.chain || null,
    cause_depth: cause?.depth ?? null,
    cause_parent: cause?.parent || null,
    // decoded, not sliced: a slice would keep the whole payload alive with the row
    payload:
      utf8.length > EVENTS_PAYLOAD_MAX_BYTES
        ? new TextDecoder().decode(utf8.subarray(0, EVENTS_PAYLOAD_MAX_BYTES))
        : payload,
    payload_bytes: utf8.length,
  };
}
export type EventsRow = ReturnType<typeof eventsRow>;
