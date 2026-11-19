import type { AuthService, MindTarget, SecretsService, TelemetryService } from "iterate/workers";

// Bindings are typed by their iterate/workers interfaces, not workers-types' `Service<…>`, whose
// `Stub` mapping needs a branded entrypoint and turns `unknown` in an event's payload into `never`.
export type DoorEnv = {
  /** The config that every Worker of the mind gets, as JSON (./config.ts reads it). */
  ITERATE: string;
  AUTH: AuthService;
  SECRETS: SecretsService;
  SECRET_USE: Fetcher;
  SEND_EMAIL: SendEmail;
  /** Where each received mail is forwarded as it arrived (the stack's `mail.forwardTo`). */
  MAIL_FORWARD_TO?: string;
  TELEMETRY: TelemetryService;
};

/** The mind, by the config's `topology` (./mind-transport.ts): a deploy makes the one binding of
 *  its topology and not the other. */
export type Env = DoorEnv & {
  /** `full-cloudflare`: the mind Worker's `Mind` entrypoint. */
  MIND?: MindTarget;
  /** `external-mind-connects-into-cloudflare-boundary`: the namespace of `ProvidedMind`
   *  (./provided-mind.ts), typed by what the boundary calls on its one instance. */
  PROVIDED_MIND?: {
    getByName(
      name: string,
    ): Pick<MindTarget, "fetch" | "append" | "runAct" | "receiveEmail" | "api">;
  };
};
