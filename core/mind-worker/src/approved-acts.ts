// approved-acts.ts — AN ACT A MEMBER APPROVED AFTER ITS CALLER STOPPED WAITING (iterate/acts). The
// vault names it to the boundary with the approval, and the boundary hands it here. The mind does
// it now, and writes what came of it on the context its caller named, so that an agent which went
// on reads "your mail was approved and sent". The gate decides whether the act is still to do: it
// lets one go once, so a second hand-over does nothing.
import type { ReachableContext } from "core-itx";
import { ACT_DONE, actOfText, APPROVALS_CONTEXT, isMailAct } from "iterate/acts";
import { normalizedItxExpression } from "iterate/expression";
import type { StreamEventInput } from "iterate/stream/processor";
import type { Door } from "iterate/workers";
import { EMAIL_PATH, sendApprovedMail } from "./integrations/email.ts";

export async function runApprovedAct(
  deps: {
    files: R2Bucket;
    egress: Pick<Door, "sendEmail" | "act">;
    contextAt: (path: string) => ReachableContext;
    appendAsPlatform: (path: string, events: StreamEventInput[]) => Promise<unknown>;
  },
  held: { digest: string; text: string; from?: string },
): Promise<void> {
  const act = actOfText(held.text);
  if (!act) throw new Error(`the approved act ${held.digest} is no act this mind can do`);
  // `from` is the caller's claim: any context of the mind, or the gate's own when it named none
  const caller = held.from?.startsWith("/") ? held.from : APPROVALS_CONTEXT;
  const outcome = await (async () => {
    if (isMailAct(act)) {
      const sent = await sendApprovedMail(
        { files: deps.files, egress: () => deps.egress, emailContext: deps.contextAt(EMAIL_PATH) },
        act,
        caller,
      );
      return { ok: true as const, sent: { path: EMAIL_PATH, offset: sent.offset } };
    }
    // A verb, from where its caller called it. The gate lets it go once. The call is not the
    // platform's, which no rule holds: it carries the approved text, and the kernel runs it only
    // when the call, as the mind's table resolves it now, is still that act. A name that was
    // re-pointed since it was held is another function, which nobody approved.
    const gate = await deps.egress.act({ text: held.text, from: caller });
    if (gate.state !== "go") throw new Error(`the gate says "${gate.state}": it is not to do now`);
    const names = normalizedItxExpression(act.act);
    const result = await deps
      .contextAt(caller)
      .invoke([...names.slice(0, -1), [String(names.at(-1)), ...act.args]], [], {
        principal: null,
        approvedAct: held.text,
      });
    // what a verb answers may be anything: the fact keeps what JSON can say of it
    return { ok: true as const, result: jsonOf(result) };
  })().catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  console.info({ event: "approval.act-done", digest: held.digest, act: act.act, ok: outcome.ok });
  await deps.appendAsPlatform(caller, [
    {
      type: ACT_DONE,
      idempotencyKey: `approval/act-done:${held.digest}`,
      payload: { digest: held.digest, act: act.act, ...outcome },
    },
  ]);
}

function jsonOf(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}
