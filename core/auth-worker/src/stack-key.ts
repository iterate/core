// stack-key.ts — THE STACK'S OWN KEY: the working key with which the mind signs as itself, for
// another mind and for iterate Cloud. ML-DSA-65, as every working key of an identity record is
// (iterate/mind-identity). A software key: anyone who can read the account's D1 can read it. It
// counts only once the mind's identity lists it (`stackKeyIsListed`): until a root key said that
// this is the mind's working key, the mind signs nothing as itself and takes no statement from
// another mind. Until then it is a candidate, which `/keys/stack.json` shows, and the owner's
// command lists it (iterate/cli `postIdentity`).
import { codedError } from "iterate/lib";
import { identityKeyIdOf } from "iterate/mind-identity";
import {
  base64url,
  type Envelope,
  fromBase64url,
  isMindControlPlaneHostname,
  signedMlDsa65,
  type StackKeyDocument,
  statementText,
} from "iterate/signed";
import type { AuthService } from "iterate/workers";
import { configOf, type Env } from "./env.ts";
import { identityOf } from "./identity.ts";
import { canonicalPath } from "./key-rules.ts";

const ML_DSA_65 = { name: "ML-DSA-65" } as const;
/** The formats of an ML-DSA key's raw halves, which Node and workerd take and TypeScript's
 *  library does not list yet. The casts name a format that the library knows; the runtime gets
 *  the string as written. */
const RAW_PUBLIC = "raw-public" as "raw";
const RAW_SEED = "raw-seed" as "raw";
const DEFAULT_SECONDS = 5 * 60;
const MAX_SECONDS = 24 * 3600;

/** `publicKey` is the raw public key, base64url, and `key` its id. `privateKey` signs and cannot
 *  be read. */
type StackKey = { key: string; publicKey: string; privateKey: CryptoKey };

/** Each key that a row of this isolate held, imported, by its id. A row that changes (a new
 *  database under the same binding) is read at the next use, and its key is imported then: the
 *  key that signs is always the current row's. */
const importedById = new Map<string, Promise<CryptoKey>>();

/** THE ONE WAY TO THE STACK'S KEY, and so the one place that knows where it is kept: a row of
 *  D1, made on first use, and read at every use. A binding that holds a key the Worker can use
 *  and not read (`Cloudflare.Workers.SecretKey`) replaces this function and nothing else, once
 *  it is proven with ML-DSA-65 on Cloudflare. */
export async function stackKeyOf(env: Env): Promise<StackKey> {
  const row = (await keptRow(env)) || (await madeRow(env));
  let privateKey = importedById.get(row.key);
  if (!privateKey) {
    privateKey = crypto.subtle.importKey(RAW_SEED, fromBase64url(row.seed), ML_DSA_65, false, [
      "sign",
    ]);
    // a failure is not kept: the next use tries again
    privateKey.catch(() => importedById.delete(row.key));
    importedById.set(row.key, privateKey);
  }
  return { key: row.key, publicKey: row.public_key, privateKey: await privateKey };
}

type StackKeyRow = { key: string; public_key: string; seed: string };

const keptRow = (env: Env) =>
  env.DB.prepare(`select key, public_key, seed from stack_key where id = 1`).first<StackKeyRow>();

async function madeRow(env: Env): Promise<StackKeyRow> {
  // The cast: WebCrypto's types answer a key or a pair for an algorithm they do not know by
  // name. A signature algorithm makes a pair.
  const pair = (await crypto.subtle.generateKey(ML_DSA_65, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // The Workers' types answer bytes or a JSON Web Key for any format: these are bytes.
  const exported = async (format: "raw", key: CryptoKey) =>
    base64url(new Uint8Array((await crypto.subtle.exportKey(format, key)) as ArrayBuffer));
  const publicKey = await exported(RAW_PUBLIC, pair.publicKey);
  await env.DB.prepare(
    `insert into stack_key (id, key, public_key, seed) values (1, ?1, ?2, ?3)
     on conflict do nothing`,
  )
    .bind(await identityKeyIdOf(publicKey), publicKey, await exported(RAW_SEED, pair.privateKey))
    .run();
  const row = await keptRow(env);
  if (!row) throw new Error("the stack's key was not kept");
  return row;
}

/** `GET /keys/stack.json`: the stack's key, and whether the mind's identity lists it. Not kept
 *  by anyone: `listed` changes when a record lists the key. */
export async function stackKeyResponse(env: Env): Promise<Response> {
  const { stack, listed } = await stackKeyListing(env);
  const document: StackKeyDocument = {
    mind: configOf(env).controlPlaneHostname,
    key: stack.key,
    publicKey: stack.publicKey,
    algorithm: "ML-DSA-65",
    listed,
  };
  return Response.json(document, { headers: { "cache-control": "no-store" } });
}

/** WHETHER THE MIND'S IDENTITY LISTS THE STACK'S KEY: the last accepted record of the mind's log
 *  (./identity.ts) has a working key for statements whose public key is this key's. Both are
 *  the raw key as base64url, which has one spelling, so equal keys are equal texts. */
export async function stackKeyIsListed(env: Env): Promise<boolean> {
  return (await stackKeyListing(env)).listed;
}

/** The stack's key as the current row has it, and whether the identity lists THAT key: the
 *  key that passes the gate is the key that signs. */
async function stackKeyListing(env: Env): Promise<{ stack: StackKey; listed: boolean }> {
  const [{ current }, stack] = await Promise.all([identityOf(env), stackKeyOf(env)]);
  const listed = !!current?.workingKeys.some(
    (key) =>
      key.purpose === "statements" &&
      key.algorithm === "ML-DSA-65" &&
      key.publicKey === stack.publicKey,
  );
  return { stack, listed };
}

/** `mind`: the mind the statement is for, which reads this mind as `from`. Without it the
 *  statement's `mind` is this mind: that names the signer. Refused until the mind's identity
 *  lists the stack's key, with an error that has no code: this ends when a record lists the key,
 *  so a subscription that sends to another mind must try again later. A coded refusal such as
 *  FORBIDDEN would halt its row for good (core/itx subscription-delivery.ts). */
export async function signedByStack(
  env: Env,
  input: Parameters<AuthService["sign"]>[0],
): Promise<Envelope> {
  const { mind, path, type, payload, about, expiresInSeconds = DEFAULT_SECONDS } = input;
  const own = configOf(env).controlPlaneHostname;
  const { stack, listed } = await stackKeyListing(env);
  if (!listed)
    throw new Error(
      "the mind's identity lists no working key of this stack yet, so the mind signs nothing as itself",
    );
  if (mind && (!isMindControlPlaneHostname(mind) || mind === own))
    throw codedError("INVALID_INPUT", "a statement for another mind names it, lowercase");
  if (!path.startsWith("/"))
    throw codedError("INVALID_INPUT", "a statement's path is a context's path, starting with /");
  if (!type) throw codedError("INVALID_INPUT", "a statement needs a type");
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_SECONDS)
    throw codedError("INVALID_INPUT", "a statement expires between a second and a day ahead");
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
  return signedMlDsa65(statement, stack.privateKey, stack.key);
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
    path: `/minds/${configOf(env).controlPlaneHostname}${path}`,
    type,
    payload,
    about,
    expiresInSeconds,
  });
}
