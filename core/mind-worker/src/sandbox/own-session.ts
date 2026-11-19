// A SANDBOX'S OWN SESSION: code in a sandbox reaches the mind's API with no token. Its egress
// (./egress.ts) answers a request for the API that names no bearer with a session of its own, as
// the code of the sandbox's context: the caller a worker loaded there has. Who that is comes from
// the egress's props, never from the request. A sandbox gets that session only when it sends
// through the mind's own `itx.fetch`: a sandbox whose requests the mind filters (a rule for
// `itx.fetch` on its context or above it, a jail's among them) gets none, and a session that is
// open when such a rule lands ends.
import { RpcTarget } from "capnweb";
import { z } from "zod";
import { mindApiUrlOf } from "iterate/mind-api";
import type { Caller, IterateContextRpcTarget } from "core-itx";

/** Whether a container's request asks for the sandbox's own session: the mind's API itself, and no
 *  bearer. A request that names a token is that token's owner's, and goes on as any other. */
export function asksForOwnSession(request: Request, controlPlaneHostname: string): boolean {
  return (
    request.url === mindApiUrlOf(controlPlaneHostname) && !request.headers.has("authorization")
  );
}

/** THE ROOT THAT A CLIENT OF THE API TALKS TO (iterate/api `ControlPlaneApi`), served here in the
 *  boundary's place: `authenticate()` answers the sandbox's own session, whatever it is given,
 *  and that session's `mind` is the sandbox's context. The CLI asks no more of it
 *  (iterate/lib client `connectedMind`). */
export const ownSessionRoot = (context: IterateContextRpcTarget) =>
  new OwnSessionRoot(new OwnSession(context));

class OwnSessionRoot extends RpcTarget {
  readonly #session: OwnSession;
  constructor(session: OwnSession) {
    super();
    this.#session = session;
  }
  authenticate() {
    return this.#session;
  }
}

class OwnSession extends RpcTarget {
  readonly #context: IterateContextRpcTarget;
  constructor(context: IterateContextRpcTarget) {
    super();
    this.#context = context;
  }
  get mind() {
    return this.#context;
  }
}

/** The session's root and its caller, from the name the container's interception was made with. */
export function ownSessionOf(sandboxPath: string): { path: string; caller: Caller } {
  return { path: sandboxPath, caller: { principal: null, app: true } };
}

const Rows = z.array(
  z.looseObject({
    match: z.unknown(),
    target: z.unknown(),
    context: z.string().optional(),
  }),
);

/** WHY A SANDBOX GETS NO SESSION, by its context's `rewriteRules.list()`, or null when it gets
 *  one. The list holds the one row that a call of `itx.fetch` from there reaches. The mind's own
 *  fetch is the built-in at `/`. Any other row filters what the sandbox sends, and no row means
 *  that the name is masked. A list that cannot be read as rows gives no session.
 *
 *  A session is loaded code of the sandbox's own context, where `cd` is implicit, so no rule of a
 *  context above it binds the session. A mask on the way to `/` gives no session for that reason,
 *  and so does the built-in fetch given back below `/` (by a context with a bare `itx => null`).
 *  A mask at `/` does bind the session (its calls of a root's name meet the root's table): it
 *  takes no session. Masks of the names implicit at the sandbox too (`cd`, `run`, `workers`) are
 *  not in the list, and this check cannot see them. */
export function egressFilterOf(rows: unknown): string | null {
  const parsed = Rows.safeParse(rows);
  if (!parsed.success) return "its context's rules could not be read";
  const row = parsed.data.find((candidate) => candidate.match === "itx.fetch");
  if (!row) return "itx.fetch is masked for it";
  if (row.target !== "itx.builtins.fetch" || row.context !== "/")
    return `the mind filters what it sends (the rule for itx.fetch at ${row.context || "its context"})`;
  const mask = parsed.data.find(
    (candidate) => candidate.target === null && candidate.context !== "/",
  );
  if (mask)
    return `a context above it masks ${String(mask.match)} (at ${mask.context || "its context"})`;
  return null;
}

/** WHAT A LIVE SESSION DOES ON EACH FRAME (core-itx `serveSession`'s `onFrame`). An open session
 *  is use: a frame stamps the sandbox's clock, at most every ten seconds, so the idle stop comes
 *  only after the session ends. And the sandbox's rules are read again, at most every five
 *  seconds: the reason it answers ends the session. The CLI's heartbeat is a frame every thirty
 *  seconds, so a live session is stamped and checked however quiet it is.
 *
 *  The stamp is not waited for, and `used` reports its own failure: a stamp that fails or never
 *  answers must not keep the rules from being read. Rules that cannot be read end the session,
 *  as they refuse one at its start: its client dials again. */
export function sessionWatch(deps: {
  now: () => number;
  used: () => Promise<void>;
  filter: () => Promise<string | null>;
  ended: (reason: string) => void;
}): () => Promise<string | undefined> {
  let stampedAt = deps.now();
  let checkedAt = deps.now();
  return async () => {
    const now = deps.now();
    if (now - stampedAt >= 10_000) {
      stampedAt = now;
      void deps.used().catch(() => undefined);
    }
    if (now - checkedAt < 5_000) return undefined;
    checkedAt = now;
    const filter = await deps
      .filter()
      .catch((error: unknown) => `its context's rules could not be read (${String(error)})`);
    if (!filter) return undefined;
    deps.ended(filter);
    return `this sandbox's session ended: ${filter}`;
  };
}

/** A header's value is a ByteString, and a context path may hold any character. */
export const asHeaderValue = (text: string) => text.replace(/[^\x20-\x7e]/g, "?");
