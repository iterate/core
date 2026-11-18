// No fact carries the value, sealed or not, and no reduce reads them: a mind may withhold or
// forge a fact in its own log, and the object never takes its word.
import { z } from "zod";
import { SECRET_OPERATIONS, type SecretOperation, type SecretRefresh } from "iterate/api";
import type { Principal } from "iterate/principal";
import type { Envelope } from "iterate/signed";
import type { ApprovalRule } from "../approval.ts";

export const SecretRefreshKind = z.enum([
  "oauth-refresh-token",
  "github-app-installation",
  "worker",
] satisfies SecretRefresh["kind"][]);
export type SecretRefreshKind = z.infer<typeof SecretRefreshKind>;

/** A refresh strategy as a cell holds it: each kind with exactly the fields that
 *  ../secrets.ts `normalizeSecretRecord` and ../secret-oauth.ts `completeSecretOAuth` write. */
const CloudClientName = z.strictObject({
  cloud: z.string().min(1),
  /** The Cloud's own address, kept since the secret was made (../cloud-client.ts). */
  origin: z
    .url({ protocol: /^https$/ })
    .refine((url) => URL.parse(url)?.origin === url, "an origin, with no path"),
});
const StoredRefresh: z.ZodType<SecretRefresh> = z.union([
  z.strictObject({
    kind: z.literal("oauth-refresh-token"),
    tokenEndpoint: z.url({ protocol: /^https$/ }),
    clientAuth: z.enum(["client_secret_basic", "client_secret_post", "none"]),
    /** The iterate Cloud's client that brokers the refresh, and that Cloud's origin, when the
     *  grant was connected through one (../cloud-client.ts). Or the stack's own client at
     *  Cloudflare, by its name (../stack-client.ts). */
    client: z
      .union([CloudClientName, z.strictObject({ stack: z.literal("cloudflare") })])
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("github-app-installation"),
    apiOrigin: z.url({ protocol: /^https$/ }),
    installationId: z.string().min(1),
    client: z.union([z.strictObject({ mind: z.literal("github") }), CloudClientName]),
  }),
  z.strictObject({ kind: z.literal("worker"), source: z.string().min(1) }),
]);

/** A SECRET AS ITS OBJECT STORES IT, and as `exportSealed` hands it out and `importSealed` takes
 *  it back: the sealed cell, and the values of its public fields. STRICT: a cell with a field
 *  that this code does not write, or without one that it does, is no cell. A cell also opens only
 *  with the exact bytes it was sealed with (../secret-at-rest.ts). `public` is not in the seal:
 *  an import takes it only when it matches the opened material. */
export const StoredSecret = z.strictObject({
  cell: z.strictObject({
    context: z.string().min(1),
    urls: z.array(z.string()).min(1),
    refresh: StoredRefresh.nullable(),
    version: z.number().int().positive(),
    nonce: z.string().min(1),
    material: z.strictObject({
      algorithm: z.literal("AES-256-GCM+SECRET-V1"),
      iv: z.string().min(1),
      ciphertext: z.string().min(1),
    }),
    placement: z.enum(["header", "url"]),
    operations: z.array(z.enum(SECRET_OPERATIONS)),
    /** Null: every secret of the mind. */
    lendTo: z.array(z.string()).nullable(),
    statementPaths: z.array(z.string()).optional(),
  }),
  public: z.record(z.string(), z.string()).optional(),
});
export type StoredSecret = z.infer<typeof StoredSecret>;
export type SealedCell = StoredSecret["cell"];

export type SecretFact =
  | {
      type: "events.iterate.com/secret/set";
      payload: {
        path: string;
        urls: string[];
        refresh?: SecretRefreshKind;
        refreshSourceSha256?: string;
        public?: Record<string, string>;
        imported?: true;
        placement: "header" | "url";
        operations: SecretOperation[];
        lendTo: string[] | null;
        statementPaths?: string[];
        by?: { userId: string; email: string };
      };
    }
  | { type: "events.iterate.com/secret/deleted"; payload: { path: string } }
  // the sealed cell left the vault, for a caller that proved the at-rest key
  | { type: "events.iterate.com/secret/exported"; payload: { path: string } }
  // `answerLost`, on a refresh that failed: true when no answer came, so the provider may have
  // issued tokens that never arrived; false when the provider refused.
  | {
      type: "events.iterate.com/secret/refreshed";
      payload: { kind: SecretRefreshKind; ok: boolean; error?: string; answerLost?: boolean };
    }
  // The request as received: its placeholders, never a value.
  | {
      type: "events.iterate.com/secret/used";
      payload: { method: string; url: string; status: number; digest?: string };
    }
  // Never an input or an output of the operation.
  | {
      type: "events.iterate.com/secret/operated";
      payload: { verb: string; outcome: "answered" | "refused"; borrower?: string };
    }
  // `from` is the kernel's claim, not verified.
  | {
      type: "events.iterate.com/secret/approval-requested";
      payload: { digest: string; method: string; url: string; bodyStart: string; from?: string };
    }
  | { type: "events.iterate.com/secret/request-approved"; payload: SignedDecision }
  | {
      type: "events.iterate.com/secret/request-rejected";
      payload: SignedDecision & { reason: string };
    }
  | { type: "events.iterate.com/secret/hold-expired"; payload: { digest: string } }
  | {
      type: "events.iterate.com/secret/approval-rule-configured";
      payload: {
        rule: ApprovalRule | null;
        by?: { userId: string; email: string };
        signer?: Signer;
        signed?: Envelope;
      };
    }
  | {
      type: "events.iterate.com/secret/statement-refused";
      payload: { statementType: string; reason: string; signer: Signer };
    };

export type Signer = { principal: Principal; key: string; label: string; userVerified?: boolean };

type SignedDecision = { digests: string[]; signer: Signer; signed: Envelope };
