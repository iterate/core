// retired-cloudflare-oauth-client.ts — A STACK'S OWN OAUTH CLIENT AT CLOUDFLARE, AS A ROW OF THE
// STATE TO DROP. A stack's state may hold one private OAuth client of the mind's account, with its
// secret, as a resource of the type `Iterate.CloudflareOAuthClient`. The stack declares no such
// client: a mind connects to Cloudflare through Cloudflare's MCP server, as its own client
// (core/configs/default/cloudflare.ts).
//
// A ROW WITH NO PROVIDER FAILS THE DEPLOY. Alchemy plans a delete for each row that the program no
// longer declares, and dies when no provider is registered for the row's type (alchemy
// src/Plan.ts, `missingProviderError`). So the type keeps this provider, and its delete makes NO
// call: the deploy's credential may not delete OAuth clients (that needs "OAuth Client Write"),
// and a refused call would cost the deploy Cloudflare's retries. The row and the secret in it
// leave the state; the client stays in the account, and the deploy says how to delete it. The
// vault refreshes no grant through it. This file goes once no state holds such a row.
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";

export type RetiredCloudflareOAuthClient = Resource<
  "Iterate.CloudflareOAuthClient",
  { name?: string },
  { clientId?: string | undefined },
  never,
  never
>;
const RetiredCloudflareOAuthClient = Resource<RetiredCloudflareOAuthClient>(
  "Iterate.CloudflareOAuthClient",
);

/** The delete: no call of Cloudflare's API, only the words, and none for a stack that never had
 *  a client (Cloudflare refused to make one). Its effect needs no service at all, so no
 *  credential and no HTTP client can be reached from it. */
export const retiredClientDropped = (input: {
  output: { clientId?: string | undefined };
  olds: { name?: string };
}): Effect.Effect<void> =>
  input.output.clientId
    ? Effect.logWarning(
        `The stack no longer has its own OAuth client at Cloudflare: the mind connects through Cloudflare's MCP server. The client ${input.olds.name || ""} (${input.output.clientId}) stays in the account, and nothing uses it: delete it in Cloudflare's dashboard, under Manage Account, OAuth clients.`,
      )
    : Effect.void;

export const RetiredCloudflareOAuthClientProvider = () =>
  Provider.succeed(RetiredCloudflareOAuthClient, {
    // no program declares the resource: only a row of an earlier deploy can reach this provider
    reconcile: () =>
      Effect.die(
        "Iterate.CloudflareOAuthClient is retired: the stack declares no OAuth client at Cloudflare",
      ),
    delete: retiredClientDropped,
  });
