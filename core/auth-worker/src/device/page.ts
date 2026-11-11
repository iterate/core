import { mindMcpUrlOf, mindProvideUrlOf } from "iterate/mind-api";
import { sessionOf } from "../cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "../env.ts";
import { passkeyOwedResponse, standingOf } from "../members.ts";
import { errorPage, notMemberPage, page, text } from "../pages.ts";
import { signInHref } from "../sign-in.ts";
import { CALLBACK_PATH, normalizeUserCode, VERIFICATION_PATH } from "./protocol.ts";
import { type DeviceRequest, deviceStore } from "./store.ts";

const OUTCOMES = {
  approved: "The device is signed in. You can close this page.",
  declined: "You declined. The device is not signed in.",
  failed: "This sign-in did not finish. Start it again on the device.",
} as const;
const LET_IN_OUTCOMES = {
  approved: "You let it in, for the time it asked. You can close this page.",
  declined: "You declined. It is not let in.",
  failed: "This did not finish. It is not let in, and it must ask again.",
} as const;

export async function devicePageResponse(env: Env, request: Request) {
  const url = new URL(request.url);
  const outcome = url.searchParams.get("outcome");
  if (request.method === "GET" && outcome && outcome in OUTCOMES) {
    const letIn = url.searchParams.get("kind") === "let-in";
    const title = letIn ? "Let in" : "Device sign-in";
    const words = (letIn ? LET_IN_OUTCOMES : OUTCOMES)[outcome as keyof typeof OUTCOMES];
    return page({ title, body: `<h1>${title}</h1><p>${text(words)}</p>` });
  }
  if (request.method === "POST" && request.headers.get("origin") !== issuerOf(env))
    return errorPage("Confirm this device from its own page.", 403);
  const form = request.method === "POST" ? await request.formData().catch(() => null) : null;
  const typed = String(form?.get("user_code") ?? url.searchParams.get("user_code") ?? "");
  const session = await sessionOf(env, request);
  const here = typed
    ? `${VERIFICATION_PATH}?${new URLSearchParams({ user_code: typed })}`
    : VERIFICATION_PATH;
  if (!session) return seeOther(signInHref(env, here));
  const { domain } = iterateConfigOf(env);
  const standing = await standingOf(env, session);
  if (standing === "not-member") return notMemberPage({ domain, email: session.email });
  if (standing === "passkey-owed") return passkeyOwedResponse(here);
  if (!typed) return enter(domain);
  const userCode = normalizeUserCode(typed);
  if (!userCode) return enter(domain, typed, "A code is eight letters, like WDJB-MJHT.");
  const store = deviceStore(env.OAUTH_KV);
  const found = await store.byUserCode(userCode);
  const device = found?.request;
  const waits =
    device &&
    device.expiresAt > Date.now() &&
    (device.status === "pending" ||
      (device.status === "confirmed" && device.confirmedBy === session.userId));
  if (!found || !waits)
    return enter(domain, userCode, "No device is waiting for this code. It may have expired.");
  if (request.method === "GET") return confirm(env, userCode, device, session.email);

  if (form?.get("action") !== "confirm") {
    await store.put(found.key, {
      ...device,
      status: "ended",
      error: "access_denied",
      description: "The person declined this sign-in.",
    });
    console.info({ event: "device-login.denied", clientId: device.clientId });
    return seeOther(`${VERIFICATION_PATH}?outcome=declined${device.letIn ? "&kind=let-in" : ""}`);
  }
  await store.put(found.key, { ...device, status: "confirmed", confirmedBy: session.userId });
  console.info({ event: "device-login.confirmed", clientId: device.clientId });
  // `state` and the PKCE challenge are both the store's key (./start.ts)
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: device.clientId,
    redirect_uri: `${issuerOf(env)}${CALLBACK_PATH}`,
    scope: "iterate",
    state: found.key,
    code_challenge: found.key,
    code_challenge_method: "S256",
    resource: device.resource,
  });
  return seeOther(`/oauth2/auth?${authorize}`);
}

function enter(domain: string, typed = "", error?: string) {
  return page({
    title: `Sign in a device to ${domain}`,
    status: error ? 400 : 200,
    body: `<h1>Sign in a device to ${text(domain)}</h1>
      <p class="muted">Enter the code the device shows.</p>
      ${error ? `<p role="alert">${text(error)}</p>` : ""}
      <form method="get" class="stack">
        <label>Code <input name="user_code" value="${text(typed)}" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
        <button type="submit">Next</button>
      </form>`,
  });
}

function confirm(env: Env, userCode: string, device: DeviceRequest, email: string) {
  const { domain } = iterateConfigOf(env);
  const where = [device.requestedFrom.city, device.requestedFrom.country]
    .filter(Boolean)
    .join(", ");
  const ago = Math.max(0, Math.round((Date.now() - device.createdAt) / 1000));
  const code = `<p>Continue only if you started this sign-in yourself and the device shows <strong>${text(userCode)}</strong>.</p>`;
  const form = `<form method="post" class="actions">
        <input type="hidden" name="user_code" value="${text(userCode)}">
        <button type="submit" name="action" value="decline" class="secondary">Decline</button>
        <button type="submit" name="action" value="confirm">Continue</button>
      </form>`;
  if (device.letIn) {
    const { signer } = device.letIn;
    const name = signer ? signer.label : device.clientName;
    const proof = signer
      ? `It proved who it is with the key this mind trusts for ${text(signer.actor)} (${text(signer.key.slice(0, 8))}).`
      : "The name is its own claim: nothing proves who asks. Continue only if you know where this request comes from.";
    return page({
      title: `Let ${name} in?`,
      body: `<h1>Let ${text(name)} in?</h1>
      <p><strong>${text(name)}</strong> asks to be let in to ${text(domain)}. ${proof}</p>
      <blockquote>${text(device.letIn.reason)}</blockquote>
      <p>If you continue, it can read and change everything in this mind as <strong>${text(email)}</strong> for ${text(durationInWords(device.letIn.seconds))}, counted from your approval. It cannot renew this. When the time is over, it must ask again.</p>
      <p>Continue only if you expected this request. Its code is <strong>${text(userCode)}</strong>.</p>
      ${form}`,
    });
  }
  return page({
    title: `Sign in ${device.clientName}?`,
    body: `<h1>Sign in a device to ${text(domain)}?</h1>
      <p>A device that calls itself <strong>${text(device.clientName)}</strong> asked ${ago} seconds ago${where ? `, from ${text(where)}` : ""}. The name is the device's own claim.</p>
      <p>It wants ${text(resourceInWords(env, device.resource))}, as <strong>${text(email)}</strong>. It can read and change everything in this mind.</p>
      ${code}
      ${form}`,
  });
}

function durationInWords(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

function resourceInWords(env: Env, resource: string) {
  const { domain } = iterateConfigOf(env);
  if (resource === mindMcpUrlOf(domain)) return "the mind's MCP server";
  if (resource === mindProvideUrlOf(domain))
    return "to run the mind from that computer (its /provide link)";
  return "the mind's API";
}

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
