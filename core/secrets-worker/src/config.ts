// config.ts — WHAT THE SECRETS WORKER IS TOLD: the config that every Worker of the mind gets
// (iterate/mind-config), and what is its own: its key, and the stack's OAuth client at
// Cloudflare. Pure: ./env.ts reads it out of the Worker's variables.
// No field names an iterate Cloud: a secret names its Cloud where it is made
// (./cloud-client.ts `cloudOriginOf`).
import { redacted } from "iterate/app-config";
import { mindConfigOf } from "iterate/mind-config";
import { z } from "zod";

const own = {
  atRestKey: redacted(z.string().min(1)),
  /** THE STACK'S OWN OAUTH CLIENT AT CLOUDFLARE (./stack-client.ts), as the deploy left it: the
   *  client's id and its secret, or `refusal`, Cloudflare's words for why the deploy made no
   *  client (a credential that may not make OAuth clients: core/alchemy
   *  src/cloudflare-oauth-client.ts). No other Worker of the stack gets it. */
  cloudflareClient: z.union([
    z.strictObject({
      clientId: z.string().min(1),
      clientSecret: redacted(z.string().min(1)),
    }),
    z.strictObject({ refusal: z.string() }),
  ]),
  /** The Cloudflare account that the stack runs in: a grant through the stack's client must
   *  reach it alone (./stack-client.ts `stackGrantRefusal`). */
  cloudflareAccountId: z.string().regex(/^[0-9a-f]{32}$/, "a Cloudflare account id"),
};

/** The Worker's config out of its variables: `ITERATE`, `ITERATE__CLOUDFLARE_ACCOUNT_ID` (the
 *  field `cloudflareAccountId`), and two secrets. `ITERATE__AT_REST_KEY`:
 *  every secret's value is sealed under it (./secret-at-rest.ts). `ITERATE__CLOUDFLARE_CLIENT`:
 *  the field `cloudflareClient`, as JSON. Throws naming the field that is wrong. */
export const secretsConfigOf = (env: object) => mindConfigOf(env, own);
