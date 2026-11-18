// connected-mind.ts — THE MIND OF A SESSION AT `/api`, for the clients of this package (node.ts,
// app.ts). The root of such a session answers a session to `authenticate`, and the session's
// `mind` is the mind's own API (iterate/api `ControlPlaneApi`).
import type { RpcStub } from "capnweb";
import type { ControlPlaneApi, IterateContextApi } from "../api.ts";

/** `authenticate(token).mind`, never awaited: capnweb sends the calls on its answer with it, so
 *  the root and the session cost no round trip. With no `token`, the session is that of the
 *  credential which the socket's own request carried. What this answers is a stub of that
 *  promise (`dup()`): a promise is a thenable, and a client hands its `itx` on. The promise is
 *  let go here, so that the stub is the one hold on the mind: disposing of it releases the mind
 *  at the far end. A credential that is refused fails the first call on the stub, with the code
 *  UNAUTHENTICATED. */
export function connectedMind(
  api: RpcStub<ControlPlaneApi>,
  token?: string,
): RpcStub<IterateContextApi> {
  using session = api.authenticate(token);
  // `session.mind` is a path on the session's promise, and holds nothing of its own
  return session.mind.dup();
}
