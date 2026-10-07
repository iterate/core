// The device logins' rows, beside the OAuth provider's `grant:` rows in the control plane's
// key-value table `oauth_grants` (control-plane/db/definitions.sql), for its read-after-write
// across locations (control-plane/oauth-grants.ts). One row a login, `device:code:<user code>`,
// changed only by compare-and-set, so of two racing writers exactly one wins. Expired rows read as
// absent; the grant table's own purge deletes them.
import { z } from "zod";
import type { Env } from "../env.ts";
import { RequestedFrom, userCodeOf } from "./protocol.ts";

const DeviceRequest = z.object({
  /** pending → confirmed (the page's Continue) → approved (the consent's code) → redeemed (the code
   *  is being, or was, exchanged); or → ended, with the OAuth error its next poll answers */
  status: z.enum(["pending", "confirmed", "approved", "redeemed", "ended"]),
  /** the SHA-256 of the device code, hex: what the poll and the callback's `state` must name */
  hash: z.string(),
  clientId: z.string(),
  /** the name the client registered: self-declared, and the page says so */
  clientName: z.string(),
  codeChallenge: z.string(),
  resource: z.string(),
  requestedFrom: RequestedFrom,
  /** epoch ms */
  createdAt: z.number(),
  expiresAt: z.number(),
  /** the person who confirmed the code on the page: the one who may answer it */
  confirmedBy: z.string().optional(),
  code: z.string().optional(),
  /** the grant the code belongs to, ended if the sign-in fails after the consent */
  grant: z.object({ userId: z.string(), grantId: z.string() }).optional(),
  error: z.string().optional(),
  description: z.string().optional(),
});
type DeviceRequest = z.infer<typeof DeviceRequest>;

/** A request as read: its user code, the row's value (what a `swap` compares) and the request. */
export type StoredRequest = { userCode: string; value: string; request: DeviceRequest };

/** Rows outlive the code by this much, so a poll just after expiry reads `expired_token`, and a
 *  poll after a lost answer still finds what happened. */
const ROW_GRACE_MS = 5 * 60_000;

const requestKey = (userCode: string) => `device:code:${userCode}`;
const blockKey = (userId: string) => `device:lookups-blocked:${userId}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The rows of `env.DB`'s device logins. */
export function deviceStore(env: Pick<Env, "DB">) {
  const db = env.DB;
  const read = async (key: string) =>
    (
      await db
        .prepare("select value from oauth_grants where key = ?1 and expires_at > ?2")
        .bind(key, nowSeconds())
        .first<{ value: string }>()
    )?.value ?? null;
  /** Insert a row unless a live one holds the key; an expired one is taken over. */
  const insert = async (key: string, value: string, expiresAtMs: number) =>
    (
      await db
        .prepare(
          `insert into oauth_grants (key, value, expires_at) values (?1, ?2, ?3)
           on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
           where oauth_grants.expires_at <= ?4`,
        )
        .bind(key, value, Math.ceil(expiresAtMs / 1000), nowSeconds())
        .run()
    ).meta.changes === 1;

  return {
    /** Store `request` under its user code: false when a live request holds that code. */
    start(userCode: string, request: DeviceRequest) {
      return insert(
        requestKey(userCode),
        JSON.stringify(request),
        request.expiresAt + ROW_GRACE_MS,
      );
    },

    async byUserCode(userCode: string): Promise<StoredRequest | null> {
      const value = await read(requestKey(userCode));
      return value ? { userCode, value, request: DeviceRequest.parse(JSON.parse(value)) } : null;
    },

    /** The request of the device code whose SHA-256 is `hash`: its user code's row, if the row is
     *  still that device code's, not a later request's that drew the same user code. */
    async byHash(hash: string) {
      const userCode = userCodeOf(hash);
      const found = userCode ? await this.byUserCode(userCode) : null;
      return found?.request.hash === hash ? found : null;
    },

    /** Move `found` to `next`, only if its row still holds the value `found` read: the row as this
     *  call wrote it, or null when another writer changed it first. */
    async swap(found: StoredRequest, next: DeviceRequest): Promise<StoredRequest | null> {
      const value = JSON.stringify(next);
      const result = await db
        .prepare("update oauth_grants set value = ?1 where key = ?2 and value = ?3")
        .bind(value, requestKey(found.userCode), found.value)
        .run();
      return result.meta.changes === 1 ? { ...found, value, request: next } : null;
    },

    async lookupsBlocked(userId: string) {
      return Boolean(await read(blockKey(userId)));
    },

    async blockLookups(userId: string, untilMs: number) {
      await insert(blockKey(userId), "{}", untilMs);
    },

    /** How many requests are live, counted up to `cap`: the key range of the request rows. */
    async liveRequests(cap: number) {
      const counted = await db
        .prepare(
          `select count(*) as live from (select 1 from oauth_grants
           where key > 'device:code:' and key < 'device:code;' and expires_at > ?1 limit ?2)`,
        )
        .bind(nowSeconds(), cap)
        .first<{ live: number }>();
      return counted?.live ?? 0;
    },
  };
}
