// signed-change.ts — WHO MAY ACT GROWS ONLY BY A SIGNATURE (tasks/signed-events.md). A new member,
// a further passkey and a service's key let more act, so each counts only as a statement a member's
// key signed. A session's cookie and a token add no one. They remove no key either: whoever steals
// a session could else take a member's passkeys away, and with them the member's way in.
import { type Envelope, envelopeOf } from "iterate/signed";
import type { Verified } from "iterate/workers";
import type { Env } from "./env.ts";
import { verifiedStatement } from "./keys.ts";

export const MEMBER_ADDED = "events.iterate.com/account/member-added";
export const KEY_ADDED = "events.iterate.com/account/key-added";
export const KEY_REMOVED = "events.iterate.com/account/key-removed";

export type SignedChange = {
  signer: Exclude<Verified, { refused: string }>["signer"] & { principal: { email: string } };
  payload: Record<string, unknown>;
  envelope: Envelope;
};

/** `value` as a statement of `type` at `/` that a member's key signed. It counts once. */
export async function signedChange(
  env: Env,
  value: unknown,
  type: string,
): Promise<SignedChange | { refused: string }> {
  const envelope = envelopeOf(value);
  if (!envelope) return { refused: "it needs a statement a member's key signed" };
  const verified = await verifiedStatement(env, envelope);
  if ("refused" in verified) return verified;
  const { signer, statement } = verified;
  if (statement.type !== type || statement.path !== "/")
    return { refused: `the statement is not ${type} at /` };
  const { email } = signer.principal;
  if (!signer.member || !email) return { refused: "only a member's key signs this" };
  // as a sign-in asks: a passkey that checked nobody is anyone's who holds the device
  if (signer.userVerified === false)
    return {
      refused: "the passkey did not check that it is you, by a PIN, a fingerprint or a face",
    };
  return {
    signer: { ...signer, principal: { ...signer.principal, email } },
    payload: statement.payload || {},
    envelope,
  };
}

/** `signedChange` of a form's field, which carries the statement's envelope as JSON text, by the
 *  person whose session posts the form. Another member's statement is no press of this person's. */
export async function signedChangeBy(
  env: Env,
  field: unknown,
  type: string,
  email: string,
): Promise<SignedChange | { refused: string }> {
  let value: unknown = null;
  try {
    value = JSON.parse(String(field || ""));
  } catch {
    // no JSON is no statement: `signedChange` says so
  }
  const change = await signedChange(env, value, type);
  if ("refused" in change) return change;
  if (change.signer.principal.email.toLowerCase() !== email.toLowerCase())
    return { refused: "the statement is signed by another person's key" };
  return change;
}

/** What a fact says of the key that signed its change. */
export const signerOf = ({ signer, envelope }: SignedChange) => ({
  signer: { principal: signer.principal, key: signer.key, label: signer.label },
  signed: envelope,
});

/** A page's half: `signedStatement({ type, payload })` asks one of the person's passkeys here to
 *  sign, and answers the envelope. Its bytes must match iterate/signed `signedBytes`. The keys are
 *  read as the page loads, so the passkey is asked for in the press itself. */
export const signScript = (domain: string) => `
const enc = new TextEncoder();
const b64u = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64u = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const passkeys = fetch("/keys.json").then((answer) => (answer.ok ? answer.json() : { keys: [] })).then((answer) => answer.keys.filter((key) => key.credentialId));
async function signedStatement(fields) {
  const keys = await passkeys;
  if (!keys.length) throw new Error("You have no passkey here to sign with.");
  const now = Date.now();
  const statement = JSON.stringify({ mind: ${JSON.stringify(domain)}, path: "/", ...fields, at: now, expires: now + 5 * 60000, nonce: b64u(crypto.getRandomValues(new Uint8Array(16))) });
  const type = "application/vnd.iterate.statement+json";
  const body = enc.encode(statement);
  const head = enc.encode("DSSEv1 " + enc.encode(type).length + " " + type + " " + body.length + " ");
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: await sha256(bytes),
    rpId: location.hostname,
    userVerification: "required",
    allowCredentials: keys.map((key) => ({ type: "public-key", id: unb64u(key.credentialId) })),
  } });
  const key = keys.find((key) => key.credentialId === assertion.id);
  if (!key) throw new Error("That passkey is not one of yours here.");
  const { signature, authenticatorData, clientDataJSON } = assertion.response;
  return { statement, signature: { format: "webauthn", key: key.key, sig: b64u(signature), authenticatorData: b64u(authenticatorData), clientDataJSON: b64u(clientDataJSON) } };
}`;
