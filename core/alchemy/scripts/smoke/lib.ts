import { newHttpBatchRpcSession } from "capnweb";
import type { IterateContextApi } from "iterate/api";
import { mindApiUrlOf } from "iterate/mind-api";

export type Check = { check: string; pass: boolean; detail: string };

// Checks a stack that owns `iterate.<domain>` alone cannot pass, by the start of their names.
const NOT_ON_PLATFORM = [
  "hostnames: ",
  "repos: a commit to /repos/config republishes the site",
  "home lab: the apex",
  "home lab: with none connected, the apex",
  "boundary: a page load of https://",
  "boundary: a fetch of https://",
  "mail: ",
];
let platformOnly = false;

/** From now on `attempt` skips NOT_ON_PLATFORM: an ES module's importer cannot assign its `let`. */
export function ownsPlatformAlone() {
  platformOnly = true;
}

export async function attempt(
  check: string,
  run: () => Promise<{ pass: boolean; detail: string }>,
): Promise<Check> {
  if (platformOnly && NOT_ON_PLATFORM.some((start) => check.startsWith(start)))
    return {
      check,
      pass: true,
      detail: 'skipped: the stack owns iterate.<domain> alone (hostnames: "platform")',
    };
  try {
    return { check, ...(await run()) };
  } catch (error) {
    return { check, pass: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// A capnweb HTTP batch ends at its first await, so a read that must see a write is a second call.
export function mindRoot(domain: string, token: string) {
  const request = new Request(mindApiUrlOf(domain), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- one bounded round trip per check, with the bearer on the request, which a WebSocket from Node cannot carry
  return newHttpBatchRpcSession<IterateContextApi>(request);
}
