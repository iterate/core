import { jsonEqual } from "iterate/lib";
import { mindMcpUrlOf, mindProvideUrlOf } from "iterate/mind-api";
import { AccountFacts } from "../account-facts.ts";
import { sessionOf } from "../cookies.ts";
import { type Env, issuerOf, iterateConfigOf } from "../env.ts";
import { passkeyOwedResponse, standingOf } from "../members.ts";
import { clientTile } from "../client-mark.ts";
import { errorPage, notMemberPage, page, text, otherAccountForm } from "../pages.ts";
import { signedChangeBy, signerOf, signScript } from "../signed-change.ts";
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

/** What a member's passkey signs to continue, where the mind's config asks for it
 *  (`auth.devices.passkey`). Its fact is the account's own record of the press. */
export const DEVICE_CONFIRMED = "events.iterate.com/account/device-confirmed";

/** THE REQUEST AS THE PAGE SHOWS IT, which is what the passkey signs: this code, this device, what
 *  it reaches, and for a let-in how long and why. A statement for another request continues
 *  nothing. */
export const pressPayloadOf = (userCode: string, device: DeviceRequest) => ({
  userCode,
  clientId: device.clientId,
  clientName: device.clientName,
  resource: device.resource,
  ...(device.letIn && { letIn: { seconds: device.letIn.seconds, reason: device.letIn.reason } }),
});

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
  const pressed = iterateConfigOf(env).devices?.passkey === true;
  if (request.method === "GET") return confirm(env, userCode, device, session.email, { pressed });

  // With the press, only Decline declines: Continue with no signature (a page whose script did
  // not run) says what it takes, and the request waits on.
  const action = form?.get("action");
  if (pressed ? action === "decline" : action !== "confirm") {
    await store.put(found.key, {
      ...device,
      status: "ended",
      error: "access_denied",
      description: "The person declined this sign-in.",
    });
    console.info({ event: "device-login.denied", clientId: device.clientId });
    return seeOther(`${VERIFICATION_PATH}?outcome=declined${device.letIn ? "&kind=let-in" : ""}`);
  }
  const facts = new AccountFacts();
  if (pressed) {
    // A device's token lets one more thing act as this member, so the member's passkey signs the
    // request: the session alone, or a page that posts this form for the member, continues nothing.
    const press = await signedChangeBy(env, form?.get("signed"), DEVICE_CONFIRMED, session.email);
    const refused =
      "refused" in press
        ? `${press.refused}. To continue takes a press of your passkey.`
        : jsonEqual(press.payload, pressPayloadOf(userCode, device))
          ? null
          : "the signed statement is for another request.";
    if (refused || "refused" in press)
      return confirm(env, userCode, device, session.email, {
        pressed,
        error: `The device is not signed in: ${refused}`,
      });
    facts.add(session.userId, {
      type: DEVICE_CONFIRMED,
      payload: { ...pressPayloadOf(userCode, device), ...signerOf(press) },
      idempotencyKey: `account/device-confirmed/${found.key}`,
    });
  }
  await store.put(found.key, { ...device, status: "confirmed", confirmedBy: session.userId });
  console.info({ event: "device-login.confirmed", clientId: device.clientId, pressed });
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
  return facts.on(seeOther(`/oauth2/auth?${authorize}`));
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

/** Who asks, as the consent page shows it (../client-mark.ts): a device gives a name alone, so its
 *  tile is a known client's mark by that name, or its initials. The page's words say that the
 *  name is the device's own claim. */
export const deviceTile = (name: string) => clientTile({ name, redirectUri: "", redirectHost: "" });

