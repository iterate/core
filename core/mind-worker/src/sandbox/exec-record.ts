const OUTPUT_LOG_BYTES = 4000;

// Keeps both ends of a long output: an error is usually at the end.
export function outputForLog(bytes: Uint8Array): { text: string; omitted: number } {
  const decoder = new TextDecoder();
  if (bytes.byteLength <= OUTPUT_LOG_BYTES) return { text: decoder.decode(bytes), omitted: 0 };
  const half = OUTPUT_LOG_BYTES / 2;
  const omitted = bytes.byteLength - OUTPUT_LOG_BYTES;
  const head = decoder.decode(bytes.subarray(0, half));
  const tail = decoder.decode(bytes.subarray(bytes.byteLength - half));
  return { text: `${head}\n… ${omitted} bytes omitted …\n${tail}`, omitted };
}
