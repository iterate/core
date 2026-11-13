import type { IterateContextDurableObject } from "core-itx";
import type { AuthService, MindTarget, SecretsService, TelemetryService } from "iterate/workers";

// Bindings are typed by their iterate/workers interfaces, not workers-types' `Service<…>`, whose
// `Stub` mapping needs a branded entrypoint and turns `unknown` in an event's payload into `never`.
export type DoorEnv = {
  DOMAIN: string;
  AUTH: AuthService;
  SECRETS: SecretsService;
  SECRET_USE: Fetcher;
  SEND_EMAIL: SendEmail;
  /** Where each received mail is forwarded as it arrived (the stack's `mail.forwardTo`). */
  MAIL_FORWARD_TO?: string;
  TELEMETRY?: TelemetryService;
};

export type Env = DoorEnv & {
  MIND: MindTarget;
  /** The stack's Artifacts namespace, which holds the mind's repos (core/alchemy `names.repos`). */
  REPOS_NAMESPACE: string;
};

declare global {
  namespace Cloudflare {
    interface Env extends DoorEnv {
      CONTEXTS: DurableObjectNamespace<IterateContextDurableObject>;
      CF_VERSION_METADATA: WorkerVersionMetadata;
    }
  }
}
