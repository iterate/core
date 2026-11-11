import { serveSession } from "core-itx";
import { stampedCallerOf, stampedExpiryOf } from "iterate/principal";

// A caller without a stamp came in past the boundary (a home lab's local port).
export async function serveApi(request: Request, ctx: ExecutionContext) {
  const caller = stampedCallerOf(request);
  if (!caller.principal) return new Response("Sign in\n", { status: 401 });
  return serveSession(request, ctx, {
    caller,
    endsAt: stampedExpiryOf(request),
    endReason: "the sign-in for this session ended: sign in again",
  });
}
