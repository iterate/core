import { jsonEqual } from "iterate/lib";
import { mindMcpUrlOf, mindProvideConnectResourceOf } from "iterate/mind-api";
import { AccountFacts } from "../account-facts.ts";
import { sessionOf } from "../cookies.ts";
import { configOf, type Env, issuerOf } from "../env.ts";
import { isMember } from "../members.ts";
import { clientTile } from "../client-mark.ts";
import { errorPage, factsTable, notMemberPage, otherAccountForm, page, text } from "../pages.ts";
import { signedChangeBy, signerOf, signScript } from "../signed-change.ts";
import { mindMarkOf } from "../mind-mark.ts";
import { signInHref } from "../sign-in.ts";
import { CALLBACK_PATH, normalizeUserCode, VERIFICATION_PATH } from "./protocol.ts";
import { type DeviceRequest, deviceStore } from "./store.ts";

const OUTCOMES = {
  approved: "The device is signed in. You can close this page.",
  declined: "You declined. The device is not signed in.",
  failed: "This sign-in did not finish. Start it again on the device.",
} as const;
/** A code that a member approved, opened again (a reload, the browser's back, an in-app browser
 *  that opens the link once more): its row stays, `approved` or `redeemed`, until a minute after
 *  the code's own end (./store.ts), and says so in place of "no device is waiting". */
const USED = {
  device: "This code was used: the device is signed in. You can close this page.",
  letIn: "This code was used: it is let in. You can close this page.",
} as const;
const LET_IN_OUTCOMES = {
  approved: "You let it in, for the time it asked. You can close this page.",
  declined: "You declined. It is not let in.",
  failed: "This did not finish. It is not let in, and it must ask again.",
} as const;

/** WHAT A MEMBER'S PASSKEY SIGNS TO CONTINUE. "Sign in a device" and "Let … in" give a device, or
 *  an agent somewhere else, a token for the whole mind as the member who continues. So Continue is
 *  a statement that one of the member's passkeys signs, with the member checked (a PIN, a
 *  fingerprint or a face), as allowing a key is (../keys-pages.ts): a stolen session signs in no
 *  device. Its fact is the account's own record of the press. */
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
  if (!session) return seeOther(signInHref(here));
  const mind = configOf(env).controlPlaneHostname;
  if (!(await isMember(env, session.email))) return notMemberPage({ mind, email: session.email });
  if (!typed) return enter(mind);
  const userCode = normalizeUserCode(typed);
  if (!userCode) return enter(mind, typed, "A code is eight letters, like WDJB-MJHT.");
  const store = deviceStore(env.OAUTH_KV);
  const found = await store.byUserCode(userCode);
  const device = found?.request;
  if (device?.status === "approved" || device?.status === "redeemed") {
    const title = device.letIn ? "Let in" : "Device sign-in";
    const words = device.letIn ? USED.letIn : USED.device;
    return page({ title, body: `<h1>${title}</h1><p>${text(words)}</p>` });
  }
  const waits =
    device &&
    device.expiresAt > Date.now() &&
    (device.status === "pending" ||
      (device.status === "confirmed" && device.confirmedBy === session.userId));
  if (!found || !waits)
    return enter(mind, userCode, "No device is waiting for this code. It may have expired.");
  if (request.method === "GET") return await confirm(env, userCode, device, session.email);

  // Only Decline declines: Continue with no signature (a page whose script did not run) says
  // what it takes, and the request waits on.
  if (form?.get("action") === "decline") {
    await store.put(found.key, {
      ...device,
      status: "ended",
      error: "access_denied",
      description: "The person declined this sign-in.",
    });
    console.info({ event: "device-login.denied", clientId: device.clientId });
    return seeOther(`${VERIFICATION_PATH}?outcome=declined${device.letIn ? "&kind=let-in" : ""}`);
  }
  // The session alone, or a page that posts this form for the member, continues nothing.
  const press = await signedChangeBy(env, form?.get("signed"), DEVICE_CONFIRMED, session.email);
  const refused =
    "refused" in press
      ? `${press.refused}. To continue takes a press of your passkey.`
      : jsonEqual(press.payload, pressPayloadOf(userCode, device))
        ? null
        : "the signed statement is for another request.";
  if (refused || "refused" in press)
    return await confirm(
      env,
      userCode,
      device,
      session.email,
      `The device is not signed in: ${refused}`,
    );
  const facts = new AccountFacts();
  facts.add(session.userId, {
    type: DEVICE_CONFIRMED,
    payload: { ...pressPayloadOf(userCode, device), ...signerOf(press) },
    idempotencyKey: `account/device-confirmed/${found.key}`,
  });
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
  return facts.on(seeOther(`/oauth2/auth?${authorize}`));
}

