import {
  type Envelope,
  envelopeOf,
  statementHashOf,
  statementOf,
  verifySignature,
} from "iterate/signed";
import type { Verified } from "iterate/workers";
import { configOf, type Env, issuerOf } from "./env.ts";
import { isMember } from "./members.ts";
import { isForThisMind, mindKeyOf } from "./minds.ts";
import { stackKeyOf } from "./stack-key.ts";

const MAX_LIFETIME_MS = 24 * 3600 * 1000;
/** How far a statement's `at` may stand ahead of this Worker's clock. */
const AT_AHEAD_MS = 60 * 1000;

/** The one refusal a key's service acts on: its key waits for a member's consent (./key-tokens.ts). */
export const UNKNOWN_KEY = "the key is not one this mind knows";

export type KnownKey = {
  /** Another mind's: `actor` is its id, `hostname` where its log was read, a label. */
  principal: { actor: string; email?: string; kind?: "mind"; hostname?: string };
  publicKey: string;
  label: string;
  format: Envelope["signature"]["format"];
  paths?: string[]; // none: a person's key, or another mind's
  /** Another mind's: what this Worker writes once a statement signed with the key verified (it
   *  pins a row by hostname, ./minds.ts), or why the statement is refused after all. */
  settle?: () => Promise<string | null>;
  provide?: string; // the capability a service's key may lend (./key-tokens.ts)
  outsider?: boolean; // a passkey added while its owner was no member (../migrations/0016)
};

/** `once: false` takes a statement again. Only the intake asks for it (./statements.ts): the log
 *  keeps its event once, by a key that is the statement's hash. */
export async function verifiedStatement(
  env: Env,
  value: unknown,
  { once = true } = {},
): Promise<
  | (Exclude<Verified, { refused: string }> & {
      paths?: string[];
      provide?: string;
      outsider?: boolean;
    })
  | { refused: string }
> {
  const envelope = envelopeOf(value);
  if (!envelope) return { refused: "not an envelope: { statement, signature }" };
  // The stack's own key signs for others to check, never a statement to this stack.
  if (envelope.signature.key === (await stackKeyOf(env)).key)
    return { refused: "the stack's own key signs for others, not for this stack" };
  const key = (await knownKey(env, envelope.signature.key)) || (await mindKeyOf(env, envelope));
  if (!key) return { refused: UNKNOWN_KEY };
  if ("refused" in key) return key;
  if (key.format !== envelope.signature.format)
    return { refused: `this key signs as ${key.format}` };
  const issuer = issuerOf(env);
  const checked = await verifySignature(envelope, key.publicKey, {
    origin: issuer,
    rpId: new URL(issuer).hostname,
  });
  if ("refused" in checked) return checked;
  const statement = statementOf(envelope.statement);
  if ("refused" in statement) return statement;
  if (!isForThisMind(statement.mind, configOf(env)))
    return { refused: "the statement is for another mind" };
  if (statement.from && key.principal.kind !== "mind")
    return { refused: "a statement from a mind is signed with that mind's key" };
  const now = Date.now();
  if (statement.expires <= now) return { refused: "the statement has expired" };
  if (statement.expires > now + MAX_LIFETIME_MS)
    return { refused: "the statement expires more than a day from now" };
  // A STATEMENT IS DATED BY THIS WORKER'S CLOCK, within a minute ahead and a day behind: the
  // newest rule by `at` decides (./minds.ts `configuredMeld`), so a rule dated in the future
  // would outlive the end that a member signs after it.
  if (statement.at > now + AT_AHEAD_MS)
    return { refused: "the statement is dated more than a minute from now" };
  if (statement.at < now - MAX_LIFETIME_MS)
    return { refused: "the statement is dated more than a day ago" };
  if (once) {
    // a repeat cannot insert, so a statement counts once
    const [, inserted] = await env.DB.batch([
      env.DB.prepare(`delete from statements where expires <= ?1`).bind(now),
      env.DB.prepare(
        `insert into statements (hash, expires) values (?1, ?2) on conflict do nothing`,
      ).bind(await statementHashOf(envelope.statement), statement.expires),
    ]);
    if (!inserted?.meta.changes) return { refused: "the statement was seen before" };
  }
  // last, so that a refused or repeated statement writes nothing here
  const unsettled = await key.settle?.();
  if (unsettled) return { refused: unsettled };
  return {
    signer: {
      principal: key.principal,
      key: envelope.signature.key,
      label: key.label,
      // A service has no email, so it is never a member. A key added while its owner was no
      // member is never a member's, whatever its address is now (../migrations/0016).
      member:
        key.principal.email && !key.outsider ? await isMember(env, key.principal.email) : false,
      userVerified: checked.userVerified,
    },
    statement,
    paths: key.paths,
    provide: key.provide,
    outsider: key.outsider,
  };
}

/** A person's own context, named by the address they signed in with. */
const personContextOf = (email: string) => `/people/${email.toLowerCase()}`;

/** WHY A PERSON'S KEY DOES NOT SIGN THIS, or null. A person's key signs as a member's while its
 *  address is a member and the key was added by a member (`signer.member`, `verifiedStatement`).
 *  Removal of a member takes the members row and leaves the keys, since a session removes no key
 *  (./signed-change.ts), so the row is what ends them. Every other person's key signs at the
 *  intake's `path` only when that is their own context: a removed member's key, on every mind, and
 *  the key of someone who signed in where anyone may. The event says who signed what, and lets
 *  them reach nothing. A passkey that checked nobody is anyone's who holds the device, as at a
 *  sign-in. A service's key has no address: its `paths` and `provide` say what it may do. */
export function personKeyRefusal(
  signer: Exclude<Verified, { refused: string }>["signer"],
  path?: string,
): string | null {
  const { email } = signer.principal;
  if (!email) return null;
  if (!signer.member && path !== personContextOf(email))
    return `${email} is not a member here, so its key signs only at its own context, ${personContextOf(email)}`;
  if (signer.userVerified === false)
    return "the passkey did not check that it is you, by a PIN, a fingerprint or a face";
  return null;
}

async function knownKey(env: Env, id: string): Promise<KnownKey | null> {
  const row = await env.DB.prepare(
    `select k.public_key, k.format, k.label, k.actor, k.paths, k.provide, k.outsider,
       u.id as user_id, u.email
     from keys k left join users u on u.id = k.user_id
     where k.id = ?1 and k.revoked_at is null`,
  )
    .bind(id)
    .first<{
      public_key: string;
      format: string;
      label: string;
      actor: string | null;
      paths: string | null;
      provide: string | null;
      outsider: number;
      user_id: string | null;
      email: string | null;
    }>();
  if (!row || (row.format !== "p256" && row.format !== "webauthn")) return null;
  const common = {
    publicKey: row.public_key,
    label: row.label,
    // one of the two, by the check above, which TypeScript does not narrow a `string` by
    format: row.format as KnownKey["format"],
  };
  if (row.user_id && row.email)
    return {
      ...common,
      principal: { actor: row.user_id, email: row.email },
      outsider: Boolean(row.outsider),
    };
  if (row.actor && row.paths)
    return {
      ...common,
      principal: { actor: row.actor },
      paths: JSON.parse(row.paths) as string[],
      provide: row.provide || undefined,
    };
  return null;
}
