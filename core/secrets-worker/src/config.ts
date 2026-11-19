// config.ts — WHAT THE SECRETS WORKER IS TOLD: the config that every Worker of the mind gets
// (iterate/mind-config), and what is its own: its key, and the stack's Realtime SFU app and TURN
// key. Pure: ./env.ts reads it out of the Worker's variables.
// No field names an iterate Cloud: a secret names its Cloud where it is made
// (./cloud-client.ts `cloudOriginOf`).
import { redacted } from "iterate/app-config";
import { mindConfigOf } from "iterate/mind-config";
import { z } from "zod";

const own = {
  atRestKey: redacted(z.string().min(1)),
  /** THE STACK'S REALTIME SFU APP AND TURN KEY AT CLOUDFLARE (./stack-secrets.ts), as the deploy
   *  left them: each one's id and secret, or `refusal`, why the deploy made none (a credential
   *  that may not make Realtime (Calls) resources: core/alchemy src/realtime.ts). No other Worker of the stack gets it. */
  cloudflareRealtime: z.strictObject({
    sfu: z.union([
      z.strictObject({ appId: z.string().min(1), appSecret: redacted(z.string().min(1)) }),
      z.strictObject({ refusal: z.string() }),
    ]),
    turn: z.union([
      z.strictObject({ keyId: z.string().min(1), apiToken: redacted(z.string().min(1)) }),
      z.strictObject({ refusal: z.string() }),
    ]),
  }),
};

/** The Worker's config out of its variables: `ITERATE`, and two secrets. `ITERATE__AT_REST_KEY`:
 *  every secret's value is sealed under it (./secret-at-rest.ts). `ITERATE__CLOUDFLARE_REALTIME`:
 *  the field `cloudflareRealtime`, as JSON. Throws naming the field that is wrong. */
export const secretsConfigOf = (env: object) => mindConfigOf(env, own);
