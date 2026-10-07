// The device login page's server side (routes/oauth2.device.tsx shows it with page.tsx). Looking a
// code up needs the issuer session, and a person's failed lookups are limited
// (DEVICE_LOGIN_LOOKUP_LIMIT, cloudflare.config.ts), so nobody can probe which codes are waiting.
// Continue confirms the request for the signed-in person, the only one whose consent the callback
// then accepts (index.ts), and opens the consent page.
import { redirect } from "@tanstack/react-router";
import type { z } from "zod";
import { issuerSignIn } from "../consent-page.server.ts";
import type { Env } from "../env.ts";
import { platformAddressesOf } from "../iterate-config.ts";
import { signInHref } from "../login-search.ts";
import {
  CALLBACK_PATH,
  type DevicePageSearch,
  normalizeUserCode,
  VERIFICATION_PATH,
} from "./protocol.ts";
import { deviceStore } from "./store.ts";

export type DevicePageView = Awaited<ReturnType<typeof describeDevicePage>>;

/** What the page shows: how the person answered (the callback's redirect), the code form, or the
 *  waiting device the code names, for the signed-in person to check. */
export async function describeDevicePage(
  request: Request,
  env: Env,
  search: z.infer<typeof DevicePageSearch>,
) {
  if (search.outcome) return { kind: "outcome" as const, outcome: search.outcome };
  if (!search.user_code) return enter();
  const userCode = normalizeUserCode(search.user_code);
  if (!userCode) return enter(search.user_code, "A code is eight letters, like WDJB-MJHT.");
  const signedIn = await issuerSignIn(request, env);
  if (!signedIn) throw redirect({ href: signInHref(pageHref(userCode), null) });
  const found = await waitingRequest(env, signedIn.grant.userId, userCode);
  if (found === "limited") return enter(userCode, "Too many codes tried. Wait a minute.");
  if (!found) return enter(userCode, "No device is waiting for this code. It may have expired.");
  const device = found.request;
  return {
    kind: "confirm" as const,
    email: signedIn.grant.email,
    userCode,
    clientName: device.clientName,
    requestedFrom: device.requestedFrom,
    askedSecondsAgo: Math.max(0, Math.round((Date.now() - device.createdAt) / 1000)),
  };
}

/** `POST /oauth2/device`: the page's Continue (`action=confirm`) or Decline. Like the consent
 *  page's own form (consent-page.server.ts `approveConsentForm`), it wants this page's Origin. */
export async function devicePageFormResponse(request: Request, env: Env) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response("403: a device confirmation needs this page's own Origin\n", {
      status: 403,
    });
  const form = await request.formData().catch(() => null);
  const userCode = normalizeUserCode(String(form?.get("user_code") || ""));
  const action = form?.get("action");
  if (!userCode || (action !== "confirm" && action !== "decline"))
    return new Response("Invalid device form", { status: 400 });
  const signedIn = await issuerSignIn(request, env);
  if (!signedIn) return seeOther(signInHref(pageHref(userCode), null));
  const person = signedIn.grant.userId;
  const found = await waitingRequest(env, person, userCode);
  if (!found || found === "limited") return seeOther(pageHref(userCode));
  const device = found.request;
  const store = deviceStore(env);
  if (action === "decline") {
    const ended = {
      ...device,
      status: "ended" as const,
      error: "access_denied",
      description: "The person declined this sign-in.",
    };
    // another writer won: the page shows the request as it is now
    if (!(await store.swap(found, ended))) return seeOther(pageHref(userCode));
    console.info({ event: "device-login.denied", clientId: device.clientId, error: ended.error });
    return seeOther(`${VERIFICATION_PATH}?outcome=declined`);
  }
  if (device.status === "pending") {
    if (!(await store.swap(found, { ...device, status: "confirmed", confirmedBy: person })))
      return seeOther(pageHref(userCode));
    console.info({ event: "device-login.confirmed", clientId: device.clientId, userId: person });
  }
  // the consent page's request for this device: the platform's callback, `state` the device code's
  // hash, and the device's own client, resource and PKCE challenge
  const { platformOrigin } = platformAddressesOf(env, request);
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: device.clientId,
    redirect_uri: `${platformOrigin}${CALLBACK_PATH}`,
    scope: "iterate",
    state: device.hash,
    code_challenge: device.codeChallenge,
    code_challenge_method: "S256",
    resource: device.resource,
  });
  return seeOther(`/oauth2/auth?${authorize}`);
}

/** The request `userCode` names, if it waits for `person`: unanswered, unexpired, and not
 *  confirmed by someone else. Only a lookup that finds nothing counts against the person's limit,
 *  so opening a link, a stranger's included, never locks them out of their own code. Past the
 *  limit, every lookup is "limited" for a minute: a block row, since the rate limiter has no read
 *  that does not count. */
async function waitingRequest(env: Env, person: string, userCode: string) {
  const store = deviceStore(env);
  if (await store.lookupsBlocked(person)) return "limited" as const;
  const found = await store.byUserCode(userCode);
  const device = found?.request;
  const waits =
    device &&
    device.expiresAt > Date.now() &&
    (device.status === "pending" ||
      (device.status === "confirmed" && device.confirmedBy === person));
  if (found && waits) return found;
  if (!(await env.DEVICE_LOGIN_LOOKUP_LIMIT.limit({ key: person })).success) {
    await store.blockLookups(person, Date.now() + 60_000);
    console.warn({ event: "device-login.rate-limited", limit: "lookup" });
    return "limited" as const;
  }
  return null;
}

const pageHref = (userCode: string) =>
  `${VERIFICATION_PATH}?${new URLSearchParams({ user_code: userCode })}`;

const enter = (typed?: string, error?: string) => ({ kind: "enter" as const, typed, error });

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
