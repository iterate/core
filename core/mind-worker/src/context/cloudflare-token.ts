// cloudflare-token.ts — THE STACK'S OWN CLOUDFLARE API TOKEN, KEPT IN THE MIND'S VAULT.
//
// A stack whose config says `cloudflareToken: true` makes an API token of its account and binds
// it to the mind Worker (core/alchemy/src/cloudflare-token.ts says what the token may do). The
// mind's code never reads a binding, so this step puts the token where it reaches for a secret:
// `/secrets/cloudflare`, pinned to Cloudflare's API and to Cloudflare's MCP server. The root asks
// for the step once in each of its incarnations (mind/processor.ts), which a deploy starts.
//
// THE STACK'S TOKEN IS KNOWN BY ITS PUBLIC `tokenId`. The step writes only where the path is empty
// or holds such a token: a secret that somebody else put there is theirs, and stays. A token that
// the stack stored goes when the stack has none any more. A member who deletes the secret gets it
// again at the next incarnation: the way to have none is to take the field out of the config.
import type { SecretDescription } from "iterate/workers";

export const CLOUDFLARE_TOKEN_SECRET = "/secrets/cloudflare";
/** Where the token may be sent: Cloudflare's API, and its MCP server, which calls that API. */
const CLOUDFLARE_TOKEN_URLS = ["https://mcp.cloudflare.com", "https://api.cloudflare.com"];

/** The stack's token as the mind Worker is bound to it, when the stack has one. */
export type BoundCloudflareToken = { token: string; tokenId: string };

/** THE EDITION OF THE TOKEN'S LIST THAT THIS RELEASE GIVES (core/alchemy/src/cloudflare-token.ts
 *  `CLOUDFLARE_TOKEN_EDITION`; internal-packages/installer/test/scopes.mjs holds the two equal). */
export const CLOUDFLARE_TOKEN_EDITION = 3;

/** THE MIND HOLDS NO TOKEN OF AN OLDER LIST. The stack's token for the vault, from the mind
 *  Worker's bindings: none when the stack has none, and none when the token is of another
 *  edition than this release's. An older list may do more than this release allows (the list of
 *  13 November 2026 could replace the stack's own Workers), and a deploy whose access may not
 *  change API tokens leaves such a token as it is. It then stays at Cloudflare, bound to this
 *  Worker, and reaches no vault: `keepCloudflareToken` deletes the one that an earlier release
 *  stored. The next deploy that may change API tokens gives the token this release's list. */
export function boundCloudflareTokenOf(env: {
  CLOUDFLARE_TOKEN?: string;
  CLOUDFLARE_TOKEN_ID?: string;
  CLOUDFLARE_TOKEN_EDITION?: string;
}): BoundCloudflareToken | undefined {
  if (!env.CLOUDFLARE_TOKEN || !env.CLOUDFLARE_TOKEN_ID) return undefined;
  if (env.CLOUDFLARE_TOKEN_EDITION !== String(CLOUDFLARE_TOKEN_EDITION)) return undefined;
  return { token: env.CLOUDFLARE_TOKEN, tokenId: env.CLOUDFLARE_TOKEN_ID };
}

export type CloudflareTokenKept = { path: string; outcome: "set" | "deleted" | "unchanged" };

/** The three verbs of the vault that the step uses (context/secrets.ts `secretsRoot`). */
type Vault = {
  describe(path: string): Promise<SecretDescription>;
  set(
    path: string,
    material: BoundCloudflareToken,
    options: { urls: string[]; public: string[] },
  ): Promise<unknown>;
  delete(path: string): Promise<unknown>;
};

export async function keepCloudflareToken(
  vault: Vault,
  bound: BoundCloudflareToken | undefined,
): Promise<CloudflareTokenKept> {
  const path = CLOUDFLARE_TOKEN_SECRET;
  const held = await vault.describe(path);
  const stored = held.set ? held.public?.tokenId : undefined;
  const somebodyElses = held.set && !stored;
  if (somebodyElses || stored === bound?.tokenId) return { path, outcome: "unchanged" };
  if (!bound) {
    await vault.delete(path);
    return { path, outcome: "deleted" };
  }
  await vault.set(path, bound, { urls: CLOUDFLARE_TOKEN_URLS, public: ["tokenId"] });
  return { path, outcome: "set" };
}
