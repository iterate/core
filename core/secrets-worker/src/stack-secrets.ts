// stack-secrets.ts — THE SECRETS THAT THE STACK MADE: two fixed paths whose value is in this
// Worker's config, not in a secret's storage. The deploy made a Realtime SFU app and a TURN key at
// Cloudflare (core/alchemy src/realtime.ts), and this Worker alone holds their secrets
// (./config.ts `cloudflareRealtime`). Each path answers as a secret that is set, pinned to
// Cloudflare's Realtime API, with its id public; or, when the deploy made none, as not set, with
// the deploy's reason. Those paths and fields are what the call apps read:
//
//   /secrets/cloudflare-realtime-sfu   { appId, appSecret }, appId public
//   /secrets/cloudflare-turn           { keyId, apiToken },  keyId public
//
// The value is the stack's: a mind's code reads it and uses it, and does not set, delete, import,
// connect or collect it (./secret/durable-object.ts refuses those verbs at the two paths). A new
// deploy that makes another app or key changes it, with nothing to write.
import { codedError } from "iterate/lib";
import type { SecretDescription } from "iterate/workers";
import type { secretsConfigOf } from "./config.ts";
import { normalizeSecretRecord, type SecretRecord } from "./secrets.ts";

/** Where the two secrets may be sent: Cloudflare's Realtime API, for the SFU and for TURN. */
export const REALTIME_ORIGIN = "https://rtc.live.cloudflare.com";

export const REALTIME_SFU_PATH = "/secrets/cloudflare-realtime-sfu";
export const TURN_PATH = "/secrets/cloudflare-turn";

/** The paths whose value the stack made. */
export const STACK_SECRET_PATHS: readonly string[] = [REALTIME_SFU_PATH, TURN_PATH];

/** WHAT THE STACK HOLDS AT `path`: undefined for a path that is not the stack's; `{ refusal }`
 *  when the deploy made nothing there; else the secret's record, as a set secret's would open,
 *  and its public fields. */
export function stackSecretOf(
  held: ReturnType<typeof secretsConfigOf>["cloudflareRealtime"],
  path: string,
): undefined | { refusal: string } | { record: SecretRecord; public: Record<string, string> } {
  const { sfu, turn } = held;
  const made:
    | { refusal: string }
    | { material: Record<string, string>; public: Record<string, string> }
    | undefined =
    path === REALTIME_SFU_PATH
      ? "refusal" in sfu
        ? sfu
        : {
            material: { appId: sfu.appId, appSecret: sfu.appSecret.exposeSecret() },
            public: { appId: sfu.appId },
          }
      : path === TURN_PATH
        ? "refusal" in turn
          ? turn
          : {
              material: { keyId: turn.keyId, apiToken: turn.apiToken.exposeSecret() },
              public: { keyId: turn.keyId },
            }
        : undefined;
  if (!made || "refusal" in made) return made;
  return {
    record: normalizeSecretRecord(made.material, { urls: [REALTIME_ORIGIN] }),
    public: made.public,
  };
}

/** `describe` of a stack secret's path. */
export function stackSecretDescription(
  held: NonNullable<ReturnType<typeof stackSecretOf>>,
  path: string,
): SecretDescription {
  if ("refusal" in held) return { path, set: false, reason: held.refusal };
  const { record } = held;
  return {
    path,
    set: true,
    urls: record.urls,
    public: held.public,
    placement: record.placement,
    operations: record.operations,
    lendTo: record.lendTo,
    statementPaths: record.statementPaths,
  };
}

/** The refusal of a verb that would change, or read out, a stack secret. */
export const stackSecretRefusal = (path: string, verb: string) =>
  codedError(
    "FORBIDDEN",
    `secrets.${verb}: ${path} is a secret that the stack made, at its deploy: a mind reads it and uses it, and a deploy alone changes it`,
  );
