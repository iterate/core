// email-hook.ts — THE CONFIG'S `email` HOOK, AS THE MIND RUNS IT for one delivery of one mail
// (../rpc.ts `Mind.email`). The boundary has stored the mail's files and recorded the mail first
// (`receiveEmail`), so nothing here can lose it. The config's `save()` goes to the boundary's
// capability, which records the mail again, as the platform: that call records nothing new. A
// boundary of an older build hands no `save`, and the config's `save()` then answers at once.
// The hook is called as `processEvent` is: on the root context, through the
// published config's `deliverEmail` (iterate/sdk), under the platform's own caller, which alone
// may call it (core-itx built-ins.ts `workersRoot`).
//
// WHAT THE HOOK DID IS A FACT ON `/integrations/email`, never this call's failure:
//   - its save: `email/received`, which the boundary's capability has `receiveEmail` append;
//   - each forward: `email/forwarded`, which the boundary's capability appends;
//   - a throw: `email/hook-failed` `threw`, once for each mail;
//   - a config with no `email`: `email/hook-failed` `missing`, once for each config commit, under
//     the key `email/hook-failed:missing:<commit>`. An old config in the wild gets one fact, not
//     one for each mail. A commit that the mind cannot read still gets ONE fact: the key is then
//     `email/hook-failed:missing:unknown-commit`, the one thing known being that the config that
//     answered has no `email` (`mind/worker-updated.missing` names each publication's commit).
// A platform failure on the way (the root or the loader) is not the hook's: it throws, and the
// boundary records `unreachable`.
import type { EmailHookArgs } from "iterate/email";
import { expiredIfTheDeliveryIsGone } from "iterate/email";
import type { ItxExpression } from "iterate/expression";
import { codedError, errorCode } from "iterate/lib";
import { failureKind, isPlatformFailureKind } from "iterate/platform-retry";
import type { StreamEventInput } from "iterate/stream/processor";
import type { MindTarget } from "iterate/workers";
import { z } from "zod";

/** THE PLATFORM'S READ OF THE `mind` FACET'S SNAPSHOT on the root: a CALL of `snapshot`, which
 *  answers `{ offset, state }` (iterate/stream/processor `snapshot`), as the owner's
 *  `facets.get("mind").snapshot()` does. A bare `"snapshot"` step reads the method and not its
 *  answer, and that has no `state`. */
export const MIND_SNAPSHOT_READ: ItxExpression = [
  "itx",
  "builtins",
  "facets",
  ["get", "mind"],
  ["snapshot"],
];

/** What the snapshot says of the published config (../mind/contract.ts): null before the first
 *  publication. */
const MindSnapshot = z.object({
  state: z.object({ publishedCommit: z.string().min(1).nullable() }),
});

export type EmailHookDeps = {
  /** The published config's `deliverEmail`, called as the platform: "done" or "missing". */
  deliverEmail(args: EmailHookArgs): Promise<unknown>;
  /** THE SENT MARKS of the email log (core-itx `sentBefore`, and the `send:<key>` row that
   *  `reserveSend` puts): `sentBefore` is true for a fact under the key or a mark. */
  emailLog: {
    sentBefore(key: string): Promise<boolean>;
    markSent(key: string): Promise<unknown>;
  };
  /** The root's answer to an expression, as the platform (rpc.ts): `MIND_SNAPSHOT_READ`. */
  readRoot(expression: ItxExpression): Promise<unknown>;
  /** An append to `/integrations/email` as the platform. */
  append(events: StreamEventInput[]): Promise<unknown>;
};

/** Runs the config's `email` hook for one delivery, with the delivery's `save` and `forward`, each
 *  ended when the config's function settles. */
