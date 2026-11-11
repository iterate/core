// principal.ts — WHO user code is acting for, as the platform tells it: the verified `Principal`
// (`itx.whoami()`, `source.principal` on an event), the header ingress stamps it in on a Request it
// forwards to a project, with the grant beside it, and the `Person` ingress stamps for anyone
// signed in on a project's hostname (core/boundary/src/stamp.ts; sdk/auth.ts reads both), and the
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

/** A signed-in person as a project's host knows them, member or not: the auth Worker's user id
 *  and their email, and `impersonatedBy` the platform admin signed in as them, as on `Principal`.
 *  An app that hands out something personal refuses, or records, a person an admin is signed in
 *  as. */
export type Person = {
  userId: string;
  email: string;
  impersonatedBy?: { actor: string; email: string };
};

/** The header ingress sets, as the JSON of a `Person`, on a project host's Request from anyone
 *  signed in (core/boundary/src/project-host-sign-in.ts), and strips from every inbound Request. A
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
 *  a caller sends and stamps its own, and only ingress reaches a project, so the stamp is trusted
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
