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

// CHECKS OF THE DEFAULT CONFIG'S OWN SITE, by the start of their names, each with the text of the
// default worker.ts (core/configs/default) that it tests. A mind whose worker.ts is its own, such
// as a shop or a redirect, answers its hostnames in its own way: those answers are that mind's to
// check, so a check whose text its worker.ts lacks is skipped.
const DEFAULT_SITE: [start: string, text: string, what: string][] = [
  ["hostnames: the apex answers the config worker's page", '"Homepage of mind "', "homepage"],
  ["repos: a commit to /repos/config republishes the site", '"Homepage of mind "', "homepage"],
  [
    "hostnames: a subdomain reaches the config worker with its routing key",
    '"Not found\\n"',
    "plain 404 for a hostname that nothing is mounted on",
  ],
  ["boundary: a page load of https://", '"/me"', "page /me"],
  ["boundary: a fetch of https://", '"/me"', "page /me"],
];
/** The mind's worker.ts, once the smoke has read it from the config repo; empty until then. */
let mindWorker = "";

/** From now on `attempt` skips a check of the default site that `source`, the mind's own
 *  worker.ts, does not hold. */
export function mindWorkerIs(source: string) {
  mindWorker = source;
}

/** Whether the mind's worker.ts mounts the app in `apps/<name>`: it imports the app's `app.ts`,
 *  in a line that is not commented out. Yes while worker.ts is not read. */
export const mounts = (name: string) =>
  !mindWorker ||
  new RegExp(`^import [^\\n]*["']\\./apps/${name}/app(?:\\.ts)?["']`, "m").test(mindWorker);

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
  const ownSite =
    mindWorker &&
    DEFAULT_SITE.find(([start, text]) => check.startsWith(start) && !mindWorker.includes(text));
  if (ownSite)
    return {
      check,
      pass: true,
      detail: `skipped: this mind's worker.ts is its own, without the default config's ${ownSite[2]}`,
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