export async function runEmailHook(
  deps: EmailHookDeps,
  { mail, save, forward }: Parameters<MindTarget["email"]>[0],
) {
  const raw = mail.raw?.path;
  if (!raw) throw codedError("INVALID_INPUT", "email: the mail names no raw file");
  // A FORWARD IS ONCE FOR EACH MAIL AND ADDRESS, BY ONE RULE: the SENT mark for (mail, address)
  // is written after Cloudflare accepted the forward, and FORWARDED_BEFORE is answered if and only
  // if the mark is there. The mark has a key of its own, `email/sent:<raw>:<address>`, under which
  // no fact is ever appended: so `sentBefore` sees the mark alone, and the boundary's
  // `email/forwarded` (also its `answered: false`, written before Cloudflare answered) never counts
  // as sent. Nothing is ever released. A mind that dies before Cloudflare is asked leaves no mark: a redelivery forwards.
  // A mind that dies, or whose mark fails, after Cloudflare accepted and before the mark lands
  // leaves none either: a redelivery sends a second copy, as a second copy is better than a lost
  // one. Two calls for one address within one delivery: the boundary refuses the second.
  //
  // THE SAVE AND THE FORWARD END HERE THE INSTANT THE CONFIG'S FUNCTION SETTLES (`ended`), before
  // this side's own awaits (the check, a `threw` append) end and the boundary learns of it. The
  // check of `ended` is the last statement before the call to the boundary, which checks again.
  let ended = false;
  const saveOnce = async () => {
    if (ended) throw codedError("EXPIRED", "not saved: the config's email hook has ended");
    // The boundary recorded the mail itself, before the hook: nothing is left to do.
    if (!save) return;
    try {
      await save();
    } catch (error) {
      throw expiredIfTheDeliveryIsGone(error);
    }
  };
  const forwardOnce = async (to: string) => {
    const key = `email/sent:${raw}:${to.trim().toLowerCase()}`;
    if (await deps.emailLog.sentBefore(key))
      throw codedError("FORWARDED_BEFORE", `not forwarded: this mail went to ${to} before`);
    if (ended) throw codedError("EXPIRED", "not forwarded: the config's email hook has ended");
    try {
      await forward(to);
    } catch (error) {
      throw expiredIfTheDeliveryIsGone(error);
    }
    await deps.emailLog
      .markSent(key)
      .catch((error: unknown) =>
        console.error({ event: "mail.sent-mark-not-written", key, error: String(error) }),
      );
  };
  let answer: unknown;
  try {
    answer = await deps
      .deliverEmail({ mail, save: saveOnce, forward: forwardOnce })
      .finally(() => (ended = true));
  } catch (error) {
    if (isPlatformFailureKind(failureKind(error))) throw error;
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    await recordOnce(deps, {
      type: "events.iterate.com/email/hook-failed",
      idempotencyKey: `email/hook-failed:threw:${raw}`,
      payload: { why: "threw", error: code ? `${code}: ${message}` : message, raw },
    });
    return;
  }
  if (answer !== "missing") return;
  // Soft: a commit that cannot be read is still one fact, never one for each mail.
  const read = await deps
    .readRoot(MIND_SNAPSHOT_READ)
    .then((snapshot) => ({ commitOid: MindSnapshot.parse(snapshot).state.publishedCommit }))
    .catch((error: unknown) => ({ commitOid: null, error: String(error) }));
  await recordOnce(deps, {
    type: "events.iterate.com/email/hook-failed",
    idempotencyKey: `email/hook-failed:missing:${read.commitOid || "unknown-commit"}`,
    payload: read.commitOid
      ? { why: "missing", commitOid: read.commitOid }
      : {
          why: "missing",
          error: `the published commit could not be read: ${"error" in read ? read.error : "none is published"}`,
        },
  });
}

/** A fact that is there already, with other words (a second delivery's throw), is recorded. */
async function recordOnce(deps: Pick<EmailHookDeps, "append">, event: StreamEventInput) {
  await deps.append([event]).catch((error: unknown) => {
    if (errorCode(error) !== "IDEMPOTENCY_CONFLICT") throw error;
  });
}
