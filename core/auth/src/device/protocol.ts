import { z } from "zod";

export const DEVICE_AUTHORIZATION_PATH = "/oauth2/device_authorization";
export const VERIFICATION_PATH = "/oauth2/device";
export const CALLBACK_PATH = "/oauth2/device/callback";
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// RFC 8628 §5.4's advice against a code someone else sent. The CLI waits no longer.
export const DEVICE_CODE_SECONDS = 300;
// RFC 8628 §3.2's default.
export const POLL_INTERVAL_SECONDS = 5;

// RFC 8628 §6.1's example alphabet; eight letters are 34.6 bits. Bytes below 240 only: 240 is a
// multiple of 20, so the letters are uniform.
export function newUserCode() {
  let letters = "";
  while (letters.length < 8)
    for (const byte of crypto.getRandomValues(new Uint8Array(16)))
      if (byte < 240 && letters.length < 8) letters += "BCDFGHJKLMNPQRSTVWXZ"[byte % 20];
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

// Any character but case, spaces and dashes is refused, never dropped: a typo is not another code.
export function normalizeUserCode(typed: string): string | null {
  const letters = typed.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(letters)) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

export const DeviceRegistration = z.object({
  client_name: z.string().trim().min(1).max(200).optional(),
  token_endpoint_auth_method: z.literal("none"),
  grant_types: z.array(z.string()).refine((grants) => grants.includes(DEVICE_CODE_GRANT)),
});

// The library refuses a token with less than a minute left, and the exchange comes after the approval.
export const LET_IN_MIN_SECONDS = 300;
export const LET_IN_MAX_SECONDS = 86400;
export const LET_IN_WAIT_SECONDS = 3600;

export const DeviceAuthorizationForm = z
  .object({
    client_id: z.string().min(1),
    scope: z.string().default("iterate"),
    resource: z.string().min(1),
    access_seconds: z.coerce
      .number()
      .int()
      .min(LET_IN_MIN_SECONDS)
      .max(LET_IN_MAX_SECONDS)
      .optional(),
    reason: z.string().trim().min(1).max(300).optional(),
    signed: z.string().min(1).max(16384).optional(),
  })
  .refine((form) => !form.access_seconds === !form.reason && (!form.signed || !!form.reason));

// Shown with the request, never appended.
export const LET_IN_STATEMENT_TYPE = "events.iterate.com/cloud/let-in-request-signed";

export const DevicePollForm = z.object({
  grant_type: z.literal(DEVICE_CODE_GRANT),
  device_code: z.string().min(1).max(256),
  client_id: z.string().min(1),
});

// Read as bytes: workerd logs a warning for `.text()` on a form.
export async function formOf(request: Request) {
  return Object.fromEntries(
    new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer())),
  );
}

export function oauthError(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export const RequestedFrom = z
  .object({ city: z.string().optional(), country: z.string().optional() })
  .catch({});

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
