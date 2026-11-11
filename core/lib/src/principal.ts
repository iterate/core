// principal.ts — WHO user code is acting for, as the platform tells it: the verified `Principal`
// (`itx.whoami()`, `source.principal` on an event), the header ingress stamps it in on a Request it
// forwards to a mind, with the grant beside it, and the `Person` ingress stamps for anyone
// signed in on a mind's hostname (core/boundary-worker/src/stamp.ts; sdk/auth.ts reads both), and the
// one reader of the principal's stamp, `stampedCallerOf`. How the platform admits and carries a
// caller, and signs its own tokens, stays in the platform.
import { z } from "zod";

/** Who is acting: a stable actor id (the auth Worker's user id) and, when known, an email. A
 *  platform admin signed in as someone else is two people (RFC 8693's subject and actor): the
 *  principal is the person, whose access every check reads, and `impersonatedBy` the admin doing
 *  it, stamped beside them on every event. */
export type Principal = {
  actor: string;
  email?: string;
  impersonatedBy?: { actor: string; email: string };
};

/** The header ingress sets on a Request it forwards on a member's behalf, after the bearer or the
 *  session cookie checks out, and strips from every inbound Request. */
export const ITX_PRINCIPAL_HEADER = "x-itx-principal";

/** The header the edge sets beside `ITX_PRINCIPAL_HEADER`: the OAuth grant the principal acts
 *  through, one per connected client. Stripped from every inbound Request. */
export const ITX_GRANT_HEADER = "x-itx-grant";

/** The header the edge sets beside `ITX_GRANT_HEADER`: when the credential that stamped the
 *  principal ends, in Unix seconds. A session that outlives its request (the API's WebSocket) ends
 *  then. Stripped from every inbound Request. */
export const ITX_EXPIRES_HEADER = "x-itx-expires";

/** A KEY'S TOKEN (core/auth-worker/src/key-tokens.ts): the service the key speaks for, the key as
 *  the grant it acts through (`key:<id>`), and the one capability it may lend, `itx.<provide>`. */
export type Lender = { actor: string; key: string; provide: string };

/** The header ingress sets for a key's token on the mind's API, as the JSON of a `Lender`, in place
 *  of `ITX_PRINCIPAL_HEADER`: such a caller is no principal, and reaches its one lend and nothing
 *  else of the mind (core/mind-worker/src/api.ts). Stripped from every inbound Request. */
export const ITX_LENDER_HEADER = "x-itx-lender";

const StampedLender = z.object({ actor: z.string(), key: z.string(), provide: z.string() });

/** The lender ingress stamped on `request`, or null. Trusted as it stands, as `stampedCallerOf`. */
export function stampedLenderOf(request: Request): Lender | null {
  const lender = request.headers.get(ITX_LENDER_HEADER);
  return lender ? StampedLender.parse(JSON.parse(lender)) : null;
}

/** A signed-in person as a mind's host knows them, member or not: the auth Worker's user id
 *  and their email, and `impersonatedBy` the platform admin signed in as them, as on `Principal`.
 *  An app that hands out something personal refuses, or records, a person an admin is signed in
 *  as. */
export type Person = {
  userId: string;
  email: string;
  impersonatedBy?: { actor: string; email: string };
};

/** The header ingress sets, as the JSON of a `Person`, on a mind host's Request from anyone
 *  signed in (core/boundary-worker/src/mind-host-sign-in.ts), and strips from every inbound Request. A
 *  member gets `x-itx-principal` beside it. */
export const ITX_PERSON_HEADER = "x-itx-person";

const StampedPrincipal = z.object({
  actor: z.string(),
  email: z.string().optional(),
  impersonatedBy: z.object({ actor: z.string(), email: z.string() }).optional(),
});

/** When the credential stamped on `request` ends, in epoch milliseconds, or null when none is
 *  stamped (`ITX_EXPIRES_HEADER`). */
export function stampedExpiryOf(request: Request): number | null {
  const seconds = Number(request.headers.get(ITX_EXPIRES_HEADER));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** THE CALLER INGRESS STAMPED on `request`: the principal, and the grant they came through, which
 *  every event they append then carries. Null when nobody is stamped. Ingress strips every `x-itx-*`
 *  a caller sends and stamps its own, and only ingress reaches a mind, so the stamp is trusted
 *  as it stands: a malformed one is a defect, and throws. */
export function stampedCallerOf(request: Request): {
  principal: Principal | null;
  grant: string | undefined;
} {
  const principal = request.headers.get(ITX_PRINCIPAL_HEADER);
  return {
    principal: principal ? StampedPrincipal.parse(JSON.parse(principal)) : null,
    grant: request.headers.get(ITX_GRANT_HEADER) || undefined,
  };
}
