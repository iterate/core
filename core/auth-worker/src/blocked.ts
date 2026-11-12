// blocked.ts — THE PEOPLE AN OWNER BLOCKED (migrations/0009_blocked.sql). An owner blocks and
// unblocks on /members (./members.ts). Whoever is blocked gets no mailed code, and a session or a
// token of theirs is nobody's from the next request on.
import type { Env } from "./env.ts";

export type Blocked = { email: string; blockedBy: string };

/** Whether an owner blocked `email`, or the address it is a `+tag` of: `a+1@x` reaches the mailbox
 *  of `a@x`, so a block of `a@x` holds for it (./email-sign-in.ts counts its codes the same way). A
 *  block that names a tag is of that tag alone. */
export async function isBlocked(env: Env, email: string): Promise<boolean> {
  const exact = email.trim().toLowerCase();
  const row = await env.DB.prepare("select 1 from blocked where email = ?1 or email = ?2")
    .bind(exact, exact.replace(/\+[^@]*@/, "@"))
    .first();
  return Boolean(row);
}

export async function blockedOf(env: Env): Promise<Blocked[]> {
  const { results } = await env.DB.prepare(
    "select email, blocked_by as blockedBy from blocked order by blocked_at",
  ).all<Blocked>();
  return results;
}
