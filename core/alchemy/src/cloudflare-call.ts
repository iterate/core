// cloudflare-call.ts — what the destroy's clean-up steps share (telemetry-tables.ts,
// dmarc-record.ts, state-store.ts): one call of Cloudflare's API, and whether a stack is still
// deployed.
import { resourceNamesOf } from "./config.ts";

/** One call of Cloudflare's: the status, and the JSON it answered (null when it was none). */
export type Call = (
  method: string,
  url: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

/** The call that a clean-up script makes with its API token. */
export const callWithToken =
  (token: string): Call =>
  async (method, url, body) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers };
    if (body) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    let answered: unknown = null;
    try {
      answered = JSON.parse(text);
    } catch {
      // an answer with no JSON (a 204) has nothing to read
    }
    return { status: response.status, body: answered };
  };

export const accountUrl = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

/** The first Worker of the stack that is still in the account, or a line that says why that could
 *  not be read. A clean-up step removes nothing while either is there: a stack that is deployed
 *  needs what the step removes. */
export async function stillDeployed(input: { accountId: string; name: string; call: Call }) {
  const names = resourceNamesOf(input.name);
  for (const worker of [names.boundary, names.auth, names.secrets, names.mind, names.telemetry]) {
    const found = await input.call(
      "GET",
      `${accountUrl(input.accountId)}/workers/scripts/${worker}/settings`,
    );
    if (found.status === 404) continue;
    return found.status === 200
      ? { worker }
      : {
          unread: `Cloudflare answered ${found.status} when asked whether the Worker ${worker} exists`,
        };
  }
  return {};
}
