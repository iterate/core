import type { Env } from "../env.ts";

const WINDOW_MS = 10 * 60_000;

// Per kind, per window: 20 a client, 120 the stack, which bounds what a stranger with many addresses
// can make it store. One statement, so two at once cannot both pass. ?1 kind, ?2 client, ?3 now.
const ADMIT = `insert into admissions (kind, client, created_at)
select ?1, ?2, ?3
where (?2 is null or (select count(*) from admissions
                      where kind = ?1 and client = ?2 and created_at > ?3 - ${WINDOW_MS})
                     < 20)
  and (select count(*) from admissions where kind = ?1 and created_at > ?3 - ${WINDOW_MS})
      < 120
returning 1 as admitted`;

export async function admitted(env: Env, kind: "device" | "registration", request: Request) {
  const now = Date.now();
  const [, added] = await env.DB.batch([
    env.DB.prepare("delete from admissions where created_at <= ?1").bind(now - WINDOW_MS),
    env.DB.prepare(ADMIT).bind(kind, request.headers.get("cf-connecting-ip") || null, now),
  ]);
  const allowed = Boolean(added?.results[0]);
  if (!allowed) console.warn({ event: "auth.admission-refused", kind });
  return allowed;
}

export const TOO_MANY =
  "Too many sign-ins were started here just now. Wait ten minutes, then try again.";
