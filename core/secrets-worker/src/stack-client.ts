// stack-client.ts — THE CLIENT THAT IS THE STACK'S OWN, AT CLOUDFLARE: one private OAuth client
// that the mind's deploy made inside the mind's own Cloudflare account (core/alchemy
// src/cloudflare-oauth-client.ts). A member connects the mind to that account through it, with
// one consent on Cloudflare's own page. The sibling of ./cloud-client.ts: there the client is
// iterate Cloud's and its secret stays at the Cloud; here the client is the stack's and its
// secret stays in this Worker's config (./config.ts `cloudflareClient`).
//
// A connect names it as `client: { stack: "cloudflare" }` (iterate/api `StackClientName`), and
// this file says everything else, so the mind's code chooses none of it:
//
//   the client      its id from the config, and its secret at the exchange and at each refresh
//   the endpoints   Cloudflare's two (iterate/api `CLOUDFLARE_OAUTH`)
//   the pin         Cloudflare's API and its MCP server: the token goes nowhere else
//   the scopes      reads alone (iterate/api `CLOUDFLARE_READ_SCOPES`, the list the client is
//                   registered with). A scope outside the list is refused before a person is
//                   sent to consent, and so is any `extra` parameter of the authorize URL.
//   the grant       checked before it is stored (`stackGrantRefusal`): Cloudflare granted only
//                   scopes of the list, and the grant reaches one account, the mind's own.
//
// THE MIND'S CODE NEVER SEES THE CLIENT'S SECRET. The attempt and the secret's record keep the
// client's id and the name `stack`, never the secret: it is read from the config for the one
// request that needs it. The token endpoint is outside the pin, as a Cloud's broker is: the
// code, the refresh token and the client's secret go to it, and the access token never does.
import { CLOUDFLARE_OAUTH, CLOUDFLARE_READ_SCOPES, type StackClientName } from "iterate/api";
import { codedError } from "iterate/lib";
import type { secretsConfigOf } from "./config.ts";

type CloudflareClientConfig = ReturnType<typeof secretsConfigOf>["cloudflareClient"];

/** The stack's client as a connect uses it: the client's id, and the scopes it asks for. */
export type StackClient = { name: StackClientName["stack"]; clientId: string; scope: string };

/** Whether the stack has its client: the deploy made one. */
export const hasCloudflareClient = (held: CloudflareClientConfig) => "clientId" in held;

/** THE STACK'S CLIENT FOR A CONNECT THAT NAMES IT (`client`, as the caller gave it), asking for
 *  `scope`: every scope of the read list when the caller names none. Refused, in words, when the
 *  stack has no client, and when a scope is not in the list. `offline_access` is always asked
 *  for: it brings the refresh token, without which the grant would end within the hour. */
export function stackClientFor(
  held: CloudflareClientConfig,
  client: Record<string, unknown>,
  options: Record<string, unknown>,
): StackClient {
  const { scope, extra } = options;
  // every parameter of the authorize URL is this file's: none may change what is asked for
  if (isAnswer(extra) ? Object.keys(extra).length : extra)
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: a connect through the stack's client at Cloudflare takes no extra parameters",
    );
  // the grant goes to Cloudflare's API and its MCP server as a bearer token, and in no other use
  const uses = ["lendTo", "placement", "operations"].filter((key) => options[key] !== undefined);
  if (uses.length)
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: a grant through the stack's client at Cloudflare has one use, and ${uses.join(", ")} is not for the caller to say`,
    );
  if (scope !== undefined && typeof scope !== "string")
    throw codedError(
      "INVALID_INPUT",
      "secrets.beginOAuth: scope is one string of scopes, separated by spaces",
    );
  if (client.stack !== "cloudflare")
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: client.stack is "cloudflare", the one client of a stack's own, got ${JSON.stringify(client.stack)}`,
    );
  if (!("clientId" in held))
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: this stack has no OAuth client at Cloudflare: its deploy's credential may not make OAuth clients (Cloudflare said: ${held.refusal || "no reason"}). A deploy with an API token that has "OAuth Client Write" makes it. Until then a member makes a client in Cloudflare's dashboard, and a connect names it as clientId and clientSecret.`,
    );
  const read: readonly string[] = CLOUDFLARE_READ_SCOPES;
  const asked = scope ? scope.split(/\s+/).filter(Boolean) : read;
  const outside = asked.filter((each) => !read.includes(each) && each !== "offline_access");
  if (outside.length)
    throw codedError(
      "INVALID_INPUT",
      `secrets.beginOAuth: the stack's client at Cloudflare reads the account and changes nothing: ${outside.join(", ")} is not in its scopes (iterate/api CLOUDFLARE_READ_SCOPES)`,
    );
  return {
    name: "cloudflare",
    clientId: held.clientId,
    scope: [...new Set([...asked, "offline_access"])].join(" "),
  };
}

