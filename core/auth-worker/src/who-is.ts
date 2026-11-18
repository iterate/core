// who-is.ts — WHO HOLDS A TOKEN, for one resource: a key's token, or an OAuth access token.
// ./rpc.ts answers the boundary with it, and ./http.ts the members' API.
import type { TokenIdentity } from "iterate/workers";
import type { Env } from "./env.ts";
import { keyTokenIdentity } from "./key-tokens.ts";
import { tokenIdentity } from "./oauth.ts";

export async function whoIs(
  env: Env,
  token: string | null | undefined,
  resource: string | null | undefined,
): Promise<TokenIdentity | null> {
  if (!token || !resource) return null;
  return (
    (await keyTokenIdentity(env, token, resource)) ?? (await tokenIdentity(env, token, resource))
  );
}
