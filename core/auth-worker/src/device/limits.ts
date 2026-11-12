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

/** The client a limit counts a request for: the address the edge names, or the mind's own
 *  requests' one address, which the boundary sets (core/boundary-worker `own-request.ts`). A
 *  request with no address at all is counted too, all such as one client: no caller is exempt from
 *  the per-client limit, or it could use up the stack's and stop the members' sign-ins. */
export function clientOf(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "no-address";
}

/** `host-client` alone is asked with no client: the boundary asks for a visitor it does not name,
 *  so the stack's own count holds it. */
export async function admitted(
  env: Env,
  kind: "device" | "registration" | "host-client",
  request: Request,
) {
  const now = Date.now();
  const client = kind === "host-client" ? null : clientOf(request);
  const [, added] = await env.DB.batch([
    env.DB.prepare("delete from admissions where created_at <= ?1").bind(now - WINDOW_MS),
    env.DB.prepare(ADMIT).bind(kind, client, now),
  ]);
  const allowed = Boolean(added?.results[0]);
  if (!allowed) console.warn({ event: "auth.admission-refused", kind });
  return allowed;
}

export const TOO_MANY =
  "Too many sign-ins were started here just now. Wait ten minutes, then try again.";
