import type { EgressGatewayEnv } from "iterate/lib";
import type {
  AuthService,
  EgressGatewayProviders,
  MindTarget,
  SecretsService,
  TelemetryService,
} from "iterate/workers";
import type { MindTransport } from "./http.ts";

// Bindings are typed by their iterate/workers interfaces, not workers-types' `Service<…>`, whose
// `Stub` mapping needs a branded entrypoint and turns `unknown` in an event's payload into `never`.
// `EgressGatewayEnv`: the stack's egress gateway, when its deploy names one. What the Door sends
// out of the stack goes through it (./rpc.ts).
export type DoorEnv = EgressGatewayEnv & {
  /** The config that every Worker of the mind gets, as JSON (./config.ts reads it). */
  ITERATE: string;
  AUTH: AuthService;
  SECRETS: SecretsService;
  SECRET_USE: Fetcher;
  /** The gateway Worker's entrypoint for the computers that provide its way out: the session's
   *  `provideEgressGateway` (./control-plane-api.ts) and the dial with a ticket (./http.ts). */
  EGRESS_GATEWAY_PROVIDERS?: EgressGatewayProviders;
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
    ): Pick<
      MindTarget,
      | "fetch"
      | "append"
      | "runAct"
      | "receiveEmail"
      | "emailForwardRequest"
      | "emailForwardClaim"
      | "api"
    > &
      Required<Pick<MindTransport, "appendOrKeep">>;
  };
};
