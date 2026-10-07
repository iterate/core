// The device login's wire (RFC 8628, https://www.rfc-editor.org/rfc/rfc8628): its paths, its codes,
// the forms it reads and the OAuth answers it writes.
import { z } from "zod";

/** The page where the person enters and checks the code (routes/oauth2.device.tsx). */
export const VERIFICATION_PATH = "/oauth2/device";
/** The redirect URI of every device authorization: the platform's own, never the client's. */
export const CALLBACK_PATH = "/oauth2/device/callback";

/** RFC 8628 §6.1's example alphabet: 20 consonants. No vowels, so no words; no digits, so no 0/O or
 *  1/I. Eight characters are 20⁸ ≈ 2.6·10¹⁰ codes (34.6 bits). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** The user code of a device code, `XXXX-XXXX`, from the bytes of its SHA-256 (`hash`, hex): each
 *  byte below 240 is a letter, uniform over the alphabet, since 240 is a multiple of 20. So the
 *  device's poll finds its one row by the user code too (store.ts). Null in the one case in about
 *  10¹⁸ where fewer than eight of the 32 bytes qualify. */
export function userCodeOf(hash: string) {
  const letters = (hash.match(/../g) || [])
    .map((byte) => Number.parseInt(byte, 16))
    .filter((byte) => byte < 240)
    .map((byte) => USER_CODE_ALPHABET[byte % 20])
    .join("")
    .slice(0, 8);
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
}

/** A code as the person typed it: case, spaces and dashes do not matter. Any other character is a
 *  typo, never dropped, so a mistyped code is refused rather than read as another one. */
export function normalizeUserCode(typed: string): string | null {
  const letters = typed.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(letters)) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** The device authorization request (RFC 8628 §3.1) with the PKCE challenge (RFC 7636) this
 *  platform requires beside it: the device code alone redeems nothing. */
export const DeviceAuthorizationForm = z.object({
  client_id: z.string().min(1),
  scope: z.string().default("iterate"),
  resource: z.string().min(1),
  code_challenge: z.string().regex(/^[\w-]{43}$/),
  code_challenge_method: z.literal("S256"),
});

/** A poll of the token endpoint (RFC 8628 §3.4), with the PKCE verifier. */
export const DevicePollForm = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
  device_code: z.string().min(1),
  client_id: z.string().min(1),
  code_verifier: z.string().min(43),
});

/** A form body's fields, read as bytes: workerd logs a warning for `.text()` on a form. */
export async function formOf(request: Request) {
  return Object.fromEntries(
    new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer())),
  );
}

/** An OAuth error answer (RFC 6749 §5.2), never cached. */
export function oauthError(error: string, description: string, status = 400) {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** The device page's query: a code from the device's link or the form, or the callback's outcome.
 *  The route reads it in the browser too, so this module imports nothing of the server's. */
export const DevicePageSearch = z.object({
  user_code: z.string().optional().catch(undefined),
  outcome: z.enum(["approved", "declined", "failed"]).optional().catch(undefined),
});

/** Where the device asked from, as Cloudflare located its request (`request.cf`): the city and
 *  country the page shows, never the IP. Absent in tests and local dev. */
export const RequestedFrom = z
  .object({ city: z.string().optional(), country: z.string().optional() })
  .catch({});
