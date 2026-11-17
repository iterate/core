// A software key: anyone who can read the account's D1 can read it.
import { codedError } from "iterate/lib";
import {
  base64url,
  type Envelope,
  fromBase64url,
  isMindDomain,
  keyIdOf,
  type MindDocument,
  signedP256,
  STATEMENTS_PATH,
  statementText,
} from "iterate/signed";
import type { AuthService } from "iterate/workers";
import { type Env, issuerOf, iterateConfigOf } from "./env.ts";
import { canonicalPath } from "./key-rules.ts";

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
    { mind: iterateConfigOf(env).domain, key, publicKey },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

/** THE MIND'S PUBLISHED DOCUMENT (iterate/signed `MindDocument`), here and, through the boundary,
 *  at `https://<domain>/.well-known/iterate`: the stack's key, with which this mind signs as
 *  itself for another mind (`signedByStack` with `mind`). */
export async function mindDocumentResponse(env: Env): Promise<Response> {
  const { key, publicKey } = await stackKeyOf(env);
  const issuer = issuerOf(env);
  return Response.json(
    {
      mind: iterateConfigOf(env).domain,
      issuer,
      statements: `${issuer}${STATEMENTS_PATH}`,
      keys: [{ key, publicKey, label: "mind" }],
    } satisfies MindDocument,
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

/** `mind`: the mind the statement is for, which reads this mind as `from`. Without it the
 *  statement's `mind` is this mind: that names the signer, for the Cloud to read. */
export async function signedByStack(
  env: Env,
  input: Parameters<AuthService["sign"]>[0],
): Promise<Envelope> {
  const { mind, path, type, payload, about, expiresInSeconds = DEFAULT_SECONDS } = input;
  const own = iterateConfigOf(env).domain;
  if (mind && (!isMindDomain(mind) || mind === own))
    throw codedError("INVALID_INPUT", "a statement for another mind names its domain, lowercase");
  if (!path.startsWith("/"))
    throw codedError("INVALID_INPUT", "a statement's path is a context's path, starting with /");
  if (!type) throw codedError("INVALID_INPUT", "a statement needs a type");
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_SECONDS)
    throw codedError("INVALID_INPUT", "a statement expires between a second and a day ahead");
  const { key, privateKey } = await stackKeyOf(env);
  const at = Date.now();
  const statement = statementText({
    ...(mind ? { mind, from: own } : { mind: own }),
    path,
    type,
    payload,
    about,
    at,
    expires: at + expiresInSeconds * 1000,
  });
  return signedP256(statement, privateKey, key);
}

/** `/integrations/<provider>/<account>`, and no segment more or less. A dot segment is refused
 *  beside it (`canonicalPath`): a mind resolves `..`, so one would name another place. */
const DELIVERY_PATH = /^\/integrations\/[^/]+\/[^/]+$/;

/** A PROVIDER'S DELIVERY FOR ANOTHER MIND, signed as this mind: on
 *  `/minds/<this mind>/integrations/<provider>/<account>` and on no other path. `path` is the
 *  last three segments; this writes the first two itself, so a caller cannot name another place.
 *  It is all that the `Deliveries` entrypoint signs (./rpc.ts). */
export async function signedDeliveryByStack(
  env: Env,
  input: {
    mind: string;
    path: string;
    type: string;
    payload?: Record<string, unknown>;
    about?: string[];
    expiresInSeconds?: number;
  },
): Promise<Envelope> {
  const { mind, path, type, payload, about, expiresInSeconds } = input;
  if (!mind) throw codedError("INVALID_INPUT", "a delivery names the mind it is for");
  if (!DELIVERY_PATH.test(path) || !canonicalPath(path))
    throw codedError("INVALID_INPUT", "a delivery's path is /integrations/<provider>/<account>");
  return signedByStack(env, {
    mind,
    path: `/minds/${iterateConfigOf(env).domain}${path}`,
    type,
    payload,
    about,
    expiresInSeconds,
  });
}
