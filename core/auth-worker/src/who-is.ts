// who-is.ts — WHO HOLDS A TOKEN, for one resource: a key's token, an OAuth access token, or the
// deploy's stand-in member. ./rpc.ts answers the boundary with it, and ./http.ts the members' API.
import type { TokenIdentity } from "iterate/workers";
import { type Env, iterateConfigOf } from "./env.ts";
import { keyTokenIdentity } from "./key-tokens.ts";
import { tokenIdentity } from "./oauth.ts";

export async function whoIs(
  env: Env,
  token: string | null | undefined,
  resource: string | null | undefined,
): Promise<TokenIdentity | null> {
  if (!token || !resource) return null;
  return (
    (await keyTokenIdentity(env, token, resource)) ??
    (await tokenIdentity(env, token, resource)) ??
    (await prototypeIdentity(env, token, resource))
  );
}

// A stand-in member: the deploy's ITERATE_PROTOTYPE_TOKEN, for any platform resource.
async function prototypeIdentity(
  env: Env,
  token: string,
  resource: string,
): Promise<TokenIdentity | null> {
  const prototypeToken = env.ITERATE_PROTOTYPE_TOKEN;
  if (!prototypeToken || !(await sameSecret(token, prototypeToken))) return null;
  const { domain, resources } = iterateConfigOf(env);
  if (!resources.includes(resource)) return null;
  return {
    principal: { actor: "prototype", email: `prototype@${domain}` },
    grant: "prototype",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    member: true,
  };
}

// Both hashed first: `timingSafeEqual` refuses values of unequal length
// (https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/).
async function sameSecret(given: unknown, secret: string): Promise<boolean> {
  if (typeof given !== "string") return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all(
    [given, secret].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  return crypto.subtle.timingSafeEqual(a!, b!);
}
