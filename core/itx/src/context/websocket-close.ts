// Not 1000: a client told 1000 may take a drop as an orderly end and not reconnect.
export const DROPPED_CLOSE_CODE = 1011;

// RFC 6455 7.4: 1005 and no code were orderly (1000); 1004, 1006, 1015 and codes no endpoint may
// send become DROPPED_CLOSE_CODE.
export function relayedCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1005) return 1000;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014)) return code;
  return code >= 3000 && code <= 4999 ? code : DROPPED_CLOSE_CODE;
}

// workerd throws on a reason over 123 UTF-8 bytes, so a UTF-16 `.slice(0, 123)` is not enough.
export function truncateCloseReason(reason: string): string {
  let out = reason;
  while (new TextEncoder().encode(out).length > 123) out = out.slice(0, -1);
  return out;
}
