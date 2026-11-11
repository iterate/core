import { serveSession } from "core-itx";
import { stampedCallerOf, stampedExpiryOf, stampedLenderOf } from "iterate/principal";
import { LenderRoot } from "./lender-root.ts";

// A caller without a stamp came in past the boundary (a home lab's local port).
export async function serveApi(request: Request, ctx: ExecutionContext) {
  const lender = stampedLenderOf(request);
  if (lender)
    return serveSession(request, ctx, {
      // its lend is its own act in the log, through its key; the root below is all it reaches
      caller: { principal: { actor: lender.actor }, grant: lender.key },
      endsAt: stampedExpiryOf(request),
      endReason: "the key's token for this session ended: ask for a new one",
      root: (context) => new LenderRoot(context, lender),
    });
  const caller = stampedCallerOf(request);
  if (!caller.principal) return new Response("Sign in\n", { status: 401 });
  return serveSession(request, ctx, {
    caller,
    endsAt: stampedExpiryOf(request),
    endReason: "the sign-in for this session ended: sign in again",
  });
}
