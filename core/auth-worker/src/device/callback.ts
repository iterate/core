import { AccountFacts } from "../account-facts.ts";
import { sessionOf } from "../cookies.ts";
import { type Env, issuerOf } from "../env.ts";
import { oauthHelpers } from "../oauth.ts";
import { VERIFICATION_PATH } from "./protocol.ts";
import { type DeviceRequest, deviceStore } from "./store.ts";

export async function deviceCallbackResponse(env: Env, request: Request) {
  const url = new URL(request.url);
  const facts = new AccountFacts();
  const store = deviceStore(env.OAUTH_KV);
  const key = url.searchParams.get("state") || "";
  const device =
    url.searchParams.get("iss") === issuerOf(env) && /^[\w-]{43}$/.test(key)
      ? await store.byKey(key)
      : null;
  const outcome = (to: "approved" | "declined" | "failed") =>
    facts.on(
      new Response(null, {
        status: 303,
        headers: {
          location: `${VERIFICATION_PATH}?${new URLSearchParams({ outcome: to, ...(device?.letIn && { kind: "let-in" }) })}`,
          "cache-control": "no-store",
        },
      }),
    );
  const code = url.searchParams.get("code");
  const codeGrant = code ? grantOfCode(code) : null;
  if (codeGrant && device?.grant?.grantId === codeGrant.grantId) return outcome("approved");
  const person = (await sessionOf(env, request))?.userId || null;
  const ownGrant = codeGrant && codeGrant.userId === person ? codeGrant : null;
  const refusal = callbackRefusal(device, person, !code || Boolean(ownGrant));
  if (!device || refusal) {
    // A grant is ended only for a device this person confirmed: a code's ids are its text, which
    // anyone can put in a link, so a bare GET here must not end a grant of the person who opens it.
    if (ownGrant && device?.confirmedBy === person) await endGrant(env, ownGrant, facts);
    console.warn({ event: "device-login.callback-refused", reason: refusal });
    return outcome("failed");
  }
  // past the refusals, no code is the consent's refusal
  if (!code || !ownGrant) {
    const error = url.searchParams.get("error") || "access_denied";
    const description = url.searchParams.get("error_description") || "The person declined.";
    await store.put(key, { ...device, status: "ended", error, description });
    console.info({ event: "device-login.denied", clientId: device.clientId, error });
    return outcome(error === "access_denied" ? "declined" : "failed");
  }
  await store.put(key, { ...device, status: "approved", code, grant: ownGrant });
  console.info({ event: "device-login.approved", clientId: device.clientId });
  return outcome("approved");
}

function callbackRefusal(device: DeviceRequest | null, person: string | null, codeIsOwn: boolean) {
  if (!device) return "unknown";
  if (device.expiresAt <= Date.now()) return "expired";
  if (device.status !== "confirmed") return "not-confirmed";
  if (!person || device.confirmedBy !== person) return "other-session";
  if (!codeIsOwn) return "other-grant";
  return null;
}

// The library's codes are `<userId>:<grantId>:<secret>`.
function grantOfCode(code: string) {
  const [userId, grantId, secret] = code.split(":");
  return userId && grantId && secret ? { userId, grantId } : null;
}

export async function endGrant(
  env: Env,
  grant: { userId: string; grantId: string },
  facts: AccountFacts,
) {
  await oauthHelpers(env).revokeGrant(grant.grantId, grant.userId);
  facts.add(grant.userId, {
    type: "events.iterate.com/account/grant-ended",
    payload: { grantId: grant.grantId },
    idempotencyKey: `account/grant-ended/${grant.grantId}`,
  });
}