function enter(mind: string, typed = "", error?: string) {
  return page({
    title: `Sign in a device to ${mind}`,
    status: error ? 400 : 200,
    body: `<h1>Sign in a device to ${text(mind)}</h1>
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

async function confirm(
  env: Env,
  userCode: string,
  device: DeviceRequest,
  email: string,
  error?: string,
) {
  const mind = configOf(env).controlPlaneHostname;
  const where = [device.requestedFrom.city, device.requestedFrom.country]
    .filter(Boolean)
    .join(", ");
  const ago = Math.max(0, Math.round((Date.now() - device.createdAt) / 1000));
  // Continue has no value of its own: the page's script signs, sets `action` and posts. Decline
  // comes first in the form, so its own value is the one the server reads.
  const form = `${error ? `<p role="alert">${text(error)}</p>` : ""}
      <form method="post" class="actions" data-press="${text(JSON.stringify(pressPayloadOf(userCode, device)))}">
        <input type="hidden" name="user_code" value="${text(userCode)}">
        <button type="submit" name="action" value="decline" class="secondary">Decline</button>
        <button type="submit" data-continue>Continue with passkey</button>
        <input type="hidden" name="action" value="" data-action><input type="hidden" name="signed" value="">
      </form>
      <p id="status" class="muted" role="status">Your passkey signs this request.</p>
      <div class="muted">Signed in as ${text(email)}. Not you? ${otherAccountForm(`${VERIFICATION_PATH}?${new URLSearchParams({ user_code: userCode })}`)}</div>`;
  const shown = {
    mindMark: await mindMarkOf(env),
    status: error ? 403 : 200,
    script: `${signScript(mind)}${PRESS_SCRIPT}`,
  };
  const note = (words: string) => `<span class="note">${text(words)}</span>`;
  const reach = {
    label: "It gets",
    value: `everything in this mind, as <strong>${text(email)}</strong>${note("It can read and change all of it.")}`,
  };
  if (device.letIn) {
    const { signer } = device.letIn;
    const name = signer ? signer.label : device.clientName;
    const proof = signer
      ? `It proved who it is with the key this mind trusts for ${signer.actor} (${signer.key.slice(0, 8)}).`
      : "The name is its own claim: nothing proves who asks. Continue only if you know where this request comes from.";
    return page({
      ...shown,
      title: `Let ${name} in?`,
      asker: deviceTile(name),
      body: `<h1>Let ${text(name)} in?</h1>
      ${factsTable([
        { label: "Who asks", value: `<strong>${text(name)}</strong>${note(proof)}` },
        {
          label: "Its reason",
          value: `<blockquote>${text(device.letIn.reason)}</blockquote>`,
          help: "The asker wrote this. Nobody checked it.",
        },
        { label: "Mind", value: text(mind) },
        reach,
        {
          label: "For",
          value: `${text(durationInWords(device.letIn.seconds))} from your approval${note("It cannot renew this.")}`,
        },
        {
          label: "Code",
          value: `<strong>${text(userCode)}</strong>${note("Continue only if you expected this request.")}`,
        },
      ])}
      ${form}`,
    });
  }
  return page({
    ...shown,
    title: `Sign in ${device.clientName}?`,
    asker: deviceTile(device.clientName),
    body: `<h1>Sign in a device to ${text(mind)}?</h1>
      ${factsTable([
        {
          label: "Device",
          value: `<strong>${text(device.clientName)}</strong>${note("The name is the device's own claim.")}`,
        },
        {
          label: "Asked",
          value: text(`${ago} seconds ago${where ? `, from ${where}` : ""}`),
          help: "The place is where the request came from, by its network address.",
        },
        { label: "It wants", value: text(resourceInWords(env, device.resource)) },
        reach,
        {
          label: "Code",
          value: `<strong>${text(userCode)}</strong>${note("Continue only if you started this sign-in yourself and the device shows this code.")}`,
        },
      ])}
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
    statusSay(status, "Waiting for your passkey…");
    form.signed.value = JSON.stringify(await signedStatement({ type: "${DEVICE_CONFIRMED}", payload: JSON.parse(form.dataset.press) }));
    // by its mark, not by its name: the Decline button has the same name
    form.querySelector("[data-action]").value = "confirm";
    form.submit();
  } catch (error) {
    statusFailed(status, error, "The device is not signed in.");
  }
});`;

function durationInWords(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

function resourceInWords(env: Env, resource: string) {
  const config = configOf(env);
  if (resource === mindMcpUrlOf(config.controlPlaneHostname)) return "the mind's MCP server";
  if (resource === mindProvideConnectResourceOf(config.controlPlaneHostname))
    return "to run the mind from that computer";
  return "the mind's API";
}

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
