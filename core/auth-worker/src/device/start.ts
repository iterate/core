import { CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { calculatePKCECodeChallenge, generateRandomCodeVerifier } from "oauth4webapi";
import { type Env, issuerOf, iterateConfigOf } from "../env.ts";
import { personKeyRefusal, verifiedStatement } from "../keys.ts";
import { authorizationServer, oauthHelpers } from "../oauth.ts";
import {
  CALLBACK_PATH,
  DEVICE_AUTHORIZATION_PATH,
  DEVICE_CODE_GRANT,
  DEVICE_CODE_SECONDS,
  DeviceAuthorizationForm,
  DeviceRegistration,
  formOf,
  LET_IN_MAX_SECONDS,
  LET_IN_STATEMENT_TYPE,
  LET_IN_MIN_SECONDS,
  LET_IN_WAIT_SECONDS,
  newUserCode,
  oauthError,
  POLL_INTERVAL_SECONDS,
  RequestedFrom,
  VERIFICATION_PATH,
} from "./protocol.ts";
import { admitted, TOO_MANY } from "./limits.ts";
import { type DeviceRequest, deviceStore } from "./store.ts";

export async function metadataResponse(env: Env, request: Request, ctx: ExecutionContext) {
  const answer = await authorizationServer(env).fetch(request, env, ctx);
  if (!answer.ok) return answer;
  const metadata = (await answer.json()) as Record<string, unknown>;
  const grants = Array.isArray(metadata.grant_types_supported)
    ? metadata.grant_types_supported
    : [];
  const headers = new Headers(answer.headers);
  headers.delete("content-length");
  return Response.json(
    {
      ...metadata,
      device_authorization_endpoint: `${issuerOf(env)}${DEVICE_AUTHORIZATION_PATH}`,
      grant_types_supported: [...grants, DEVICE_CODE_GRANT],
    },
    { headers },
  );
}

// The library has no device grant, so a device redeems through its code exchange, which needs a
// redirect URI and PKCE: this registers a public client whose one redirect is the device callback.
export async function deviceRegistrationResponse(
  env: Env,
  request: Request,
  ctx: ExecutionContext,
) {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const asked = DeviceRegistration.safeParse(body);
  if (!asked.success) return null;
  const registration = await authorizationServer(env).fetch(
    new Request(request.url, {
      method: "POST",
      // the registration's limit counts this address (../oauth.ts)
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": request.headers.get("cf-connecting-ip") || "",
      },
      body: JSON.stringify({
        client_name: asked.data.client_name || "a device",
        redirect_uris: [`${issuerOf(env)}${CALLBACK_PATH}`],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
    env,
    ctx,
  );
  if (!registration.ok) return registration;
  const registered = (await registration.json()) as Record<string, unknown>;
  console.info({ event: "device-login.client-registered", clientId: registered.client_id });
  return Response.json(
    { ...registered, grant_types: [DEVICE_CODE_GRANT, "refresh_token"] },
    { status: registration.status, headers: { "cache-control": "no-store" } },
  );
}

export async function deviceAuthorizationResponse(env: Env, request: Request) {
  const form = DeviceAuthorizationForm.safeParse(await formOf(request));
  if (!form.success)
    return refused(
      "invalid_request",
      `client_id and resource are required. To be let in, send access_seconds (a whole number from ${LET_IN_MIN_SECONDS} to ${LET_IN_MAX_SECONDS}) and a reason (1 to 300 characters), both or neither; signed only with them.`,
    );
  const { client_id: clientId, resource, access_seconds: seconds, reason, signed } = form.data;
  if (form.data.scope.split(" ").some((scope) => scope && scope !== "iterate"))
    return refused("invalid_scope", "The device sign-in grants the iterate scope alone.");
  if (!iterateConfigOf(env).resources.includes(resource))
    return refused("invalid_target", "The device sign-in is for the mind's API, MCP or /provide.");
  const callback = `${issuerOf(env)}${CALLBACK_PATH}`;
  const client = await oauthHelpers(env)
    .lookupClient(clientId)
    .catch((error: unknown) => {
      if (error instanceof CimdFetchError) return null;
      throw error;
    });
  if (!client) return refused("invalid_client", "Unknown client", 401);
  if (client.tokenEndpointAuthMethod !== "none" || !client.redirectUris.includes(callback))
    return refused("unauthorized_client", "Register this client for the device grant first.");
  let letIn: DeviceRequest["letIn"];
  if (seconds && reason) {
    const signer = signed
      ? await signerOf(env, signed, { client: clientId, seconds, reason })
      : null;
    if (signer && "refused" in signer) return refused("invalid_request", signer.refused);
    letIn = { seconds, reason, signer: signer || undefined };
  }
  const waitSeconds = letIn ? LET_IN_WAIT_SECONDS : DEVICE_CODE_SECONDS;
  // not `slow_down`: the iterate CLI reads that only on a poll of the token endpoint
  if (!(await admitted(env, "device", request)))
    return refused("temporarily_unavailable", TOO_MANY, 429);

  // The device code is the PKCE verifier and its S256 challenge the store's key: only the device,
  // which holds the code, can name the row or redeem it.
  const deviceCode = generateRandomCodeVerifier();
  const key = await calculatePKCECodeChallenge(deviceCode);
  const now = Date.now();
  const requestedFrom = RequestedFrom.parse(request.cf ?? {});
  // three taken codes in a row mean the store answers wrongly, not chance
  for (let attempt = 0; attempt < 3; attempt++) {
    const userCode = newUserCode();
    const stored = await deviceStore(env.OAUTH_KV).start(key, userCode, {
      status: "pending",
      clientId,
      clientName: client.clientName || clientId,
      resource,
      requestedFrom,
      createdAt: now,
      expiresAt: now + waitSeconds * 1000,
      letIn,
    });
    if (!stored) continue;
    console.info({
      event: "device-login.started",
      clientId,
      country: requestedFrom.country,
      letIn: Boolean(letIn),
      signer: letIn?.signer?.actor,
    });
    const verificationUri = `${issuerOf(env)}${VERIFICATION_PATH}`;
    return Response.json(
      {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?${new URLSearchParams({ user_code: userCode })}`,
        expires_in: waitSeconds,
        interval: POLL_INTERVAL_SECONDS,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  throw new Error("Three fresh user codes were all taken.");
}

// The payload must be exactly what is asked, so a statement cannot be moved to another client,
// time or reason. The key's paths do not matter: nothing is appended.
async function signerOf(
  env: Env,
  signed: string,
  asked: { client: string; seconds: number; reason: string },
) {
  let value: unknown;
  try {
    value = JSON.parse(signed);
  } catch {
    return { refused: "signed is not JSON" };
  }
  const verified = await verifiedStatement(env, value);
  if ("refused" in verified) return verified;
  const { type, payload = {} } = verified.statement;
  if (type !== LET_IN_STATEMENT_TYPE)
    return { refused: `the statement is not ${LET_IN_STATEMENT_TYPE}` };
  if (
    Object.keys(payload).length !== 3 ||
    payload.client !== asked.client ||
    payload.seconds !== asked.seconds ||
    payload.reason !== asked.reason
  )
    return { refused: "the statement's payload is not { client, seconds, reason } as asked" };
  // the page says "the key this mind trusts": a removed member's key is not one
  const notThisPerson = personKeyRefusal(verified.signer);
  if (notThisPerson) return { refused: notThisPerson };
  const { principal, label, key } = verified.signer;
  return { actor: principal.actor, label, key };
}

export function refused(error: string, description: string, status = 400) {
  console.warn({ event: "oauth.refusal", category: "device-login", code: error });
  return oauthError(error, description, status);
}
