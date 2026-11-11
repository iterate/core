import {
  type Envelope,
  envelopeOf,
  keyIdOf,
  statementHashOf,
  statementOf,
  verifySignature,
} from "iterate/signed";
import type { Verified } from "iterate/workers";
import type { AuthConfig } from "./config.ts";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { isMember } from "./members.ts";
import { stackKeyOf } from "./stack-key.ts";

const MAX_LIFETIME_MS = 24 * 3600 * 1000;

type KnownKey = {
  principal: { actor: string; email?: string };
  publicKey: string;
  label: string;
  format?: Envelope["signature"]["format"]; // none for a root key: it may sign in either
  paths?: string[]; // none: any path
};

export async function verifiedStatement(
  env: Env,
  value: unknown,
): Promise<(Exclude<Verified, { refused: string }> & { paths?: string[] }) | { refused: string }> {
  const envelope = envelopeOf(value);
  if (!envelope) return { refused: "not an envelope: { statement, signature }" };
  const config = iterateConfigOf(env);
  // The stack's own key signs for the Cloud to check, never a statement to this stack.
  if (envelope.signature.key === (await stackKeyOf(env)).key)
    return { refused: "the stack's own key signs for others, not for this stack" };
  const key = await knownKey(env, config, envelope.signature.key);
  if (!key) return { refused: "the key is not one this mind knows" };
  if (key.format && key.format !== envelope.signature.format)
    return { refused: `this key signs as ${key.format}` };
  const issuer = issuerOf(env);
  const checked = await verifySignature(envelope, key.publicKey, {
    origin: issuer,
    rpId: new URL(issuer).hostname,
  });
  if ("refused" in checked) return checked;
  const statement = statementOf(envelope.statement);
  if ("refused" in statement) return statement;
  if (statement.mind !== config.domain) return { refused: "the statement is for another mind" };
  const now = Date.now();
  if (statement.expires <= now) return { refused: "the statement has expired" };
  if (statement.expires > now + MAX_LIFETIME_MS)
    return { refused: "the statement expires more than a day from now" };
  // a repeat cannot insert, so a statement counts once
  const [, inserted] = await env.DB.batch([
    env.DB.prepare(`delete from statements where expires <= ?1`).bind(now),
    env.DB.prepare(
      `insert into statements (hash, expires) values (?1, ?2) on conflict do nothing`,
    ).bind(await statementHashOf(envelope.statement), statement.expires),
  ]);
  if (!inserted?.meta.changes) return { refused: "the statement was seen before" };
  return {
    signer: {
      principal: key.principal,
      key: envelope.signature.key,
      label: key.label,
      // a service has no email, so it is never a member
      member: key.principal.email ? await isMember(env, key.principal.email) : false,
      userVerified: checked.userVerified,
    },
    statement,
    paths: key.paths,
  };
}

/** After a mailed code or the upstream proved `user`'s address, which is all they prove. A member
 *  who holds a passkey is refused: mail is no way round a passkey. A member who holds none goes to
 *  /keys to add the first. Anyone else goes on, since a session gives a non-member nothing. */
export async function addressProven(
  env: Env,
  user: { id: string; email: string },
  next: string,
): Promise<{ location: string } | { refused: string }> {
  if (!(await isMember(env, user.email))) return { location: next };
  if (await holdsPasskey(env, user.id))
    return {
      refused: `${user.email} has a passkey for ${iterateConfigOf(env).domain}, so nothing else signs it in. Sign in with the passkey. If it is lost, ask the mind's owner to remove it. The owner gets in again with a deploy.`,
    };
  return {
    location: /^\/keys([/?#]|$)/.test(next) ? next : `/keys?${new URLSearchParams({ next })}`,
  };
}

export async function holdsPasskey(env: Env, userId: string): Promise<boolean> {
  const held = await env.DB.prepare(
    "select 1 from keys where user_id = ?1 and format = 'webauthn' and revoked_at is null limit 1",
  )
    .bind(userId)
    .first();
  return Boolean(held);
}

async function knownKey(env: Env, config: AuthConfig, id: string): Promise<KnownKey | null> {
  const root = (await rootKeysOf(config)).get(id);
  if (root) return root;
  const row = await env.DB.prepare(
    `select k.public_key, k.format, k.label, k.actor, k.paths, u.id as user_id, u.email
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
      user_id: string | null;
      email: string | null;
    }>();
  if (!row || (row.format !== "p256" && row.format !== "webauthn")) return null;
  const common = {
    publicKey: row.public_key,
    label: row.label,
    format: row.format as KnownKey["format"],
  };
  if (row.user_id && row.email)
    return { ...common, principal: { actor: row.user_id, email: row.email } };
  if (row.actor && row.paths)
    return { ...common, principal: { actor: row.actor }, paths: JSON.parse(row.paths) as string[] };
  return null;
}

const rootKeysByConfig = new WeakMap<AuthConfig, Promise<Map<string, KnownKey>>>();

function rootKeysOf(config: AuthConfig): Promise<Map<string, KnownKey>> {
  let keys = rootKeysByConfig.get(config);
  if (!keys) {
    keys = Promise.all(
      (config.keys || []).map(
        async ({ actor, email, publicKey, label, paths }) =>
          [
            await keyIdOf(publicKey),
            { principal: email ? { actor, email } : { actor }, publicKey, label, paths },
          ] as const,
      ),
    ).then((entries) => new Map(entries));
    rootKeysByConfig.set(config, keys);
  }
  return keys;
}
