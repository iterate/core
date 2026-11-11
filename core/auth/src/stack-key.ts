// A software key: anyone who can read the account's D1 can read it.
import { codedError } from "iterate/lib";
import {
  base64url,
  type Envelope,
  fromBase64url,
  keyIdOf,
  signedP256,
  statementText,
} from "iterate/signed";
import type { AuthService } from "iterate/workers";
import { type Env, iterateConfigOf } from "./env.ts";

export const STACK_KEY_PATH = "/keys/stack.json";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const DEFAULT_SECONDS = 5 * 60;
const MAX_SECONDS = 24 * 3600;

type StackKey = { key: string; publicKey: string; privateKey: CryptoKey };

const stackKeyByDb = new WeakMap<D1Database, Promise<StackKey>>();

export function stackKeyOf(env: Env): Promise<StackKey> {
  let kept = stackKeyByDb.get(env.DB);
  if (!kept) {
    kept = (async () => {
      const row = (await keptRow(env)) || (await madeRow(env));
      return {
        key: row.key,
        publicKey: row.public_key,
        privateKey: await crypto.subtle.importKey(
          "pkcs8",
          fromBase64url(row.private_key),
          P256,
          false,
          ["sign"],
        ),
      };
    })();
    // a failure is not kept: the next use tries again
    kept.catch(() => stackKeyByDb.delete(env.DB));
    stackKeyByDb.set(env.DB, kept);
  }
  return kept;
}

type StackKeyRow = { key: string; public_key: string; private_key: string };

const keptRow = (env: Env) =>
  env.DB.prepare(
    `select key, public_key, private_key from stack_key where id = 1`,
  ).first<StackKeyRow>();

async function madeRow(env: Env): Promise<StackKeyRow> {
  const pair = (await crypto.subtle.generateKey(P256, true, ["sign", "verify"])) as CryptoKeyPair;
  const exported = async (format: "spki" | "pkcs8", key: CryptoKey) =>
    base64url(new Uint8Array((await crypto.subtle.exportKey(format, key)) as ArrayBuffer));
  const publicKey = await exported("spki", pair.publicKey);
  await env.DB.prepare(
    `insert into stack_key (id, key, public_key, private_key) values (1, ?1, ?2, ?3)
     on conflict do nothing`,
  )
    .bind(await keyIdOf(publicKey), publicKey, await exported("pkcs8", pair.privateKey))
    .run();
  const row = await keptRow(env);
  if (!row) throw new Error("the stack's key was not kept");
  return row;
}

export async function stackKeyResponse(env: Env): Promise<Response> {
  const { key, publicKey } = await stackKeyOf(env);
  return Response.json(
    { project: iterateConfigOf(env).domain, key, publicKey },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

export async function signedByStack(
  env: Env,
  input: Parameters<AuthService["sign"]>[0],
): Promise<Envelope> {
  const { path, type, payload, about, expiresInSeconds = DEFAULT_SECONDS } = input;
  if (!path.startsWith("/"))
    throw codedError("INVALID_INPUT", "a statement's path is a context's path, starting with /");
  if (!type) throw codedError("INVALID_INPUT", "a statement needs a type");
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_SECONDS)
    throw codedError("INVALID_INPUT", "a statement expires between a second and a day ahead");
  const { key, privateKey } = await stackKeyOf(env);
  const at = Date.now();
  const statement = statementText({
    project: iterateConfigOf(env).domain,
    path,
    type,
    payload,
    about,
    at,
    expires: at + expiresInSeconds * 1000,
  });
  return signedP256(statement, privateKey, key);
}
