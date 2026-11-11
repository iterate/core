import { z } from "zod";
import { RequestedFrom, sha256Hex } from "./protocol.ts";

// KV keys, each expiring with its request: `device:<S256 challenge of the device code>`,
// `device-user:<SHA-256 of the user code>` → that key, and `device-poll:<key>`, apart from the
// request so a poll never overwrites an approval written meanwhile.
export const DeviceRequest = z.object({
  // pending → confirmed → approved → redeemed, or → ended with the error its next poll answers
  status: z.enum(["pending", "confirmed", "approved", "redeemed", "ended"]),
  clientId: z.string(),
  clientName: z.string(),
  resource: z.string(),
  requestedFrom: RequestedFrom,
  createdAt: z.number(), // epoch ms
  expiresAt: z.number(),
  // the only person whose consent counts
  confirmedBy: z.string().optional(),
  code: z.string().optional(),
  grant: z.object({ userId: z.string(), grantId: z.string() }).optional(),
  error: z.string().optional(),
  description: z.string().optional(),
  letIn: z
    .object({
      seconds: z.number().int(),
      reason: z.string(),
      signer: z.object({ actor: z.string(), label: z.string(), key: z.string() }).optional(),
    })
    .optional(),
});
export type DeviceRequest = z.infer<typeof DeviceRequest>;

// A row outlives its code, so a late poll reads `expired_token`. KV refuses an expiry under 60 s away.
const ROW_GRACE_SECONDS = 60;
const expirationOf = (request: DeviceRequest) =>
  Math.max(
    Math.ceil(request.expiresAt / 1000) + ROW_GRACE_SECONDS,
    Math.ceil(Date.now() / 1000) + ROW_GRACE_SECONDS,
  );

export function deviceStore(kv: KVNamespace) {
  const userKey = async (userCode: string) => `device-user:${await sha256Hex(userCode)}`;
  const store = {
    async start(key: string, userCode: string, request: DeviceRequest) {
      const byUser = await userKey(userCode);
      if (await kv.get(byUser)) return false;
      await store.put(key, request);
      await kv.put(byUser, key, { expiration: expirationOf(request) });
      return true;
    },

    async byKey(key: string): Promise<DeviceRequest | null> {
      const value = await kv.get(`device:${key}`);
      return value ? DeviceRequest.parse(JSON.parse(value)) : null;
    },

    async byUserCode(userCode: string) {
      const key = await kv.get(await userKey(userCode));
      const request = key ? await store.byKey(key) : null;
      return key && request ? { key, request } : null;
    },

    async put(key: string, request: DeviceRequest) {
      await kv.put(`device:${key}`, JSON.stringify(request), {
        expiration: expirationOf(request),
      });
    },

    // Only a poll in time is written: KV takes one write a second for a key.
    async polledWithin(key: string, seconds: number) {
      const last = Number(await kv.get(`device-poll:${key}`));
      if (last > Date.now() - seconds * 1000) return true;
      await kv.put(`device-poll:${key}`, String(Date.now()), {
        expirationTtl: ROW_GRACE_SECONDS,
      });
      return false;
    },
  };
  return store;
}