/** The client's secret, for the code's exchange and for a refresh: read from the config at that
 *  moment, so that neither an attempt nor a secret's record ever holds it. A stack whose client
 *  is gone from the config (a later deploy that could not keep it) cannot refresh, and says so. */
export function stackClientSecretOf(held: CloudflareClientConfig): string {
  if (!("clientId" in held))
    throw new Error(
      "the stack has no OAuth client at Cloudflare any more: connect Cloudflare again",
    );
  return held.clientSecret.exposeSecret();
}

/** Whether `url` is where the stack's client exchanges a code and refreshes a grant: Cloudflare's
 *  token endpoint, exactly. The one address outside a secret's pin that such a request may go to. */
export const isStackTokenEndpoint = (url: string) => url === CLOUDFLARE_OAUTH.tokenEndpoint;

/** What a refusal of a grant tells the person, after the reason. */
const AGAIN =
  "Nothing was kept. Connect again, and on Cloudflare's page select only the account that holds this mind.";

/** THE VAULT'S CHECK OF A GRANT THROUGH THE STACK'S CLIENT, after the code's exchange and before
 *  anything is stored. The words of the refusal, or undefined for a grant that may be kept:
 *    - every scope that Cloudflare says it granted (`granted`, the token answer's `scope`) is in
 *      the read list, or is `offline_access`. With no `scope`, the grant is what was asked
 *      (RFC 6749 §5.1), and that was checked by `stackClientFor`.
 *    - the grant reaches exactly one account, `accountId`, the one that the stack runs in. The
 *      accounts that Cloudflare lists for the new token (`GET /accounts`) are each asked for one
 *      read of the list's own (`d1.metadata_read`): for an OAuth token Cloudflare may list an
 *      account that the consent did not cover, and answers 403 to a read of it (measured for
 *      `GET /memberships`, 18 Nov 2026). Any other answer refuses.
 *  `fetch` sends a request with the new access token; it is used for Cloudflare's API alone. */
export async function stackGrantRefusal(
  granted: string | undefined,
  accountId: string,
  fetch: (path: string) => Promise<Response>,
): Promise<string | undefined> {
  const read: readonly string[] = CLOUDFLARE_READ_SCOPES;
  const outside = (granted || "")
    .split(/[\s,]+/)
    .filter((scope) => scope && scope !== "offline_access" && !read.includes(scope));
  if (outside.length)
    return `Cloudflare granted more than this mind asks for (${outside.join(", ")}). ${AGAIN}`;
  const listed = await fetch("/accounts?per_page=50");
  const answer: unknown = await listed.json().catch(() => null);
  const accounts =
    listed.ok && isAnswer(answer) && Array.isArray(answer.result)
      ? answer.result.flatMap((account: unknown) =>
          isAnswer(account) && typeof account.id === "string" ? [account.id] : [],
        )
      : undefined;
  if (!accounts)
    return `Cloudflare did not say which accounts the consent reaches (it answered ${listed.status}). ${AGAIN}`;
  if (
    isAnswer(answer) &&
    isAnswer(answer.result_info) &&
    Number(answer.result_info.total_pages) > 1
  )
    return `The consent reaches more than 50 accounts. ${AGAIN}`;
  const reached: string[] = [];
  for (const id of accounts) {
    const probe = await fetch(`/accounts/${id}/d1/database?per_page=1`);
    await probe.body?.cancel();
    if (probe.ok) reached.push(id);
    else if (probe.status !== 403)
      return `Cloudflare did not say whether the consent reaches the account ${id} (it answered ${probe.status}). ${AGAIN}`;
  }
  if (reached.length === 1 && reached[0] === accountId) return undefined;
  if (!reached.includes(accountId))
    return `The consent does not reach the Cloudflare account that holds this mind (${accountId}). ${AGAIN}`;
  return `The consent reaches ${reached.length} Cloudflare accounts, and this mind may read only its own (${accountId}). ${AGAIN}`;
}

const isAnswer = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && Boolean(value);
