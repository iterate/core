import { itxExpressionStepName, type ItxExpressionPrefix } from "iterate/expression";
import { codedError } from "iterate/lib";
import type { Principal } from "iterate/principal";
import type { EventCopiedFrom, StreamEventInput } from "iterate/stream/processor";
import { storedCause, type Cause } from "./cause.ts";
import type { OnBehalfOf } from "./on-behalf-of.ts";

// Set only by trusted code: the DO's `invoke` is a Workers-RPC verb, never capnweb-exposed, so a
// client cannot supply its own `Caller`.
export type Caller = {
  principal: Principal | null;
  grant?: string;
  // A member's session held by a page of the mind's own host (serve-host.ts `itxSession`).
  via?: { appPage: string };
  // Set by the first `cd` hop. Its presence means the input expression was already admitted;
  // fresh env.ITX calls never inherit it.
  path?: string;
  app?: true;
  // Set only by the host's own code, on a fact it vouches for (`refuseNonPlatformWrites`).
  platform?: true;
  // The key that signed what this call appends, as the auth Worker verified it. Set only where the
  // auth Worker's own answer is appended (the mind Worker's `Mind.append`): an event never names its
  // own signer.
  signer?: { principal: Principal; key: string };
  // The SHA-256 of what a delivery delivers: a target answers only what it names, so nothing it
  // reaches can hand a subscriber an event its log never held.
  delivery?: string;
  copiedFrom?: EventCopiedFrom;
  cause?: Cause;
  onBehalfOf?: OnBehalfOf;
};
export const ITX_GRANT_HEADER = "x-itx-grant";
// Stripped from every Request that arrives from outside.
export const ITX_APP_HEADER = "x-itx-app";
export const ITX_CALLER_PATH_HEADER = "x-itx-caller-path";

// A writer's own `source` is dropped but `processor`. `origin` is advisory: a `run-requested`
// anyone appends runs, and is stamped, where it lands.
export function stampCaller<E extends { source?: StreamEventInput["source"] }>(
  event: E,
  caller: Caller,
  here: string,
): E & { source: NonNullable<StreamEventInput["source"]> } {
  const source: NonNullable<StreamEventInput["source"]> = { origin: caller.path || here };
  if (caller.cause) source.cause = storedCause(caller.cause);
  if (event.source?.processor) source.processor = event.source.processor;
  if (caller.principal) source.principal = caller.principal;
  if (caller.principal && caller.grant) source.grant = caller.grant;
  if (caller.principal && caller.via) source.via = caller.via;
  if (caller.onBehalfOf) source.onBehalfOf = caller.onBehalfOf;
  // A signed statement the platform carries in is its signer's word, never the platform's.
  if (caller.platform && caller.signer) source.signer = caller.signer;
  else if (caller.platform) source.platform = true;
  if (caller.copiedFrom) source.copiedFrom = caller.copiedFrom;
  const stamped = { ...event, source };
  // `signed` stays only beside the signer the auth Worker verified: a writer's own copy, which
  // nobody checked, would look like a signature on an event its key never signed
  if (!source.signer) delete (stamped as { signed?: unknown }).signed;
  return stamped;
}

// A key taken first would answer or refuse the platform's own fact.
export function refusePlatformIdempotencyKeys(
  events: readonly { idempotencyKey?: string }[],
  caller: Caller,
): void {
  const platformKey = caller.app && /^(?:itx|mind|repo|workspace|sandbox|secret)[/@]/;
  if (!platformKey) return;
  for (const { idempotencyKey } of events)
    if (idempotencyKey && platformKey.test(idempotencyKey))
      throw codedError(
        "FORBIDDEN",
        `idempotency key ${JSON.stringify(idempotencyKey)} is the platform's`,
      );
}

// Readers trust these by type alone, so the append boundary refuses anyone else's.
const PLATFORM_FACT_TYPES: ReadonlySet<string> = new Set([
  "events.iterate.com/mind/worker-updated",
  "events.iterate.com/mind/worker-update-failed",
  "events.iterate.com/email/received",
  "events.iterate.com/email/sent",
  "events.iterate.com/webhook/received",
  "events.iterate.com/mcp/webhook-received",
]);

export const isConfigPointerMatch = (match: ItxExpressionPrefix) =>
  itxExpressionStepName(match[1]) === "config";

// An occurrence fires under its schedule's stamp, so what one may not append it may not schedule.
// A signed statement the platform carries in is held to this like anyone's.
export function refuseNonPlatformWrites(events: readonly StreamEventInput[], caller: Caller): void {
  if (!caller.platform || caller.signer) refuseThePlatformsOwn(events);
}

function refuseThePlatformsOwn(events: readonly StreamEventInput[]): void {
  for (const event of events) {
    if (event.type === "events.iterate.com/itx/schedule-set")
      refuseThePlatformsOwn((event.payload as { events: StreamEventInput[] }).events);
    if (PLATFORM_FACT_TYPES.has(event.type))
      throw codedError(
        "FORBIDDEN",
        `${event.type} is the platform's own fact: no one else appends or schedules it`,
      );
    if (
      event.type === "events.iterate.com/itx/rewrite-rule-configured" &&
      isConfigPointerMatch((event.payload as { match: ItxExpressionPrefix }).match)
    )
      throw codedError(
        "FORBIDDEN",
        "`itx.config` is the mind's published config: only the platform's publication writes it (commit to /repos/config)",
      );
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const bytesFromBase64url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    atob(
      text
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(text.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signClaims(claims: unknown, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(payload),
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

// Null for every bad token alike. The caller checks the claims' shape and expiry.
export async function verifyClaims(token: string, secret: string): Promise<unknown> {
  if (!secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  let signature: Uint8Array<ArrayBuffer>;
  let claims: unknown;
  try {
    signature = bytesFromBase64url(token.slice(dot + 1));
    claims = JSON.parse(decoder.decode(bytesFromBase64url(payload)));
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signature,
    encoder.encode(payload),
  );
  return valid ? claims : null;
}

export const sha256Hex = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
