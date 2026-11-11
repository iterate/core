import type { IterateContextDurableObject } from "core-itx";
import type { AuthService, MindTarget, SecretsService, TelemetryService } from "iterate/workers";

// Bindings are typed by their iterate/workers interfaces, not workers-types' `Service<…>`, whose
// `Stub` mapping needs a branded entrypoint and turns `unknown` in an event's payload into `never`.
export type DoorEnv = {
  DOMAIN: string;
  HOSTNAMES: "all" | "platform";
  AUTH: AuthService;
  SECRETS: SecretsService;
  SECRET_USE: Fetcher;
  SEND_EMAIL: SendEmail;
  TELEMETRY?: TelemetryService;
};

export type Env = DoorEnv & {
  MIND: MindTarget;
};

declare global {
  namespace Cloudflare {
    interface Env extends DoorEnv {
      CONTEXTS: DurableObjectNamespace<IterateContextDurableObject>;
      CF_VERSION_METADATA: WorkerVersionMetadata;
    }
  }
}
