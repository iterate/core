import { WorkerEntrypoint } from "cloudflare:workers";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import type { SecretMaterial } from "iterate/api";
import { z } from "zod";
import { originPinned, sha256Hex } from "../secrets.ts";

const REFUSED_HEADER = "x-itx-exchange-refused";

// The props, the pin, are out of the loaded code's reach. Redirects come back through here each
// time; `connect()` sockets have no handler, so they fail.
export class PinnedOutbound extends WorkerEntrypoint<object, { urls: string[] }> {
  override async fetch(request: Request): Promise<Response> {
    const { origin } = new URL(request.url);
    if (!originPinned(request.url, this.ctx.props.urls))
      return new Response(`${origin} is outside the secret's pin\n`, {
        status: 403,
        headers: { [REFUSED_HEADER]: origin },
      });
    console.info({ event: "secret.exchange-request", origin });
    const response = await fetch(request, { redirect: "manual" });
    if (!response.headers.has(REFUSED_HEADER)) return response;
    // an upstream's own copy of the header must not fail its secret's refresh
    const headers = new Headers(response.headers);
    headers.delete(REFUSED_HEADER);
    return new Response(response.body, { status: response.status, headers });
  }
}

// Worker Loader has no switch that turns a loaded worker's logs off, so the prelude silences
// `console`. An unhandled rejection's reason may quote the material: it is kept off the report.
const PRELUDE = `
const network = globalThis.fetch;
export const refused = [];
export async function pinnedFetch(input, init) {
  const response = await network(input, init);
  const origin = response.headers.get(${JSON.stringify(REFUSED_HEADER)});
  if (origin) {
    refused.push(origin);
    throw new Error("fetch to " + origin + " refused: outside the secret's pin");
  }
  return response;
}
globalThis.fetch = pinnedFetch;
for (const method of Object.keys(console)) console[method] = () => {};
addEventListener("unhandledrejection", (event) => event.preventDefault());
`;

// Answers a value, never a throw.
const JAIL = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { refused, pinnedFetch } from "./prelude.js";
import * as code from "./exchange.js";
const outsideThePin = () => ({ error: "the exchange code fetched " + refused[0] + ", outside the secret's pin" });
export class Jail extends WorkerEntrypoint {
  async exchange(material) {
    refused.length = 0;
    if (typeof code.exchange !== "function")
      return { error: "the exchange code exports no exchange(material, fetch) function" };
    let next;
    try {
      next = await code.exchange(material, pinnedFetch);
    } catch (error) {
      return refused.length ? outsideThePin() : { error: String((error && error.message) || error) };
    }
    if (refused.length) return outsideThePin();
    if (typeof next !== "object" || next === null || Array.isArray(next))
      return { error: "exchange returned no object — return the next material" };
    return { material: JSON.parse(JSON.stringify(next)) };
  }
}
`;

const JailAnswer = z.object({
  material: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

const EXCHANGE_LIMITS = { cpuMs: 1_000, subRequests: 16 };

const JAIL_COMPATIBILITY_FLAGS = ["no_nodejs_compat", "no_nodejs_compat_v2"];

// Part of every jail's id.
const JAIL_CODE = [COMPATIBILITY_DATE, JAIL_COMPATIBILITY_FLAGS, EXCHANGE_LIMITS, JAIL, PRELUDE];

// The Error's message holds no string of the material.
export async function runExchangeCode(input: {
  loader: WorkerLoader;
  // the code's whole egress
  pinnedOutbound: Fetcher;
  context: string;
  urls: string[];
  source: string;
  material: SecretMaterial;
}): Promise<Record<string, unknown>> {
  const { urls, source, material } = input;
  // Every distinct id is a billed Dynamic Worker. Worker Loader rebuilds an isolate under the same
  // id after a deploy, so the id never names the deployment.
  const id = `secret-exchange:${await sha256Hex(JSON.stringify([JAIL_CODE, input.context, urls, source]))}`;
  const worker = input.loader.get(id, () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: JAIL_COMPATIBILITY_FLAGS,
    mainModule: "jail.js",
    modules: { "jail.js": JAIL, "prelude.js": PRELUDE, "exchange.js": source },
    env: {},
    globalOutbound: input.pinnedOutbound,
    limits: EXCHANGE_LIMITS,
  }));
  let answer: unknown;
  try {
    answer = await worker
      .getEntrypoint<WorkerEntrypoint & { exchange(material: SecretMaterial): unknown }>("Jail")
      .exchange(material);
  } catch (error) {
    answer = { error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = JailAnswer.safeParse(answer).data;
  if (parsed?.material) return parsed.material;
  throw new Error(`exchange code: ${redacted(parsed?.error || "no answer", material)}`);
}

function redacted(message: string, material: SecretMaterial): string {
  const strings: string[] = [];
  JSON.stringify(material, (_key, value: unknown) => {
    if (typeof value === "string") strings.push(value);
    return value;
  });
  let clean = message;
  for (const secret of strings.filter((value) => value.length >= 3))
    clean = clean.replaceAll(secret, "[redacted]");
  return clean.slice(0, 300);
}
