// No fact carries the value, sealed or not, and no reduce reads them: a project may withhold or
// forge a fact in its own log, and the object never takes its word.
import { z } from "zod";
import type { SecretOperation, SecretRefresh } from "iterate/api";
import type { Principal } from "iterate/principal";
import type { Envelope } from "iterate/signed";
import type { ApprovalRule } from "../approval.ts";

export const SecretRefreshKind = z.enum([
  "oauth-refresh-token",
  "github-app-installation",
  "worker",
] satisfies SecretRefresh["kind"][]);
export type SecretRefreshKind = z.infer<typeof SecretRefreshKind>;

const EncryptedMaterial = z.object({
  algorithm: z.literal("AES-256-GCM+SECRET-V1"),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
});

// Stored cells: `placement` and `operations` are absent from a cell sealed before records said what
// a secret may be used for, `lendTo` from one sealed before they said whom it lends to.
export type SealedCell = {
  context: string;
  urls: string[];
  refresh: SecretRefresh | null;
  version: number;
  nonce: string;
  material: z.infer<typeof EncryptedMaterial>;
  placement?: "header" | "url";
  operations?: SecretOperation[];
  lendTo?: string[] | null;
};

export const LegacySealedCell = z.object({
  context: z.string().min(1),
  urls: z.array(z.string()).min(1),
  refresh: z.custom<SecretRefresh | null>((value) => !value || Object.hasOwn(value, "kind")),
  nonce: z.string().min(1),
  material: EncryptedMaterial,
});

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
        by?: { userId: string; email: string };
      };
    }
  | { type: "events.iterate.com/secret/deleted"; payload: { path: string } }
  | {
      type: "events.iterate.com/secret/refreshed";
      payload: { kind: SecretRefreshKind; ok: boolean; error?: string };
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
