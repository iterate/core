// client/new-version.ts — what the log client (event-log.ts) and the live-state client
// (live-state.ts) both need to follow a context into its next version (`itx.newVersion`,
// core/lib/README.md "A new version of a context"): which version an event starts, and the bounded
// repeat of a call that the context refuses while it restarts.
import { z } from "zod";
import { errorCode } from "../lib.ts";

/** An `itx/created` of a later version. A context's first version has an `itx/created` with no
 *  `version`; `newVersion` appends one with the next version (2 or more). */
const LaterVersionCreated = z.object({
  type: z.literal("events.iterate.com/itx/created"),
  payload: z.object({ version: z.number() }),
});

/** The version that `event` starts, when it is the `itx/created` of a later version; else
 *  undefined (any other event, and the version-less `itx/created` of a first version). */
export function versionStartedBy(event: unknown): number | undefined {
  const parsed = LaterVersionCreated.safeParse(event);
  return parsed.success ? parsed.data.payload.version : undefined;
}

/** The types of the event that ends a version. The kernel appends `itx/started-over`; a log that
 *  took a new version under the earlier name holds `itx/version-ended`, for ever. */
export const STARTED_OVER_TYPES = [
  "events.iterate.com/itx/started-over",
  "events.iterate.com/itx/version-ended",
] as const;

const VersionEnded = z.object({
  type: z.enum(STARTED_OVER_TYPES),
  payload: z.object({ version: z.number() }),
});

/** The version that `event` ends, when it is an `itx/started-over` (or the earlier `itx/version-ended`); else undefined. The kernel
 *  sends it to a row only as the last batch of a row of that version. */
export function versionEndedBy(event: unknown): number | undefined {
  const parsed = VersionEnded.safeParse(event);
  return parsed.success ? parsed.data.payload.version : undefined;
}

/** The `data` that code `UNAVAILABLE` carries: `{ kind, retryAfterMs }` (lib.ts `ErrorCode`). */
const UnavailableError = z.object({ data: z.object({ retryAfterMs: z.number() }) });

/** `call`, made again while the context refuses it with code `UNAVAILABLE` (it restarts for a new
 *  version or a deploy: seconds), after the error's `data.retryAfterMs` (1 s when absent). Bounded:
 *  the thirtieth refusal, and any other error, is thrown. `stop` is read before each repeat: a
 *  caller that no longer wants the answer ends the repeats, and the call answers undefined. */
export async function retryWhileUnavailable<T>(
  call: () => Promise<T>,
  stop: () => boolean,
): Promise<T | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (errorCode(error) !== "UNAVAILABLE" || attempt >= 30) throw error;
      const asked = UnavailableError.safeParse(error);
      await new Promise((resolve) =>
        setTimeout(resolve, asked.success ? asked.data.data.retryAfterMs : 1000),
      );
      if (stop()) return undefined;
    }
  }
}
