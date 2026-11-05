// src/integrations/connect-flow.ts — A CONNECT FLOW: a connect whose completion is the flow's own
// code rather than a secret's token exchange (secret/durable-object.ts): GitHub's App install and
// authorize today (github.ts). Adding one is a `ConnectFlow` in `CONNECT_FLOWS` (flows.ts): where
// its start link sends the browser, and what to do with the provider's answer. The platform does the
// rest, the same for every flow:
//   - the start link (secret-oauth-start.ts): a random id naming the project, the flow, the
//     connection and the attempt's nonce; its hop asks the flow, as the platform, for the provider's
//     URL (`startTarget`), and binds the browser with a per-start cookie;
//   - one callback, `GET /api/integrations/<flow>/callback`, whose platform-signed `state`
//     (`connectStateOf`, kind "connect") names the same; the shared admission (connect-callback.ts)
//     admits the browser that started it, signed in, reaching the project;
//   - then the flow's `accept`, called as the platform on the project's root (context/built-ins.ts
//     `integrations.acceptConnect`, never published), with the provider's query parameters and who
//     was admitted. Its answer sends the human on: back to the provider (the attempt goes on, under
//     a fresh `state` from `connectStateOf` carrying the same start), or to the landing.

import { signClaims } from "../caller.ts";
import { callbackPage } from "../callback-page.ts";
import { admitCallback, callbackStateOf, notIssuedHere, refused } from "../connect-callback.ts";
import { contextStub } from "../context-stub.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import type { Env } from "../env.ts";
import {
  iterateConfigOf,
  sessionSigningSecretOf,
  type IterateConfigEnv,
  type PlatformAddresses,
} from "../iterate-config.ts";
import { withStartCleared } from "../secret-oauth-start.ts";
import { isRecord } from "../secrets.ts";
import { moveOfferLanding, type IntegrationScope, type MoveOffered } from "./connections.ts";

/** What the provider's redirect brings back to a flow, once the platform admitted it. */
export type ConnectCallback = {
  /** The platform origin the callback reached (`PlatformAddresses`): its callback URL is this
   *  origin's `connectCallbackPathOf(flow)`. */
  platformOrigin: string;
  connection: string;
  nonce: string;
  /** The start the browser proved: a flow that sends the human back to the provider signs it into
   *  the next `state` (`connectStateOf`), so the next callback admits the same browser. */
  start: string;
  /** The provider's query parameters as it sent them, `state` aside. */
  params: Record<string, string>;
  /** Whom the platform admitted. */
  consentedBy: { actor: string; email?: string };
};

export type ConnectAnswer = {
  /** Where the human goes next: the provider again, or the landing; null, the done page. */
  redirect: string | null;
  /** The attempt is over (connected, or offered a move): the start cookie is cleared. */
  finished: boolean;
  /** The account is another project's connection's: the offer to move it here, for the callback to
   *  sign (connections.ts `moveOfferLanding`). */
  move?: MoveOffered;
};

export type ConnectFlow = {
  /** The provider's name, as the callback's pages say it. */
  label: string;
  /** The provider's URL of the attempt in flight whose nonce a start link names: the start hop
   *  alone asks. Throws `GONE` once a newer connect replaced it, it finished or it expired. */
  startTarget(
    scope: IntegrationScope,
    input: { connection: string; nonce: string },
  ): Promise<string>;
  /** The provider sent the admitted human back. Throws a coded error the callback shows. */
  accept(scope: IntegrationScope, input: ConnectCallback): Promise<ConnectAnswer>;
  /** The page of a callback that carries no `state` of ours (GitHub's installation updates), or
   *  absent: such a callback is refused. */
  withoutState?: string;
};

/** The platform-signed `state` a connect flow's redirects carry. */
export type ConnectState = {
  kind: "connect";
  flow: string;
  projectId: string;
  connection: string;
  nonce: string;
  exp: number;
  /** The start that sent this browser to the provider (secret-oauth-start.ts). */
  start?: string;
};

const isConnectState = (claims: unknown): claims is ConnectState =>
  isRecord(claims) &&
  claims.kind === "connect" &&
  typeof claims.flow === "string" &&
  typeof claims.projectId === "string" &&
  typeof claims.connection === "string" &&
  typeof claims.nonce === "string" &&
  typeof claims.exp === "number";

export const connectCallbackPathOf = (flow: string) => `/api/integrations/${flow}/callback`;

/** The `state` a flow puts on the provider's URL: the project, the connection, the attempt's nonce
 *  and expiry, and once a start bound the browser, that start. */
export async function connectStateOf(
  env: IterateConfigEnv,
  state: Omit<ConnectState, "kind">,
): Promise<string> {
  const claims: ConnectState = { kind: "connect", ...state };
  return signClaims(claims, await sessionSigningSecretOf(iterateConfigOf(env)));
}

/** A connect flow's callback: the shared admission, then the flow's `accept` on the project's root,
 *  as the platform. */
export async function connectFlowCallback(
  request: Request,
  env: Env,
  addresses: PlatformAddresses,
  flowName: string,
  flow: Pick<ConnectFlow, "label" | "withoutState">,
): Promise<Response> {
  const url = new URL(request.url);
  if (!url.searchParams.has("state") && flow.withoutState)
    return callbackPage(200, flow.withoutState);
  const claims = await callbackStateOf(url, env, isConnectState);
  if (!claims || claims.flow !== flowName) return notIssuedHere();
  const admitted = await admitCallback(request, env, addresses, {
    start: claims.start,
    owner: {
      name: `project ${claims.projectId}`,
      reachedBy: (controlPlane, reach) => controlPlane.reachesProject(reach, claims.projectId),
    },
  });
  if (refused(admitted)) return admitted;
  const { authorization, start } = admitted;
  const params = Object.fromEntries(url.searchParams);
  delete params.state;
  const input: ConnectCallback & { flow: string } = {
    flow: flowName,
    platformOrigin: addresses.platformOrigin,
    connection: claims.connection,
    nonce: claims.nonce,
    start,
    params,
    consentedBy: {
      actor: authorization.principal.actor,
      email: authorization.principal.email || undefined,
    },
  };
  let answer: ConnectAnswer;
  try {
    // the platform's own call on the project's root; `invoke` is untyped across the DO hop: this is
    // the built-in's declared answer (context/built-ins.ts `integrations.acceptConnect`)
    answer = (await contextStub(
      env.ITERATE_CONTEXT,
      DurableObjectNameCodec.address({ projectId: claims.projectId, path: "/" }),
      "integrations",
    ).invoke(["itx", "builtins", "integrations", ["acceptConnect", input]], [], {
      principal: null,
      platform: true,
    })) as ConnectAnswer;
  } catch (error) {
    return callbackPage(
      400,
      `Connecting ${flow.label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const answered = async (response: Response) =>
    answer.finished ? withStartCleared(response, start) : response;
  if (answer.move)
    return answered(await moveOfferLanding(env, authorization.reach, answer.move, answer.redirect));
  if (answer.redirect)
    return answered(
      new Response(null, {
        status: 303,
        headers: { location: answer.redirect, "cache-control": "no-store" },
      }),
    );
  return answered(callbackPage(200, `Done: ${flow.label} is connected. You can close this tab.`));
}
