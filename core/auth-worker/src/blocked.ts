// blocked.ts — THE PEOPLE AN OWNER BLOCKED (migrations/0009_blocked.sql). An owner blocks and
// unblocks on /members (./members.ts). Whoever is blocked gets no mailed code, and a session or a
// token of theirs is nobody's from the next request on.
import type { Env } from "./env.ts";

export type Blocked = { email: string; blockedBy: string };

export async function isBlocked(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare("select 1 from blocked where email = ?1")
    .bind(email.trim().toLowerCase())
    .first();
  return Boolean(row);
}

export async function blockedOf(env: Env): Promise<Blocked[]> {
  const { results } = await env.DB.prepare(
    "select email, blocked_by as blockedBy from blocked order by blocked_at",
  ).all<Blocked>();
  return results;
}
