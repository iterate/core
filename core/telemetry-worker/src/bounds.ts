// bounds.ts — THE SIZES THAT BOUND A READ AND A SEND, for ./http.ts and ./rpc.ts: a body is read
// up to a limit, and rows go to a pipeline in sends that it takes.

// Basin Pipelines takes at most 5 MB a send, and no row over 1 MB: one fails the whole send.
const SEND_MAX_BYTES = 4 * 1024 * 1024;

export const ROW_MAX_BYTES = 1_000_000;

/** Null once `body` passes `max` bytes: the rest is cancelled, never held. */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null | undefined,
  max: number,
): Promise<{ text: string } | null> {
  const reader = body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (let next = await reader?.read(); next && !next.done; next = await reader!.read()) {
    bytes += next.value.byteLength;
    if (bytes > max) {
      await reader!.cancel();
      return null;
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return { text: text + decoder.decode() };
}

/** A row and its size in a send's JSON array, its comma included. */
export function sized<Row>(row: Row) {
  return { row, bytes: new TextEncoder().encode(JSON.stringify(row)).byteLength + 1 };
}

export function* sends<Row>(rows: { row: Row; bytes: number }[]) {
  let chunk: Row[] = [];
  let chunkBytes = 0;
  for (const { row, bytes } of rows) {
    if (chunk.length > 0 && chunkBytes + bytes > SEND_MAX_BYTES) {
      yield chunk;
      [chunk, chunkBytes] = [[], 0];
    }
    chunk.push(row);
    chunkBytes += bytes;
  }
  if (chunk.length > 0) yield chunk;
}