function confirm(
  env: Env,
  userCode: string,
  device: DeviceRequest,
  email: string,
  { pressed, error }: { pressed: boolean; error?: string },
) {
  const { domain } = iterateConfigOf(env);
  const where = [device.requestedFrom.city, device.requestedFrom.country]
    .filter(Boolean)
    .join(", ");
  const ago = Math.max(0, Math.round((Date.now() - device.createdAt) / 1000));
  const code = `<p>Continue only if you started this sign-in yourself and the device shows <strong>${text(userCode)}</strong>.</p>`;
  // With the press, Continue has no value of its own: the page's script signs, sets `action` and
  // posts. Decline comes first in the form, so its own value is the one the server reads.
  const buttons = pressed
    ? `<button type="submit" name="action" value="decline" class="secondary">Decline</button>
        <button type="submit" data-continue>Continue with your passkey</button>
        <input type="hidden" name="action" value="" data-action><input type="hidden" name="signed" value="">`
    : `<button type="submit" name="action" value="decline" class="secondary">Decline</button>
        <button type="submit" name="action" value="confirm">Continue</button>`;
  const form = `${error ? `<p role="alert">${text(error)}</p>` : ""}
      <form method="post" class="actions"${pressed ? ` data-press="${text(JSON.stringify(pressPayloadOf(userCode, device)))}"` : ""}>
        <input type="hidden" name="user_code" value="${text(userCode)}">
        ${buttons}
      </form>
      ${pressed ? `<p id="status" class="muted" role="status">Your passkey signs this: a session alone signs in no device.</p>` : ""}
      <div class="muted">Signed in as ${text(email)}. Not you? ${otherAccountForm(`${VERIFICATION_PATH}?${new URLSearchParams({ user_code: userCode })}`)}</div>`;
  const shown = {
    status: error ? 403 : 200,
    ...(pressed && { script: `${signScript(domain)}${PRESS_SCRIPT}` }),
  };
  if (device.letIn) {
    const { signer } = device.letIn;
    const name = signer ? signer.label : device.clientName;
    const proof = signer
      ? `It proved who it is with the key this mind trusts for ${text(signer.actor)} (${text(signer.key.slice(0, 8))}).`
      : "The name is its own claim: nothing proves who asks. Continue only if you know where this request comes from.";
    return page({
      ...shown,
      title: `Let ${name} in?`,
      asker: deviceTile(name),
      body: `<h1>Let ${text(name)} in?</h1>
      <p><strong>${text(name)}</strong> asks to be let in to ${text(domain)}. ${proof}</p>
      <blockquote>${text(device.letIn.reason)}</blockquote>
      <p>If you continue, it can read and change everything in this mind as <strong>${text(email)}</strong> for ${text(durationInWords(device.letIn.seconds))}, counted from your approval. It cannot renew this. When the time is over, it must ask again.</p>
      <p>Continue only if you expected this request. Its code is <strong>${text(userCode)}</strong>.</p>
      ${form}`,
    });
  }
  return page({
    ...shown,
    title: `Sign in ${device.clientName}?`,
    asker: deviceTile(device.clientName),
    body: `<h1>Sign in a device to ${text(domain)}?</h1>
      <p>A device that calls itself <strong>${text(device.clientName)}</strong> asked ${ago} seconds ago${where ? `, from ${text(where)}` : ""}. The name is the device's own claim.</p>
      <p>It wants ${text(resourceInWords(env, device.resource))}, as <strong>${text(email)}</strong>. It can read and change everything in this mind.</p>
      ${code}
      ${form}`,
  });
}

// Continue is a statement one of the person's passkeys signs, of the request as the page says it.
// Decline posts the form as it is.
const PRESS_SCRIPT = `
const form = document.querySelector("form[data-press]");
const status = document.getElementById("status");
form.addEventListener("submit", async (event) => {
  if (!event.submitter?.hasAttribute("data-continue") || form.signed.value) return;
  event.preventDefault();
  try {
    status.textContent = "Waiting for your passkey…";
    form.signed.value = JSON.stringify(await signedStatement({ type: "${DEVICE_CONFIRMED}", payload: JSON.parse(form.dataset.press) }));
    // by its mark, not by its name: the Decline button has the same name
    form.querySelector("[data-action]").value = "confirm";
    form.submit();
  } catch (error) {
    status.textContent = error.name === "NotAllowedError" ? "No passkey was used. Try again." : error.message || "The device is not signed in.";
  }
});`;

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
