import { calculatePKCECodeChallenge } from "oauth4webapi";
import { AccountFacts } from "../account-facts.ts";
import { type Env, issuerOf } from "../env.ts";
import { TOKEN_ENDPOINT, tokenEndpointResponse } from "../oauth.ts";
import { endGrant } from "./callback.ts";
import {
  CALLBACK_PATH,
  DEVICE_CODE_GRANT,
  DevicePollForm,
  formOf,
  oauthError,
  POLL_INTERVAL_SECONDS,
} from "./protocol.ts";
import { refused } from "./start.ts";
import { deviceStore } from "./store.ts";

export async function devicePollResponse(env: Env, request: Request, ctx: ExecutionContext) {
  const fields = await formOf(request.clone());
  if (fields.grant_type !== DEVICE_CODE_GRANT) return null;
  const form = DevicePollForm.safeParse(fields);
  if (!form.success) return refused("invalid_request", "device_code and client_id are required");
  const store = deviceStore(env.OAUTH_KV);
  const key = await calculatePKCECodeChallenge(form.data.device_code);
  const device = await store.byKey(key);
  if (!device || device.clientId !== form.data.client_id)
    return refused("invalid_grant", "Unknown device code");
  // a second short of the interval, so a poll's own lateness never reads as too early
  if (await store.polledWithin(key, POLL_INTERVAL_SECONDS - 1))
    return oauthError("slow_down", "Poll less often: add five seconds to the interval.");

  const facts = new AccountFacts();
  const end = async (event: string, error: string, description: string) => {
    if (device.grant) await endGrant(env, device.grant, facts);
    await store.put(key, { ...device, status: "ended", code: undefined, error, description });
    console.info({ event, clientId: device.clientId });
    return facts.on(oauthError(error, description));
  };
  if (device.status === "ended")
    return oauthError(device.error || "access_denied", device.description || "Ended.");
  if (device.status === "redeemed")
    return end(
      "device-login.failed",
      "invalid_grant",
      "This sign-in was approved, but its tokens never reached the device, so it was ended. Run the sign-in again.",
    );
  // An approval is redeemed even just past the code's five minutes, within the row's minute of
  // grace (./store.ts): a KV read in the device's location may see it up to a minute late.
  const approved = device.status === "approved" && device.code;
  if (!approved && device.expiresAt <= Date.now())
    return end(
      "device-login.expired",
      "expired_token",
      "The code expired before the sign-in finished.",
    );
  if (!approved) return oauthError("authorization_pending", "The person has not answered yet.");

  // Marked first, so no later poll gets tokens. KV has no compare-and-set: two polls at once may
  // both reach the exchange, and the library's single-use code refuses the second.
  await store.put(key, { ...device, status: "redeemed", code: undefined });
  const exchange = new URLSearchParams({
    grant_type: "authorization_code",
    code: approved,
    client_id: device.clientId,
    redirect_uri: `${issuerOf(env)}${CALLBACK_PATH}`,
    code_verifier: form.data.device_code,
    resource: device.resource,
  });
  const answer = await tokenEndpointResponse(
    env,
    new Request(`${issuerOf(env)}${TOKEN_ENDPOINT}`, { method: "POST", body: exchange }),
    ctx,
  );
  console.info({
    event: answer.ok ? "device-login.redeemed" : "device-login.failed",
    clientId: device.clientId,
    status: answer.status,
  });
  // A refused exchange stays `redeemed`, so the next poll ends it and its grant: KV takes one write
  // a second for a key.
  if (!answer.ok || !device.letIn) return answer;
  // Nobody may renew being let in, so the library's refresh token is dropped.
  const { refresh_token: _dropped, ...tokens } = (await answer.json()) as Record<string, unknown>;
  const headers = new Headers(answer.headers);
  headers.delete("content-length");
  return Response.json(tokens, { status: answer.status, headers });
}
